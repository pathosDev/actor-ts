/**
 * Connection-loss handling for RedisStreamsActor (#742).
 *
 * The actor used to treat every consumer-loop rejection the same way — warn,
 * sleep 500 ms, retry the same dead client — so a Redis outage on the consume
 * path never reached `handleConnectionLost`.  `_state` stayed `'connected'`
 * for the whole outage, which meant the configured `reconnect` backoff, the
 * circuit breaker and the `BrokerDisconnected` health signal were all inert
 * for it, and the consumer group was never re-created after a restart that
 * lost it.
 *
 * The test seam is `RedisStreamsActor.createClient()` — the subclass below
 * hands back a {@link FakeRedisClient} whose lifecycle emits, command
 * rejections and `XGROUP` calls the test drives directly.  That keeps the
 * `ioredis` peer-dependency (which is not a root devDependency, only an
 * optional peer) out of this suite entirely, and it is the only way to
 * observe a *second* client — which is what distinguishes "reconnected" from
 * "remembered".
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import type { ActorSystem } from '../../../../../src/ActorSystem.js';
import { createTestActorSystem } from '../../../../util/TestActorSystem.js';
import { LogLevel, type Logger } from '../../../../../src/Logger.js';
import type { LogContextData } from '../../../../../src/LogContext.js';
import {
  BrokerConnected,
  BrokerDisconnected,
  BrokerReconnectAttempt,
} from '../../../../../src/io/broker/BrokerEvents.js';
import {
  RedisStreamsActor,
  type IoredisClientEvent,
  type IoredisClientLike,
  type RedisStreamEntry,
  type RedisStreamsCommand,
} from '../../../../../src/io/broker/RedisStreamsActor.js';
import { RedisStreamsOptions } from '../../../../../src/io/broker/RedisStreamsOptions.js';
import { REDIS_STREAMS_COMMAND_RETRY_DELAY_MS } from '../../../../../src/io/Constants.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

/**
 * The window in which one *too many* of something shows up.
 *
 * A poll returns on the event that reaches the number it waits for, so on its
 * own it can only confirm the lower half of an exact claim.  Holding still for
 * this long afterwards restores the upper half — which is the whole point of
 * the duplicate-suppression and single-reconnect assertions here.
 */
const SETTLE_MS = 40;

/* ------------------------------- Fakes -------------------------------- */

/** One `XREADGROUP` reply row, in the shape the actor decodes. */
type FakeReadReply = Array<[string, Array<[string, string[]]>]>;

class FakeRedisClient implements IoredisClientLike {
  /** Every `xgroup` invocation, argument list included. */
  readonly xgroupCalls: string[][] = [];
  /** Every `xadd` invocation. */
  readonly xaddCalls: string[][] = [];
  connectCalls = 0;
  quitCalls = 0;
  readCalls = 0;
  /** When set, `connect()` emits it and then rejects with it. */
  connectFailure: Error | null = null;
  /** When set, every `xreadgroup()` rejects with it. */
  readFailure: Error | null = null;
  /** How long an empty `XREADGROUP` pretends to BLOCK before returning null. */
  idleDelayMs = 5;
  private readonly listeners = new Map<IoredisClientEvent, Array<(error?: Error) => void>>();
  private pendingReply: FakeReadReply = [];

  connect(): Promise<void> {
    this.connectCalls++;
    if (this.connectFailure) {
      // Real ioredis reports a refused connection on the `error` event *and*
      // through the rejected `connect()`.  Emitting both is what makes this a
      // regression test for the double-reconnect that arming the listeners
      // too early would produce.
      const failure = this.connectFailure;
      this.emit('error', failure);
      this.emit('close');
      return Promise.reject(failure);
    }
    return Promise.resolve();
  }

  on(event: IoredisClientEvent, listener: (error?: Error) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  async xadd(...args: string[]): Promise<string> {
    this.xaddCalls.push(args);
    return '1-0';
  }

  async xack(): Promise<number> { return 1; }

  async xgroup(...args: string[]): Promise<unknown> {
    this.xgroupCalls.push(args);
    return 'OK';
  }

  async xreadgroup(..._args: string[]): Promise<unknown> {
    this.readCalls++;
    if (this.readFailure) throw this.readFailure;
    if (this.pendingReply.length > 0) {
      const reply = this.pendingReply;
      this.pendingReply = [];
      return reply;
    }
    // Not a test wait: this is the fake standing in for `BLOCK`, and without
    // it an idle loop would spin the event loop flat out.
    await sleep(this.idleDelayMs);
    return null;
  }

  async quit(): Promise<unknown> {
    this.quitCalls++;
    // `quit()` ends the connection, so a real client emits here too — without
    // this the graceful-stop test would pass against an actor that never
    // disarms.
    this.emit('end');
    this.emit('close');
    return 'OK';
  }

  /** Hand the next `xreadgroup()` one entry to deliver. */
  queueEntry(stream: string, id: string, fields: Record<string, string>): void {
    const flat: string[] = [];
    for (const [name, value] of Object.entries(fields)) { flat.push(name, value); }
    this.pendingReply = [[stream, [[id, flat]]]];
  }

  /** Fire a driver lifecycle signal, the way ioredis would. */
  emit(event: IoredisClientEvent, error?: Error): void {
    for (const listener of this.listeners.get(event) ?? []) { listener(error); }
  }

  /** Streams this client was asked to `XGROUP CREATE … MKSTREAM`. */
  get createdGroupStreams(): string[] {
    return this.xgroupCalls.filter((args) => args[0] === 'CREATE').map((args) => args[1] ?? '');
  }
}

/** RedisStreamsActor variant that hands out fakes and counts them. */
class FakeRedisStreamsActor extends RedisStreamsActor {
  readonly clients: FakeRedisClient[] = [];
  /** Applied to every client this actor is about to open. */
  prepareClient: (client: FakeRedisClient) => void = () => {};
  /** True once `preStart` returned — the first connect attempt settled. */
  firstConnectSettled = false;

  override async preStart(): Promise<void> {
    await super.preStart();
    this.firstConnectSettled = true;
  }

  protected override async createClient(_url: string): Promise<IoredisClientLike> {
    const client = new FakeRedisClient();
    this.prepareClient(client);
    this.clients.push(client);
    return client;
  }

  publicConnectionState(): string { return this.connectionState; }

  /**
   * The consumer client of generation `n` (0-based).  Each connect opens the
   * producer first and the consumer second, so the consumers are the odd
   * entries of {@link clients}.
   */
  consumerClient(generation: number): FakeRedisClient {
    const client = this.clients[generation * 2 + 1];
    if (!client) throw new Error(`no consumer client for generation ${generation}`);
    return client;
  }
}

/** Logger that records the WARN records the actor writes. */
class CapturingLogger implements Logger {
  readonly warnings: string[] = [];
  readonly level = LogLevel.Warn;
  debug(): void {}
  info(): void {}
  warn(message: string): void { this.warnings.push(message); }
  error(): void {}
  withSource(_source: string): Logger { return this; }
  withFields(_fields: LogContextData): Logger { return this; }

  /** WARN records naming the consumer loop — the ones #742 is about. */
  get loopWarnings(): string[] {
    return this.warnings.filter((w) => w.includes('consumer loop error'));
  }
}

/* ------------------------------ Helpers ------------------------------- */

class CapturingTarget extends Actor<RedisStreamEntry> {
  readonly received: RedisStreamEntry[] = [];
  override onReceive(entry: RedisStreamEntry): void { this.received.push(entry); }
}

/** Counts one event class as it reaches the event stream. */
function countEvents(system: ActorSystem, eventClass: abstract new (...args: never[]) => object): () => number {
  let count = 0;
  const subscriber = system.spawnAnonymous(() => new (class extends Actor<unknown> {
    override onReceive(_: unknown): void { count++; }
  })());
  system.eventStream.subscribe(subscriber, eventClass as never);
  return () => count;
}

type Booted = {
  readonly ref: ActorRef<RedisStreamsCommand>;
  readonly actor: FakeRedisStreamsActor;
  readonly target: CapturingTarget;
};

const CONSUMED_STREAM = 'orders';

function consumerOptions(): ReturnType<typeof RedisStreamsOptions.create> {
  return RedisStreamsOptions.create()
    .withUrl('redis://fake:6379')
    .withStreams([CONSUMED_STREAM])
    .withConsumerGroup({ group: 'workers', consumer: 'worker-1' })
    .withBlockMs(10)
    .withReconnect({ initialDelayMs: 10, maxDelayMs: 20, factor: 1 });
}

/**
 * Spawn a FakeRedisStreamsActor and wait for its first connect to settle.
 * `beforeStart` runs on the fresh instance before `preStart`, which is how a
 * test makes the very first connect fail.
 */
async function bootActor(
  system: ActorSystem,
  options: ReturnType<typeof RedisStreamsOptions.create>,
  beforeStart: (actor: FakeRedisStreamsActor) => void = () => {},
): Promise<Booted> {
  const target = new CapturingTarget();
  const targetRef = system.spawnAnonymous(
    () => target as unknown as Actor<RedisStreamEntry>,
  ) as ActorRef<RedisStreamEntry>;
  options.withTarget(targetRef);

  let resolveActor!: (actor: FakeRedisStreamsActor) => void;
  const ready = new Promise<FakeRedisStreamsActor>((resolve) => { resolveActor = resolve; });
  const ref = system.spawnAnonymous(() => {
    const actor = new FakeRedisStreamsActor(options);
    beforeStart(actor);
    resolveActor(actor);
    return actor as unknown as Actor<RedisStreamsCommand>;
  });
  const actor = await ready;
  await awaitCondition(() => actor.firstConnectSettled, {
    timeoutMs: 4_000, label: "the actor's first connect attempt settled",
  });
  return { ref: ref as ActorRef<RedisStreamsCommand>, actor, target };
}

/** Wait for a second generation of clients — i.e. the reconnect landed. */
async function awaitReconnect(actor: FakeRedisStreamsActor, generation: number): Promise<void> {
  await awaitCondition(
    () => actor.clients.length >= (generation + 1) * 2 && actor.publicConnectionState() === 'connected',
    { timeoutMs: 4_000, label: `generation ${generation} connected` },
  );
}

/* ====================================================================== */
/* Tests                                                                  */
/* ====================================================================== */

describe('RedisStreamsActor — driver failure signals (#742)', () => {
  test("an ioredis 'error' emit reaches handleConnectionLost and reconnects", async () => {
    const system = createTestActorSystem({ name: 'redis-error-emit' });
    try {
      const disconnected = countEvents(system, BrokerDisconnected);
      const reconnectAttempts = countEvents(system, BrokerReconnectAttempt);
      const { actor } = await bootActor(system, consumerOptions());
      expect(actor.publicConnectionState()).toBe('connected');
      expect(actor.clients).toHaveLength(2);  // producer + consumer

      actor.consumerClient(0).emit('error', new Error('ECONNRESET'));

      await awaitCondition(() => disconnected() >= 1, {
        timeoutMs: 4_000, label: 'BrokerDisconnected reached its subscriber',
      });
      await awaitReconnect(actor, 1);
      // The surplus a per-emit escalation would produce needs a window to
      // show up in; see SETTLE_MS.
      await sleep(SETTLE_MS);
      expect(disconnected()).toBe(1);
      expect(reconnectAttempts()).toBe(1);
      expect(actor.clients).toHaveLength(4);
      // The dead generation was quit, not abandoned.
      expect(actor.clients[0]!.quitCalls).toBe(1);
      expect(actor.clients[1]!.quitCalls).toBe(1);
    } finally {
      await system.terminate();
    }
  });

  test("a straggling emit from the dead client does not abort the reconnect", async () => {
    const system = createTestActorSystem({ name: 'redis-stale-emit' });
    try {
      const disconnected = countEvents(system, BrokerDisconnected);
      const { actor } = await bootActor(system, consumerOptions());
      const dead = actor.consumerClient(0);

      dead.emit('error', new Error('ECONNRESET'));
      await awaitReconnect(actor, 1);
      // ioredis keeps emitting for the length of the outage; the replaced
      // client must be inert once the actor has moved on.
      dead.emit('error', new Error('ECONNREFUSED'));
      dead.emit('close');
      dead.emit('end');
      // The claim is an absence — that those three emits produced nothing —
      // so there is no state to poll; see SETTLE_MS.
      await sleep(SETTLE_MS);

      expect(disconnected()).toBe(1);
      expect(actor.publicConnectionState()).toBe('connected');
      expect(actor.clients).toHaveLength(4);
    } finally {
      await system.terminate();
    }
  });

  test('a graceful stop is not reported as a lost connection', async () => {
    const system = createTestActorSystem({ name: 'redis-graceful-stop' });
    try {
      const disconnected = countEvents(system, BrokerDisconnected);
      const { ref, actor } = await bootActor(system, consumerOptions());

      ref.stop();
      await awaitCondition(() => actor.clients[1]!.quitCalls === 1, {
        timeoutMs: 4_000, label: 'the consumer client was quit on stop',
      });
      // Wiring `end`/`close` into `handleConnectionLost` created a new way for
      // an ordinary shutdown to be announced as an outage, since `quit()` is
      // what makes a real client emit both.  This pins the outcome, not the
      // mechanism: the actor disarms before it quits, *and* `postStop` sets
      // the base class's `_stopped` first — either alone would hold, which is
      // why reordering the disarm does not move this test.
      await sleep(SETTLE_MS);
      expect(disconnected()).toBe(0);
      expect(actor.clients).toHaveLength(2);
    } finally {
      await system.terminate();
    }
  });
});

describe('RedisStreamsActor — consumer-loop failure classification (#742)', () => {
  test('a connection-level rejection leaves the loop and enters the base backoff', async () => {
    const system = createTestActorSystem({ name: 'redis-loop-connection-loss' });
    try {
      const disconnected = countEvents(system, BrokerDisconnected);
      const reconnectAttempts = countEvents(system, BrokerReconnectAttempt);
      const { actor } = await bootActor(system, consumerOptions());
      const failing = actor.consumerClient(0);

      failing.readFailure = new Error('Connection is closed.');

      await awaitCondition(() => disconnected() >= 1, {
        timeoutMs: 4_000, label: 'the loop failure published BrokerDisconnected',
      });
      await awaitReconnect(actor, 1);
      expect(reconnectAttempts()).toBe(1);

      // The old loop is gone: its read count stops moving even though its
      // client would still reject on every call.
      const readsAtHandover = failing.readCalls;
      // The elapsed time *is* the assertion, and it has to outlast the retry
      // delay: a loop that had merely warned and slept would have issued its
      // next read inside this window.
      await sleep(REDIS_STREAMS_COMMAND_RETRY_DELAY_MS * 2);
      expect(failing.readCalls).toBe(readsAtHandover);
      expect(actor.publicConnectionState()).toBe('connected');
    } finally {
      await system.terminate();
    }
  });

  test('the new connection re-creates the consumer group and consumes again', async () => {
    const system = createTestActorSystem({ name: 'redis-group-recreated' });
    try {
      const { actor, target } = await bootActor(system, consumerOptions());
      expect(actor.consumerClient(0).createdGroupStreams).toEqual([CONSUMED_STREAM]);

      // NOGROUP is the shape a Redis restart that lost the dataset produces:
      // the connection is fine, but only a reconnect re-runs the bootstrap.
      actor.consumerClient(0).readFailure = new Error(
        "NOGROUP No such key 'orders' or consumer group 'workers'",
      );
      await awaitReconnect(actor, 1);

      const revived = actor.consumerClient(1);
      expect(revived.createdGroupStreams).toEqual([CONSUMED_STREAM]);
      expect(revived.xgroupCalls[0]).toEqual(['CREATE', CONSUMED_STREAM, 'workers', '$', 'MKSTREAM']);

      revived.queueEntry(CONSUMED_STREAM, '7-0', { sku: 'book-1' });
      await awaitCondition(() => target.received.length >= 1, {
        timeoutMs: 4_000, label: 'the revived loop delivered an entry',
      });
      expect(target.received[0]!.fields).toEqual({ sku: 'book-1' });
    } finally {
      await system.terminate();
    }
  });

  test('a command-level rejection retries on the same connection and warns once', async () => {
    const logger = new CapturingLogger();
    const system = createTestActorSystem({
      name: 'redis-command-error', logger, logLevel: LogLevel.Warn,
    });
    try {
      const disconnected = countEvents(system, BrokerDisconnected);
      const { actor } = await bootActor(system, consumerOptions());
      const client = actor.consumerClient(0);

      client.readFailure = new Error('ERR value is not an integer or out of range');
      const readsAtFailure = client.readCalls;

      // Three retries at REDIS_STREAMS_COMMAND_RETRY_DELAY_MS apart — enough
      // that a per-iteration warn would be plainly visible.
      await awaitCondition(() => client.readCalls >= readsAtFailure + 3, {
        timeoutMs: 4_000, label: 'the loop retried the failing command three times',
      });
      // The claim is that the extra warns are absent, so nothing counts up to
      // poll for; see SETTLE_MS.
      await sleep(SETTLE_MS);

      expect(logger.loopWarnings).toHaveLength(1);
      expect(logger.loopWarnings[0]).toContain('ERR value is not an integer');
      // A command-level failure is not a connection loss: same client, same
      // generation, no reconnect.
      expect(disconnected()).toBe(0);
      expect(actor.clients).toHaveLength(2);
      expect(actor.publicConnectionState()).toBe('connected');
    } finally {
      await system.terminate();
    }
  });

  test('a failure whose message changed is logged immediately', async () => {
    const logger = new CapturingLogger();
    const system = createTestActorSystem({
      name: 'redis-command-error-changed', logger, logLevel: LogLevel.Warn,
    });
    try {
      const { actor } = await bootActor(system, consumerOptions());
      const client = actor.consumerClient(0);

      client.readFailure = new Error('ERR first failure');
      await awaitCondition(() => logger.loopWarnings.length >= 1, {
        timeoutMs: 4_000, label: 'the first command failure was logged',
      });
      // Let two repeats be swallowed before the message changes, so the count
      // the second record carries is a number the test put there.
      const readsAtFirstWarning = client.readCalls;
      await awaitCondition(() => client.readCalls >= readsAtFirstWarning + 2, {
        timeoutMs: 4_000, label: 'two identical failures were suppressed',
      });
      expect(logger.loopWarnings).toHaveLength(1);

      client.readFailure = new Error('ERR second failure');
      await awaitCondition(() => logger.loopWarnings.length >= 2, {
        timeoutMs: 4_000, label: 'the changed message was logged without waiting out the window',
      });

      expect(logger.loopWarnings[0]).toContain('ERR first failure');
      expect(logger.loopWarnings[1]).toContain('ERR second failure');
      // The repeats it stood in for are reported rather than lost.
      expect(logger.loopWarnings[1]).toContain('suppressed');
    } finally {
      await system.terminate();
    }
  });
});

describe('RedisStreamsActor — connect can fail (#742)', () => {
  test('a refused connection does not announce BrokerConnected', async () => {
    const system = createTestActorSystem({ name: 'redis-connect-refused' });
    try {
      const connected = countEvents(system, BrokerConnected);
      const disconnected = countEvents(system, BrokerDisconnected);
      let failuresLeft = 2;  // producer of the first attempt, then its retry
      const { actor } = await bootActor(system, consumerOptions(), (instance) => {
        instance.prepareClient = (client) => {
          if (failuresLeft > 0) {
            failuresLeft--;
            client.connectFailure = new Error('connect ECONNREFUSED 127.0.0.1:6379');
          }
        };
      });

      expect(actor.publicConnectionState()).toBe('disconnected');
      expect(connected()).toBe(0);
      // The failing client emitted `error` *and* rejected `connect()`; only
      // the rejection may count, or the actor schedules two reconnect loops.
      expect(disconnected()).toBe(0);
      // Its socket was released rather than left retrying in the background.
      expect(actor.clients[0]!.quitCalls).toBe(1);

      // The base class's backoff is what recovers it.
      await awaitCondition(() => actor.publicConnectionState() === 'connected', {
        timeoutMs: 4_000, label: 'the configured backoff reconnected',
      });
      expect(connected()).toBe(1);
    } finally {
      await system.terminate();
    }
  });
});
