/**
 * Unit tests for JetStreamActor (#3) — push consumer + ack/nak/term
 * handshake.  Same test-seam pattern as KafkaActor (#2): subclass
 * JetStreamActor and override `createNatsConnection` to inject a
 * pure-JS mock.  Lets us drive the manual-ack pump without involving
 * the real nats.js peer-deps.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import type { LogContextData } from '../../../../../src/LogContext.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { Logger } from '../../../../../src/Logger.js';
import {
  JetStreamActor,
  type JetStreamClientLike,
  type JetStreamCommand,
  type JetStreamManagerLike,
  type JetStreamMessage,
  type JetStreamMessageHandleLike,
  type JetStreamMessageStreamLike,
  type JetStreamModuleLike,
  type NatsConnectionLike,
  type PushConsumerLike,
} from '../../../../../src/io/broker/JetStreamActor.js';
import { JetStreamOptions, JetStreamOptionsBuilder, JetStreamOptionsValidator, type JetStreamOptionsType } from '../../../../../src/io/broker/JetStreamOptions.js';
import { OptionsError } from '../../../../../src/util/OptionsValidator.js';
import { ConfigError } from '../../../../../src/config/Config.js';
import type { ConfigObject } from '../../../../../src/config/HoconParser.js';

import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

/**
 * The window in which one *too many* of something shows up.
 *
 * A poll returns on the arrival that reaches the number it waits for, so it can
 * only confirm the lower half of an exact claim — `toHaveLength(2)`,
 * `toEqual([10, 11, 12, 13, 14])`.  Polling `>=` and then holding still for
 * this long is what restores the upper half.
 */
const SETTLE_MS = 20;

/* --------------------------- Mocks ----------------------------- */

class MockHandle implements JetStreamMessageHandleLike {
  acked = false;
  naked = false;
  termed = false;
  working_called = false;
  nakDelay?: number;
  /**
   * How many times `nak()` was called — not just whether it was.
   *
   * The boolean cannot see a *second* nak on a handle whose delivery was
   * already settled, and that second call is the visible end of an
   * ack-timeout that outlived its own entry: the orphan-timer leak #710's
   * reconnect path left behind fires the shared catch a second time.
   */
  nakCount = 0;

  constructor(
    public readonly subject: string,
    public readonly data: Uint8Array,
    public readonly info: { streamSequence: number; deliverySequence: number; deliveryCount: number; timestampNanos?: number },
    public readonly reply: string | undefined,
    public readonly headers: undefined,
  ) {}

  ack(): void { this.acked = true; }
  nak(delayMs?: number): void { this.naked = true; this.nakCount++; this.nakDelay = delayMs; }
  term(): void { this.termed = true; }
  working(): void { this.working_called = true; }
}

/**
 * Async-iterable subscription mock — the pump drives this via
 * `for await`.  We push handles into it and observe acks via the
 * handle's flags.
 */
class MockSubscription implements JetStreamMessageStreamLike {
  private resolveNext: ((m: IteratorResult<JetStreamMessageHandleLike>) => void) | null = null;
  private buffer: JetStreamMessageHandleLike[] = [];
  destroyed = false;

  push(handle: JetStreamMessageHandleLike): void {
    if (this.resolveNext) {
      const resolveNext = this.resolveNext;
      this.resolveNext = null;
      resolveNext({ value: handle, done: false });
    } else {
      this.buffer.push(handle);
    }
  }

  stop(): void {
    this.destroyed = true;
    if (this.resolveNext) {
      const resolveNext = this.resolveNext;
      this.resolveNext = null;
      resolveNext({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<JetStreamMessageHandleLike> {
    return {
      next: (): Promise<IteratorResult<JetStreamMessageHandleLike>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.destroyed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<JetStreamMessageHandleLike>>((resolveNext) => { this.resolveNext = resolveNext; });
      },
    };
  }
}

class MockPullConsumer {
  /** Queue of message batches to hand out on `fetch()`.  Test pushes via `enqueueBatch`. */
  readonly batches: JetStreamMessageHandleLike[][] = [];
  readonly fetchCalls: Array<{ max_messages: number; expires: number }> = [];

  enqueueBatch(handles: JetStreamMessageHandleLike[]): void {
    this.batches.push(handles);
  }

  async fetch(options: { max_messages: number; expires: number }): Promise<AsyncIterable<JetStreamMessageHandleLike>> {
    this.fetchCalls.push({ max_messages: options.max_messages, expires: options.expires });
    const batch = this.batches.shift() ?? [];
    // Slice the batch to `max_messages` so the test can model "fewer
    // available than asked".
    const delivered = batch.slice(0, options.max_messages);
    return (async function* () { for (const handle of delivered) yield handle; })();
  }
}

class MockJetStream implements JetStreamClientLike {
  readonly published: Array<{
    subject: string; payload: Uint8Array;
    msgID?: string; expectLastSeq?: number; headers?: Record<string, string>;
  }> = [];
  readonly subscription = new MockSubscription();
  /**
   * Which push consumer the actor asked for.  v3 reaches a push consumer
   * through `consumers.getPushConsumer(stream, durable)` rather than
   * `subscribe(subject, { stream, consumer })`, so there is no subject here:
   * the filter now lives on the consumer, which is where the server keeps it.
   */
  readonly pushConsumerCalls: Array<{ stream: string; durable: string }> = [];
  readonly pullConsumers = new Map<string, MockPullConsumer>();

  async publish(subject: string, payload: Uint8Array, options?: {
    msgID?: string; expect?: { lastSequence?: number };
    headers?: Readonly<Record<string, string>>;
  }): Promise<unknown> {
    this.published.push({
      subject, payload,
      msgID: options?.msgID,
      expectLastSeq: options?.expect?.lastSequence,
      headers: options?.headers ? { ...options.headers } : undefined,
    });
    return { seq: this.published.length };
  }

  readonly consumers = {
    get: async (stream: string, durable: string): Promise<MockPullConsumer> => {
      const key = `${stream}::${durable}`;
      let pc = this.pullConsumers.get(key);
      if (!pc) { pc = new MockPullConsumer(); this.pullConsumers.set(key, pc); }
      return pc;
    },
    getPushConsumer: async (stream: string, durable: string): Promise<PushConsumerLike> => {
      this.pushConsumerCalls.push({ stream, durable });
      return { consume: async () => this.subscription };
    },
  };
}

class MockJsm implements JetStreamManagerLike {
  /**
   * The three retention caps are captured, not just the identity fields: they
   * are the only place a test can see that a value survived the validator
   * *and* the mapping into nats.js's snake_case wire names unchanged, which is
   * what a "no limit" sentinel needs proving about it (#871).
   */
  readonly streamsAdd: Array<{
    name: string; subjects: string[];
    max_msgs?: number; max_bytes?: number; max_age?: number;
  }> = [];
  readonly streamsUpdate: Array<{ name: string }> = [];
  readonly consumersAdd: Array<{
    stream: string; durable: string; deliver_policy?: string; ack_wait?: number;
    max_ack_pending?: number; opt_start_seq?: number; opt_start_time?: string;
    filter_subject?: string; deliver_subject?: string;
  }> = [];
  readonly streams = {
    add: async (config: { name: string; subjects: string[]; retention?: string; storage?: string; max_msgs?: number; max_bytes?: number; max_age?: number }) => {
      this.streamsAdd.push({
        name: config.name,
        subjects: [...config.subjects],
        max_msgs: config.max_msgs,
        max_bytes: config.max_bytes,
        max_age: config.max_age,
      });
    },
    update: async (name: string) => {
      this.streamsUpdate.push({ name });
    },
  };
  readonly consumers = {
    add: async (stream: string, config: {
      durable_name: string; ack_policy?: string; ack_wait?: number;
      filter_subject?: string; max_ack_pending?: number;
      deliver_policy?: string; opt_start_seq?: number; opt_start_time?: string;
      deliver_subject?: string;
    }) => {
      this.consumersAdd.push({
        stream,
        durable: config.durable_name,
        deliver_policy: config.deliver_policy,
        ack_wait: config.ack_wait,
        max_ack_pending: config.max_ack_pending,
        opt_start_seq: config.opt_start_seq,
        opt_start_time: config.opt_start_time,
        filter_subject: config.filter_subject,
        deliver_subject: config.deliver_subject,
      });
    },
    update: async (_stream: string, _durable: string) => { /* no-op */ },
  };
}

/**
 * A connection is just a connection in v3 — the JetStream entry points moved
 * to `@nats-io/jetstream` as free functions.  The client and manager the
 * tests assert against therefore hang off this double for convenience, and
 * reach the actor through {@link MockJetStreamActor.jetStreamModule}.
 */
class MockNatsConnection implements NatsConnectionLike {
  readonly js = new MockJetStream();
  readonly jsm = new MockJsm();
  private closedResolve!: (e: Error | undefined) => void;
  private closedPromise = new Promise<Error | undefined>((resolveNext) => { this.closedResolve = resolveNext; });

  async drain(): Promise<void> { this.closedResolve(undefined); }
  closed(): Promise<Error | undefined> { return this.closedPromise; }
}

/**
 * The `@nats-io/jetstream` module, faked.
 *
 * It resolves the client and manager **out of the connection it is handed**
 * rather than out of a captured field, which is what the real free functions
 * do and what a reconnecting actor needs: each connect mints a fresh
 * connection, and its client has to be that connection's.
 */
function mockJetStreamModule(): JetStreamModuleLike {
  return {
    jetstream: (connection): JetStreamClientLike => (connection as MockNatsConnection).js,
    jetstreamManager: async (connection): Promise<JetStreamManagerLike> => (connection as MockNatsConnection).jsm,
  };
}

class MockJetStreamActor extends JetStreamActor {
  readonly mockConnection = new MockNatsConnection();
  protected override async createNatsConnection(): Promise<NatsConnectionLike> {
    return this.mockConnection;
  }

  protected override async jetStreamModule(): Promise<JetStreamModuleLike> {
    return mockJetStreamModule();
  }

  publicConnectionState(): string { return this.connectionState; }

  /**
   * The options as `preStart` resolved them.  `acknowledgmentTimeout` has no
   * observable effect on the driver — it bounds an internal ack wait — so
   * this is the only place a HOCON read of it can be seen.
   */
  publicResolvedOptions(): JetStreamOptionsType { return this.options; }
}

/**
 * A mock whose start refusal is kept for the test to read instead of failing
 * the actor.  `startSettled` is what a case polls, so one that expects a
 * refusal and gets a clean start fails on the assertion naming the
 * difference, not on a timeout.
 */
class StartCapturingJetStreamActor extends MockJetStreamActor {
  startFailure: unknown = null;
  startSettled = false;

  override async preStart(): Promise<void> {
    try {
      await super.preStart();
    } catch (e) {
      this.startFailure = e;
    } finally {
      this.startSettled = true;
    }
  }
}

/* --------------------------- Helpers ---------------------------- */

class CapturingTarget extends Actor<JetStreamMessage> {
  readonly received: JetStreamMessage[] = [];
  override onReceive(m: JetStreamMessage): void { this.received.push(m); }
}

/**
 * Captures the actor's WARN records.
 *
 * Two of the pump's decisions have no observable but the log line they write
 * — a settle command naming a delivery that is no longer in flight, and a
 * `term` that drops a message permanently — and every case in this file used
 * to run with `NoopLogger` at `LogLevel.Off`, so both were invisible.  An
 * explicit logger is taken verbatim by `ActorSystem` (`resolveLogger`), so
 * `level` here is what gates the calls.
 */
class CapturingLogger implements Logger {
  readonly warnings: string[] = [];
  // Annotated rather than inferred, and `debug` takes its parameter even
  // though it drops it: both are what a subclass has to be able to override
  // (see {@link DebugCapturingLogger}), and inferring `LogLevel.Warn` or a
  // zero-parameter `debug` makes that override a `typecheck:dev` error.
  readonly level: LogLevel = LogLevel.Warn;
  debug(_message: string): void {}
  info(): void {}
  warn(message: string): void { this.warnings.push(message); }
  error(): void {}
  withSource(_source: string): Logger { return this; }
  withFields(_fields: LogContextData): Logger { return this; }

  /** WARN records naming a settle command that found no pending entry. */
  get unknownTokenWarnings(): string[] {
    return this.warnings.filter((w) => w.includes('unknown ackToken'));
  }

  /** WARN records naming a permanently dropped message. */
  get terminateWarnings(): string[] {
    return this.warnings.filter((w) => w.includes('message dropped permanently'));
  }

  /**
   * The one aggregate record a disconnect writes, naming how many deliveries
   * were in flight.  Matched on that phrase rather than on "connection lost",
   * which the per-delivery detail line carries too.
   */
  get connectionLostWarnings(): string[] {
    return this.warnings.filter((w) => w.includes('connection lost with'));
  }

  /**
   * Records prefixed twice — `JetStreamActor: pump JetStreamActor: …`.
   *
   * Every catch-path line read that way until #1510: the `Error` messages the
   * ack-timeout and the disconnect built carried the actor prefix already,
   * and the shared catch re-added it.
   */
  get doublyPrefixedWarnings(): string[] {
    return this.warnings.filter((w) => w.includes('JetStreamActor: pump JetStreamActor:'));
  }
}

/**
 * The same capture, opened down to `debug`.
 *
 * Needed wherever a claim is about a line the actor deliberately writes
 * *below* WARN: "the per-delivery detail went to `debug`" is two claims — it
 * is gone from WARN **and** it is still written — and a WARN-only capture can
 * only see the first.  The prefix is the case in point: re-adding
 * `JetStreamActor: ` to the connection-lost message left a WARN-only capture
 * green, because the line it doubles is not a warning any more (#1510).
 *
 * Kept separate rather than merged into {@link CapturingLogger} so the cases
 * that assert an *absence* of warnings keep the narrow gate they were written
 * against.
 */
class DebugCapturingLogger extends CapturingLogger {
  readonly debugs: string[] = [];
  override readonly level = LogLevel.Debug;
  override debug(message: string): void { this.debugs.push(message); }

  /** DEBUG records from the shared catch in `deliverAndAwaitAcknowledgment`. */
  get pumpDebugs(): string[] {
    return this.debugs.filter((d) => d.includes('JetStreamActor: pump '));
  }

  /** DEBUG records prefixed twice — the `debug` half of the same defect. */
  get doublyPrefixedDebugs(): string[] {
    return this.debugs.filter((d) => d.includes('JetStreamActor: pump JetStreamActor:'));
  }
}

/** An `ActorSystem` whose logger is the caller's, at `LogLevel.Warn`. */
function observedSystem(name: string, logger: Logger): ActorSystem {
  return ActorSystem.create(name, ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Warn));
}

/** What {@link bootActorOfKind} needs of a mock subclass to wait for it. */
type BootableJetStreamActor = JetStreamActor & { publicConnectionState(): string };

async function bootActorOfKind<A extends BootableJetStreamActor>(
  sys: ActorSystem, options: JetStreamOptionsBuilder, create: (built: JetStreamOptionsBuilder) => A,
): Promise<{ actor: ActorRef<JetStreamCommand>; mock: A; target: CapturingTarget }> {
  const target = new CapturingTarget();
  const targetRef = sys.spawn(() => target, 'target');
  const ref = { current: null as A | null };
  const actor = sys.spawn(
    () => {
      const mockActor = create(options.withTarget(targetRef));
      ref.current = mockActor;
      return mockActor;
    },
    'js',
  );
  // `connected` is set only after `connectImplementation` returned, and that is
  // where the stream and consumer upserts, the `subscribe` and the pull-consumer
  // handle all happen — so this one condition covers everything the callers read
  // straight after booting.
  await awaitCondition(
    () => ref.current !== null && ref.current.publicConnectionState() === 'connected',
    { timeoutMs: 4_000, label: 'the JetStream actor connected and provisioned its consumer' },
  );
  return { actor: actor as ActorRef<JetStreamCommand>, mock: ref.current!, target };
}

function bootActor(
  sys: ActorSystem, options: JetStreamOptionsBuilder,
): Promise<{ actor: ActorRef<JetStreamCommand>; mock: MockJetStreamActor; target: CapturingTarget }> {
  return bootActorOfKind(sys, options, (built) => new MockJetStreamActor(built));
}

/**
 * Wait until the pump forwarded `count` message(s) to the target.
 *
 * `deliverAndAwaitAcknowledgment` tells the target and registers the pending
 * ack in the same synchronous stretch, and the tell lands in a *later* actor
 * turn — so a message arriving at the target means the pending entry an
 * `acknowledgment` / `negativeAcknowledgment` / `terminate` has to find is
 * already there.  That is what makes this the right thing to wait on before
 * sending one, rather than a proxy for it.
 */
function awaitForwarded(target: CapturingTarget, count: number): Promise<void> {
  return awaitCondition(() => target.received.length >= count, {
    timeoutMs: 4_000,
    label: `${count} message(s) reached the target, so their acks are pending`,
  });
}

function makeHandle(seq: number, subject = 'orders.new', payload = 'hi'): MockHandle {
  return new MockHandle(
    subject,
    new TextEncoder().encode(payload),
    { streamSequence: seq, deliverySequence: seq, deliveryCount: 1, timestampNanos: seq * 1_000_000 },
    undefined,
    undefined,
  );
}

/**
 * A **redelivery** of the message `makeHandle(seq)`: the same
 * `streamSequence`, a bumped `deliverySequence` and `deliveryCount`.  That is
 * exactly what JetStream itself does, and it is the whole premise of #710 —
 * the two handles are two deliveries of one message, indistinguishable by
 * `streamSeq`.
 */
function makeRedelivery(seq: number, deliveryNumber: number, subject = 'orders.new', payload = 'hi'): MockHandle {
  return new MockHandle(
    subject,
    new TextEncoder().encode(payload),
    {
      streamSequence: seq,
      deliverySequence: seq + deliveryNumber,
      deliveryCount: deliveryNumber,
      timestampNanos: seq * 1_000_000,
    },
    undefined,
    undefined,
  );
}

/* ============================================================== */
/* Tests                                                          */
/* ============================================================== */

describe('JetStreamActor — stream + consumer lifecycle', () => {
  test('upserts the stream and consumer at connect time when create=true (default)', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-lifecycle', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'order-proc', ackWaitMs: 5_000 });
      const { mock } = await bootActor(sys, jetstreamOptions);
      expect(mock.mockConnection.jsm.streamsAdd).toHaveLength(1);
      expect(mock.mockConnection.jsm.streamsAdd[0]?.name).toBe('ORDERS');
      expect(mock.mockConnection.jsm.consumersAdd).toHaveLength(1);
      expect(mock.mockConnection.jsm.consumersAdd[0]?.durable).toBe('order-proc');
      // ackWaitMs translates to nanoseconds in the underlying API.
      expect(mock.mockConnection.jsm.consumersAdd[0]?.ack_wait).toBe(5_000_000_000);
      // Subscription wired with stream + durable name.
      expect(mock.mockConnection.js.pushConsumerCalls[0]?.stream).toBe('ORDERS');
      expect(mock.mockConnection.js.pushConsumerCalls[0]?.durable).toBe('order-proc');
    } finally {
      await sys.terminate();
    }
  });

  test('skips upsert when create=false on stream / consumer', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-noupsert', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'EVENTS', subjects: ['events.>'], create: false })
        .withConsumer({ durable: 'd', create: false });
      const { mock } = await bootActor(sys, jetstreamOptions);
      expect(mock.mockConnection.jsm.streamsAdd).toEqual([]);
      expect(mock.mockConnection.jsm.consumersAdd).toEqual([]);
      // Subscribe should still have happened.
      expect(mock.mockConnection.js.pushConsumerCalls).toHaveLength(1);
    } finally {
      await sys.terminate();
    }
  });

  // The kind spells the word out, as nats.js's own `by_start_sequence` does;
  // only the `startSeq` field keeps the short form, after `opt_start_seq`.
  test('by-start-sequence deliverPolicy reaches nats.js as by_start_sequence with its sequence', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-policy', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd', deliverPolicy: { kind: 'by-start-sequence', startSeq: 100 } });
      const { mock } = await bootActor(sys, jetstreamOptions);
      expect(mock.mockConnection.jsm.consumersAdd[0]?.deliver_policy).toBe('by_start_sequence');
      expect(mock.mockConnection.jsm.consumersAdd[0]?.opt_start_seq).toBe(100);
    } finally {
      await sys.terminate();
    }
  });

  test('by-start-time deliverPolicy translates correctly', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-policy-time', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd', deliverPolicy: { kind: 'by-start-time', startTimeMs: 1_767_225_600_000 } });
      const { mock } = await bootActor(sys, jetstreamOptions);
      expect(mock.mockConnection.jsm.consumersAdd[0]?.deliver_policy).toBe('by_start_time');
      expect(mock.mockConnection.jsm.consumersAdd[0]?.opt_start_time).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      await sys.terminate();
    }
  });
});

describe('JetStreamActor — ack/nak/term', () => {
  test('ack acknowledges the handle and resolves the pump', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-ack', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd', ackWaitMs: 5_000 });
      const { actor, mock, target } = await bootActor(sys, jetstreamOptions);
      const handle = makeHandle(42);
      mock.mockConnection.js.subscription.push(handle);
      await awaitForwarded(target, 1);
      await sleep(SETTLE_MS);  // the upper half of "exactly one"; see SETTLE_MS
      expect(target.received).toHaveLength(1);
      expect(target.received[0]!.streamSeq).toBe(42);

      actor.tell({ kind: 'acknowledgment', ackToken: target.received[0]!.ackToken });
      await awaitCondition(() => handle.acked, {
        timeoutMs: 4_000, label: 'the acknowledgment reached the handle',
      });
      expect(handle.acked).toBe(true);
    } finally {
      await sys.terminate();
    }
  });

  test('nak with delayMs forwards the delay to the handle', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-nak', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd' });
      const { actor, mock, target } = await bootActor(sys, jetstreamOptions);
      const handle = makeHandle(7);
      mock.mockConnection.js.subscription.push(handle);
      await awaitForwarded(target, 1);
      actor.tell({
        kind: 'negativeAcknowledgment',
        ackToken: target.received[0]!.ackToken,
        delayMs: 1500,
      });
      // `acked` staying false is an absence, but it shares the one code path
      // with `naked` — so waiting for the nak is what makes it meaningful.
      await awaitCondition(() => handle.naked, {
        timeoutMs: 4_000, label: 'the negative acknowledgment reached the handle',
      });
      expect(handle.naked).toBe(true);
      expect(handle.nakDelay).toBe(1500);
      expect(handle.acked).toBe(false);
    } finally {
      await sys.terminate();
    }
  });

  test('term marks the handle terminated (drop-forever) and says which message it dropped', async () => {
    const logger = new CapturingLogger();
    const sys = observedSystem('js-term', logger);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd' });
      const { actor, mock, target } = await bootActor(sys, jetstreamOptions);
      const handle = makeHandle(99);
      mock.mockConnection.js.subscription.push(handle);
      await awaitForwarded(target, 1);
      actor.tell({
        kind: 'terminate',
        ackToken: target.received[0]!.ackToken,
        reason: 'unparseable',
      });
      await awaitCondition(() => handle.termed, {
        timeoutMs: 4_000, label: 'the terminate reached the handle',
      });
      expect(handle.termed).toBe(true);

      // `term` is the one settle that loses a message for good, so the line it
      // writes is the only record of it — and it names the message by its
      // `streamSeq`, deliberately, not by the `ackToken` the command carried.
      // The token identifies a *delivery* and is minted per actor instance; the
      // stream sequence is what an operator can go and look up in the stream.
      expect(logger.terminateWarnings).toHaveLength(1);
      expect(logger.terminateWarnings[0]).toContain('term for streamSeq=99');
      expect(logger.terminateWarnings[0]).toContain('(unparseable)');
    } finally {
      await sys.terminate();
    }
  });

  test('inProgress calls handle.working() to extend the ack window', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-inprog', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd' });
      const { actor, mock, target } = await bootActor(sys, jetstreamOptions);
      const handle = makeHandle(5);
      mock.mockConnection.js.subscription.push(handle);
      await awaitForwarded(target, 1);
      actor.tell({ kind: 'inProgress', ackToken: target.received[0]!.ackToken });
      await awaitCondition(() => handle.working_called, {
        timeoutMs: 4_000, label: 'the in-progress signal reached the handle',
      });
      await sleep(SETTLE_MS);  // "neither acked nor naked" is an absence
      expect(handle.working_called).toBe(true);
      // The handle is still pending — neither acked nor naked.
      expect(handle.acked).toBe(false);
      expect(handle.naked).toBe(false);
      // Clean up: the pump is parked on this handle's ack, so let it resolve
      // before the system tears the actor down under it.
      actor.tell({ kind: 'acknowledgment', ackToken: target.received[0]!.ackToken });
      await awaitCondition(() => handle.acked, {
        timeoutMs: 4_000, label: 'the cleanup acknowledgment released the pump',
      });
    } finally {
      await sys.terminate();
    }
  });

  test('ack-timeout naks the handle automatically and the pump continues', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-timeout', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd', ackWaitMs: 60 })
        .withAcknowledgmentTimeout(60);
      const { mock, target } = await bootActor(sys, jetstreamOptions);
      const h1 = makeHandle(1);
      mock.mockConnection.js.subscription.push(h1);
      // The 60 ms ack-wait expiring is what naks the handle — poll for the nak
      // rather than for twice the timeout, so a loaded runner cannot make the
      // fixed delay the shorter of the two.
      await awaitCondition(() => h1.naked, {
        timeoutMs: 4_000, label: 'the ack timeout naked the un-acknowledged handle',
      });
      expect(h1.naked).toBe(true);
      // Pump should be free to receive the next message now.
      const h2 = makeHandle(2);
      mock.mockConnection.js.subscription.push(h2);
      await awaitForwarded(target, 2);
      await sleep(SETTLE_MS);  // the upper half of "exactly two"; see SETTLE_MS
      expect(target.received).toHaveLength(2);
      expect(target.received[1]!.streamSeq).toBe(2);
    } finally {
      await sys.terminate();
    }
  });

  test('ackPolicy=none skips the handshake — every message is forwarded immediately, and a defensive settle is not a WARN', async () => {
    // The logger is the second half of this case (#1510).  Under `'none'` the
    // actor still mints an `ackToken` and ships it, but registers nothing
    // against it — so once all four settle handlers report a miss at WARN, a
    // fire-and-hose consumer that acks defensively takes that WARN once per
    // message, at full delivery rate, carrying an explanation ("already timed
    // out, was settled, or predates a reconnect") that is false in this mode.
    const logger = new CapturingLogger();
    const sys = observedSystem('js-none', logger);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd', ackPolicy: 'none' });
      const { actor, mock, target } = await bootActor(sys, jetstreamOptions);
      const h1 = makeHandle(1);
      const h2 = makeHandle(2);
      mock.mockConnection.js.subscription.push(h1);
      mock.mockConnection.js.subscription.push(h2);
      await awaitForwarded(target, 2);
      // Both "not acked" claims are absences; see SETTLE_MS.
      await sleep(SETTLE_MS);
      expect(target.received.map((resolveNext) => resolveNext.streamSeq)).toEqual([1, 2]);
      expect(h1.acked).toBe(false);   // pump didn't call ack
      expect(h2.acked).toBe(false);

      // A defensive consumer settling every mode the same way.
      for (const message of target.received) {
        actor.tell({ kind: 'acknowledgment', ackToken: message.ackToken });
        actor.tell({ kind: 'negativeAcknowledgment', ackToken: message.ackToken });
        actor.tell({ kind: 'terminate', ackToken: message.ackToken, reason: 'defensive' });
        actor.tell({ kind: 'inProgress', ackToken: message.ackToken });
      }
      // "No WARN" is an absence, and the anchor for it is a *later* command
      // whose WARN is unconditional: the mailbox is FIFO, so seeing the
      // push-mode `fetch` refusal means all eight settles above were handled.
      actor.tell({ kind: 'fetch', batch: 1 });
      await awaitCondition(
        () => logger.warnings.some((w) => w.includes('fetch on push-mode')),
        { timeoutMs: 4_000, label: 'the anchor command behind the eight settles was refused' },
      );
      expect(logger.unknownTokenWarnings).toEqual([]);
      // …and `terminate` in particular does not claim a message was dropped:
      // in this mode nothing was tracked, so nothing was dropped.
      expect(logger.terminateWarnings).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('ack for an unknown ackToken is a no-op, and is reported at WARN', async () => {
    // The half of this the test name has always claimed and could not see:
    // it ran with `NoopLogger` at `LogLevel.Off` and asserted `true`, so
    // reverting the line to `log.debug` — which is what let #710 run silently
    // in every default deployment, `debug` being below the `Info` default —
    // left it green.  The level is the point of the line, so the level is what
    // this asserts.
    const logger = new CapturingLogger();
    const sys = observedSystem('js-unknown', logger);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd' });
      const { actor } = await bootActor(sys, jetstreamOptions);
      // No handle pushed, so no pending entry.  Sending ack must not throw.
      actor.tell({ kind: 'acknowledgment', ackToken: 999 });
      await awaitCondition(() => logger.unknownTokenWarnings.length === 1, {
        timeoutMs: 4_000,
        label: 'the unknown-token drop was reported at WARN',
      });
      // The no-throw claim is still an absence, so still needs the settle.
      await sleep(SETTLE_MS);

      expect(logger.unknownTokenWarnings).toHaveLength(1);
      // The token is in the line because it is what an operator correlates
      // against the delivery that carried it.
      expect(logger.unknownTokenWarnings[0]).toContain('ackToken=999');
      // And the consequence is named, not just the event: the message will be
      // redelivered and reprocessed.
      expect(logger.unknownTokenWarnings[0]).toContain('already timed out, was settled, or predates a reconnect');
    } finally {
      await sys.terminate();
    }
  });

  test('the other three settle commands report an unknown ackToken at WARN too, naming themselves', async () => {
    // `onAcknowledgment` was the only handler the #710 fix gave the WARN to;
    // `onNegativeAcknowledgment`, `onTerminate` and `onInProgress` stayed a
    // bare `if (!pendingAck) return;` and dropped the command in total
    // silence — not even at `debug` (#1510).  That matters most on the very
    // migration the fix forced: a caller converting four settle call sites to
    // the delivery-scoped token and missing one gets no signal from three of
    // them, and a dropped `terminate` is the worst of the four — the caller
    // asked for a permanent drop and instead gets the ack-timeout's `nak()`
    // and endless redelivery, which is the silent-reprocessing outcome #710
    // was filed about.
    const logger = new CapturingLogger();
    const sys = observedSystem('js-unknown-settles', logger);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd' });
      const { actor } = await bootActor(sys, jetstreamOptions);
      // No handle pushed, so no pending entry for any of the three.
      actor.tell({ kind: 'negativeAcknowledgment', ackToken: 4242 });
      actor.tell({ kind: 'terminate', ackToken: 4243, reason: 'poison' });
      actor.tell({ kind: 'inProgress', ackToken: 4244 });
      await awaitCondition(() => logger.unknownTokenWarnings.length >= 3, {
        timeoutMs: 4_000,
        label: 'all three unknown-token drops were reported at WARN',
      });
      // The upper half of "exactly three": a later command whose WARN is
      // unconditional, reached through the same FIFO mailbox.
      actor.tell({ kind: 'fetch', batch: 1 });
      await awaitCondition(
        () => logger.warnings.some((w) => w.includes('fetch on push-mode')),
        { timeoutMs: 4_000, label: 'the anchor command behind the three settles was refused' },
      );

      expect(logger.unknownTokenWarnings).toHaveLength(3);
      // Each line names the command that missed, not just "a settle": the
      // three fail in different ways and the caller has to know which of its
      // call sites is the unconverted one.
      expect(logger.unknownTokenWarnings[0])
        .toContain('negativeAcknowledgment for unknown ackToken=4242');
      expect(logger.unknownTokenWarnings[1]).toContain('terminate for unknown ackToken=4243');
      expect(logger.unknownTokenWarnings[2]).toContain('inProgress for unknown ackToken=4244');
      for (const warning of logger.unknownTokenWarnings) {
        expect(warning).toContain('already timed out, was settled, or predates a reconnect');
      }
      // The dropped `terminate` reported a miss, not a drop — no message was
      // permanently discarded, because none was in flight.
      expect(logger.terminateWarnings).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });
});

describe('JetStreamActor — publish', () => {
  test('publish forwards the message + dedupe id + expected-last-seq + headers', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-pub', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222']);
      const { actor, mock } = await bootActor(sys, jetstreamOptions);
      // No consumer — pure producer.
      actor.tell({
        kind: 'publish',
        publish: {
          subject: 'orders.new',
          payload: 'hello',
          messageId: 'abc-123',
          expectedLastSeq: 42,
          headers: { 'X-Tenant': 't1' },
        },
      });
      await awaitCondition(() => mock.mockConnection.js.published.length >= 1, {
        timeoutMs: 4_000, label: 'the publish reached the JetStream client',
      });
      const published = mock.mockConnection.js.published[0];
      expect(published?.subject).toBe('orders.new');
      expect(new TextDecoder().decode(published!.payload)).toBe('hello');
      expect(published?.msgID).toBe('abc-123');
      expect(published?.expectLastSeq).toBe(42);
      expect(published?.headers).toEqual({ 'X-Tenant': 't1' });
    } finally {
      await sys.terminate();
    }
  });
});

describe('JetStreamActor — options parsing', () => {
  test('subscription is wired with the configured stream + durable consumer', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-wiring', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'BILLING', subjects: ['billing.>'] })
        .withConsumer({ durable: 'billing-proc', filterSubject: 'billing.charges' });
      const { mock } = await bootActor(sys, jetstreamOptions);
      const push = mock.mockConnection.js.pushConsumerCalls[0];
      expect(push?.stream).toBe('BILLING');
      expect(push?.durable).toBe('billing-proc');
      // The filter is a property of the consumer, not of the subscription.
      // v2 forwarded it as the subscribe subject; v3 has no subject to
      // forward it to, so the place it has to appear is the consumer config
      // — which is where the server kept it either way.
      expect(mock.mockConnection.jsm.consumersAdd[0]?.filter_subject).toBe('billing.charges');
    } finally {
      await sys.terminate();
    }
  });
});

/* ================== HOCON stream / consumer blocks (#871) ================ */

/**
 * The three fields that had no reader before #871.  Every config here is a
 * **nested** object literal — a dotted top-level key like
 * `{'actor-ts.io.broker.jetstream.stream': …}` stays a literal key in the
 * parsed tree, so `hasPath` would answer from reference.conf and the
 * assertions would pass while proving nothing.
 */
describe('JetStreamActor — HOCON stream / consumer / acknowledgment-timeout (#871)', () => {
  function systemWith(name: string, jetstream: ConfigObject): ActorSystem {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { io: { broker: { jetstream } } } });
    return ActorSystem.create(name, sysOptions);
  }

  test('the stream and consumer blocks feed the options and reach the manager', async () => {
    const sys = systemWith('js-hocon-blocks', {
      servers: ['nats://fake:4222'],
      'acknowledgment-timeout': '45s',
      stream: {
        name: 'BILLING',
        subjects: ['billing.>'],
        retention: 'workqueue',
        storage: 'memory',
        'max-messages': 1000,
        'max-bytes': '8M',
        'max-age': 3_600_000_000_000,
        create: true,
      },
      consumer: {
        durable: 'billing-proc',
        mode: 'push',
        'deliver-policy': 'last',
        'ack-policy': 'explicit',
        'ack-wait': '10s',
        'filter-subject': 'billing.charges',
        'max-acknowledgment-pending': 64,
        create: true,
      },
    });
    try {
      const { mock } = await bootActor(sys, JetStreamOptions.create());
      const resolved = mock.publicResolvedOptions();
      expect(resolved.stream).toEqual({
        name: 'BILLING',
        subjects: ['billing.>'],
        retention: 'workqueue',
        storage: 'memory',
        maxMessages: 1000,
        maxBytes: 8 * 1024 * 1024,
        maxAge: 3_600_000_000_000,
        create: true,
      });
      expect(resolved.consumer).toEqual({
        durable: 'billing-proc',
        mode: 'push',
        deliverPolicy: 'last',
        ackPolicy: 'explicit',
        ackWaitMs: 10_000,
        filterSubject: 'billing.charges',
        maxAcknowledgmentPending: 64,
        create: true,
      });
      // `45s` is a duration string, so getDuration is the reader that has to
      // be behind it — a getNumber would have thrown on this value.
      expect(resolved.acknowledgmentTimeout).toBe(45_000);
      // …and it is not only an options object: the manager was asked for it.
      expect(mock.mockConnection.jsm.streamsAdd[0]).toEqual({
        name: 'BILLING',
        subjects: ['billing.>'],
        max_msgs: 1000,
        max_bytes: 8 * 1024 * 1024,
        max_age: 3_600_000_000_000,
      });
      expect(mock.mockConnection.jsm.consumersAdd[0]?.deliver_policy).toBe('last');
      expect(mock.mockConnection.jsm.consumersAdd[0]?.ack_wait).toBe(10_000 * 1_000_000);
    } finally {
      await sys.terminate();
    }
  });

  test('the deliver-policy object arm survives the round trip', async () => {
    const sys = systemWith('js-hocon-deliver-policy', {
      servers: ['nats://fake:4222'],
      stream: { name: 'BILLING', subjects: ['billing.>'] },
      consumer: {
        durable: 'billing-proc',
        // The `kind` keeps its TypeScript spelling as a *value*, so it lands
        // in the union unchanged — and that spelling is kebab-case (#1443),
        // like every value a HOCON key takes.
        'deliver-policy': { kind: 'by-start-sequence', 'start-seq': 4242 },
      },
    });
    try {
      const { mock } = await bootActor(sys, JetStreamOptions.create());
      expect(mock.publicResolvedOptions().consumer?.deliverPolicy)
        .toEqual({ kind: 'by-start-sequence', startSeq: 4242 });
      const added = mock.mockConnection.jsm.consumersAdd[0];
      expect(added?.deliver_policy).toBe('by_start_sequence');
      expect(added?.opt_start_seq).toBe(4242);
    } finally {
      await sys.terminate();
    }
  });

  test('the by-start-time arm survives the round trip too', async () => {
    const sys = systemWith('js-hocon-deliver-policy-time', {
      servers: ['nats://fake:4222'],
      stream: { name: 'BILLING', subjects: ['billing.>'] },
      consumer: {
        durable: 'billing-proc',
        'deliver-policy': { kind: 'by-start-time', 'start-time': 1_767_225_600_000 },
      },
    });
    try {
      const { mock } = await bootActor(sys, JetStreamOptions.create());
      expect(mock.publicResolvedOptions().consumer?.deliverPolicy)
        .toEqual({ kind: 'by-start-time', startTimeMs: 1_767_225_600_000 });
      const added = mock.mockConnection.jsm.consumersAdd[0];
      expect(added?.deliver_policy).toBe('by_start_time');
      expect(added?.opt_start_time).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      await sys.terminate();
    }
  });

  // A retired spelling is refused by name rather than read: translating it
  // would be a second spelling accepted for good, and the generic unknown-kind
  // error lists both object forms without saying which one replaced it.
  test.each([
    { retired: 'byStartSeq', replacement: 'by-start-sequence', leaf: 'start-seq', value: 4242 },
    { retired: 'byStartTime', replacement: 'by-start-time', leaf: 'start-time', value: 1_767_225_600_000 },
  ])('the retired kind $retired is refused at startup, naming $replacement', async (row) => {
    const sys = systemWith(`js-hocon-retired-${row.retired}`, {
      servers: ['nats://fake:4222'],
      stream: { name: 'BILLING', subjects: ['billing.>'] },
      consumer: {
        durable: 'billing-proc',
        'deliver-policy': { kind: row.retired, [row.leaf]: row.value },
      },
    });
    try {
      const actor = new StartCapturingJetStreamActor(JetStreamOptions.create());
      sys.spawn(() => actor, 'js');
      await awaitCondition(() => actor.startSettled, {
        timeoutMs: 4_000, label: "the actor's preStart settled",
      });

      expect(actor.startFailure).toBeInstanceOf(ConfigError);
      const message = (actor.startFailure as ConfigError).message;
      expect(message).toContain(row.retired);
      expect(message).toContain(row.replacement);
      expect(message).toMatch(/renamed/);
      // Refused before a consumer was ever provisioned.
      expect(actor.mockConnection.jsm.consumersAdd).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  // Falling back to `all` instead would replay the whole stream on a typo.
  test('an unknown kind is refused at startup, listing the kinds that exist', async () => {
    const sys = systemWith('js-hocon-unknown-kind', {
      servers: ['nats://fake:4222'],
      stream: { name: 'BILLING', subjects: ['billing.>'] },
      consumer: { durable: 'billing-proc', 'deliver-policy': { kind: 'from-the-top' } },
    });
    try {
      const actor = new StartCapturingJetStreamActor(JetStreamOptions.create());
      sys.spawn(() => actor, 'js');
      await awaitCondition(() => actor.startSettled, {
        timeoutMs: 4_000, label: "the actor's preStart settled",
      });

      expect(actor.startFailure).toBeInstanceOf(ConfigError);
      const message = (actor.startFailure as ConfigError).message;
      expect(message).toContain('from-the-top');
      expect(message).toContain('kind = "by-start-sequence"');
      expect(message).toContain('kind = "by-start-time"');
      expect(message).not.toMatch(/byStart/);
      expect(actor.mockConnection.jsm.consumersAdd).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  // A kind is matched whole, so no shortening of one is read as it.  That
  // covers the abbreviated sequence kind the spelled-out one replaced before
  // any release: having never shipped, it has no entry among the retired
  // kinds either, and is refused as the unknown kind it is.  Both start leaves
  // are supplied, so a reader that did accept a shortening could build the
  // object and would start cleanly rather than fail on a missing leaf.
  const shortenedKinds = ['by-start-sequence', 'by-start-time'].flatMap((kind) => {
    const sharedStem = 'by-start-'.length;
    return Array.from(
      { length: kind.length - sharedStem - 1 },
      (_, index) => kind.slice(0, sharedStem + 1 + index),
    );
  });

  test.each(shortenedKinds)('the shortened kind %s is refused as unknown, not read as a kind', async (shortened) => {
    const sys = systemWith(`js-hocon-shortened-${shortened}`, {
      servers: ['nats://fake:4222'],
      stream: { name: 'BILLING', subjects: ['billing.>'] },
      consumer: {
        durable: 'billing-proc',
        'deliver-policy': { kind: shortened, 'start-seq': 4242, 'start-time': 1_767_225_600_000 },
      },
    });
    try {
      const actor = new StartCapturingJetStreamActor(JetStreamOptions.create());
      sys.spawn(() => actor, 'js');
      await awaitCondition(() => actor.startSettled, {
        timeoutMs: 4_000, label: "the actor's preStart settled",
      });

      expect(actor.startFailure).toBeInstanceOf(ConfigError);
      expect((actor.startFailure as ConfigError).message)
        .toContain(`'${shortened}' is not a delivery policy`);
      expect(actor.mockConnection.jsm.consumersAdd).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('the shortened kinds include every truncation of both kinds', () => {
    // Pins the generator above, which would otherwise pass vacuously on an
    // empty list.
    expect(shortenedKinds).toHaveLength(10);
    expect(shortenedKinds).toContain('by-start-s');
    expect(shortenedKinds).toContain('by-start-sequenc');
    expect(shortenedKinds).toContain('by-start-tim');
  });

  test('a builder stream block still wins over the HOCON one', async () => {
    const sys = systemWith('js-hocon-precedence', {
      servers: ['nats://fake:4222'],
      stream: { name: 'FROM-HOCON', subjects: ['hocon.>'] },
      consumer: { durable: 'from-hocon' },
    });
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withStream({ name: 'FROM-BUILDER', subjects: ['builder.>'] });
      const { mock } = await bootActor(sys, jetstreamOptions);
      expect(mock.publicResolvedOptions().stream?.name).toBe('FROM-BUILDER');
      // The consumer the builder left unset still falls through to HOCON.
      expect(mock.publicResolvedOptions().consumer?.durable).toBe('from-hocon');
    } finally {
      await sys.terminate();
    }
  });
});

describe('JetStreamOptionsValidator — the stream / consumer group rules (#871)', () => {
  const validate = (s: Partial<JetStreamOptionsType>): void =>
    new JetStreamOptionsValidator().validate(s);

  test('rejects a stream with no name — the shape an incomplete HOCON block reads as', () => {
    expect(() => validate({ stream: { name: '', subjects: ['a.>'] } })).toThrow(/stream\.name/);
  });

  test('rejects a stream with no subjects', () => {
    expect(() => validate({ stream: { name: 'S', subjects: [] } })).toThrow(/stream\.subjects/);
  });

  test('rejects an unknown retention and an unknown storage', () => {
    expect(() => validate({ stream: { name: 'S', subjects: ['a'], retention: 'forever' as 'limits' } }))
      .toThrow(/stream\.retention/);
    expect(() => validate({ stream: { name: 'S', subjects: ['a'], storage: 'tape' as 'file' } }))
      .toThrow(/stream\.storage/);
  });

  test('rejects a consumer with no durable name', () => {
    expect(() => validate({ consumer: { durable: '' } })).toThrow(/consumer\.durable/);
  });

  test('rejects an unknown deliverPolicy string, and accepts the object arm', () => {
    expect(() => validate({ consumer: { durable: 'd', deliverPolicy: 'yesterday' as 'all' } }))
      .toThrow(/consumer\.deliverPolicy/);
    expect(() => validate({ consumer: { durable: 'd', deliverPolicy: { kind: 'by-start-sequence', startSeq: 1 } } }))
      .not.toThrow();
  });

  test('rejects a non-positive ackWaitMs', () => {
    expect(() => validate({ consumer: { durable: 'd', ackWaitMs: 0 } })).toThrow(OptionsError);
  });

  test('an unset group passes', () => {
    expect(() => validate({ servers: ['nats://h:4222'] })).not.toThrow();
  });
});

/*
 * NATS spells "no limit" out of band on four of the five bounded leaves, and
 * those spellings are non-positive numbers — so a plain positive bound refuses
 * a configuration the server documents.  The values are per field, not
 * symmetric: `max_msgs`, `max_bytes` and `max_ack_pending` take `-1`, while
 * `max_age` takes `0` (it is a nanosecond span, and a negative one has no
 * meaning).  `ack_wait` has no unlimited spelling at all — a zero there means
 * "use the server default", which `undefined` already says here — so it keeps
 * the plain positive bound and is asserted below as the deliberate asymmetry.
 */
describe('JetStreamOptionsValidator — the NATS "unlimited" sentinels', () => {
  const validate = (s: Partial<JetStreamOptionsType>): void =>
    new JetStreamOptionsValidator().validate(s);
  const stream = (
    limits: Partial<Pick<NonNullable<JetStreamOptionsType['stream']>, 'maxMessages' | 'maxBytes' | 'maxAge'>>,
  ): Partial<JetStreamOptionsType> => ({ stream: { name: 'S', subjects: ['a.>'], ...limits } });

  test('accepts -1 on the two count/byte caps and 0 on the age cap', () => {
    expect(() => validate(stream({ maxMessages: -1 }))).not.toThrow();
    expect(() => validate(stream({ maxBytes: -1 }))).not.toThrow();
    expect(() => validate(stream({ maxAge: 0 }))).not.toThrow();
    expect(() => validate({ consumer: { durable: 'd', maxAcknowledgmentPending: -1 } })).not.toThrow();
  });

  test('refuses a non-positive value that is not that field\'s sentinel', () => {
    // -2 is not a spelling of anything on any of them.
    expect(() => validate(stream({ maxMessages: -2 }))).toThrow(/stream\.maxMessages/);
    expect(() => validate(stream({ maxBytes: -2 }))).toThrow(/stream\.maxBytes/);
    expect(() => validate(stream({ maxAge: -2 }))).toThrow(/stream\.maxAge/);
    expect(() => validate({ consumer: { durable: 'd', maxAcknowledgmentPending: -2 } }))
      .toThrow(/consumer\.maxAcknowledgmentPending/);
    // The sentinel is per field: 0 is unlimited only on the age cap, and -1
    // only on the other three.
    expect(() => validate(stream({ maxMessages: 0 }))).toThrow(/stream\.maxMessages/);
    expect(() => validate(stream({ maxBytes: 0 }))).toThrow(/stream\.maxBytes/);
    expect(() => validate(stream({ maxAge: -1 }))).toThrow(/stream\.maxAge/);
    expect(() => validate({ consumer: { durable: 'd', maxAcknowledgmentPending: 0 } }))
      .toThrow(/consumer\.maxAcknowledgmentPending/);
  });

  test('consumer.ackWaitMs has no sentinel — 0 and -1 both stay refused', () => {
    expect(() => validate({ consumer: { durable: 'd', ackWaitMs: 0 } })).toThrow(/consumer\.ackWaitMs/);
    expect(() => validate({ consumer: { durable: 'd', ackWaitMs: -1 } })).toThrow(/consumer\.ackWaitMs/);
  });

  test('a sentinel reaches the manager verbatim rather than being normalised', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-unlimited', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'UNBOUNDED', subjects: ['u.>'], maxMessages: -1, maxBytes: -1, maxAge: 0 })
        .withConsumer({ durable: 'u-proc', maxAcknowledgmentPending: -1 });
      const { mock } = await bootActor(sys, jetstreamOptions);
      expect(mock.mockConnection.jsm.streamsAdd[0]).toEqual({
        name: 'UNBOUNDED', subjects: ['u.>'], max_msgs: -1, max_bytes: -1, max_age: 0,
      });
      expect(mock.mockConnection.jsm.consumersAdd[0]?.max_ack_pending).toBe(-1);
    } finally {
      await sys.terminate();
    }
  });

  test('the sentinels survive the HOCON round trip too', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          io: {
            broker: {
              jetstream: {
                servers: ['nats://fake:4222'],
                stream: {
                  name: 'UNBOUNDED', subjects: ['u.>'],
                  'max-messages': -1, 'max-bytes': -1, 'max-age': 0,
                },
                consumer: { durable: 'u-proc', 'max-acknowledgment-pending': -1 },
              },
            },
          },
        },
      });
    const sys = ActorSystem.create('js-unlimited-hocon', sysOptions);
    try {
      const { mock } = await bootActor(sys, JetStreamOptions.create());
      const resolved = mock.publicResolvedOptions();
      expect(resolved.stream?.maxMessages).toBe(-1);
      expect(resolved.stream?.maxBytes).toBe(-1);
      expect(resolved.stream?.maxAge).toBe(0);
      expect(resolved.consumer?.maxAcknowledgmentPending).toBe(-1);
    } finally {
      await sys.terminate();
    }
  });
});

/* ====================== Pull-consumer mode (#62) ======================== */

describe('JetStreamActor — pull-consumer mode (#62)', () => {
  test('mode=pull skips the subscription and grabs a pull-consumer handle', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-pull-setup', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'puller', mode: 'pull' });
      const { mock } = await bootActor(sys, jetstreamOptions);
      // No push consumer — pull mode is on-demand.
      expect(mock.mockConnection.js.pushConsumerCalls).toHaveLength(0);
      // And the consumer it created carries no deliver subject, which is what
      // makes it a pull consumer server-side.
      expect(mock.mockConnection.jsm.consumersAdd[0]?.deliver_subject).toBeUndefined();
      // Pull-consumer handle materialised for ORDERS::puller.
      expect(mock.mockConnection.js.pullConsumers.size).toBe(1);
      expect(mock.mockConnection.js.pullConsumers.has('ORDERS::puller')).toBe(true);
    } finally {
      await sys.terminate();
    }
  });

  test('fetch delivers messages and waits for ack before returning', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-pull-fetch', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'puller', mode: 'pull', ackWaitMs: 1_000 });
      const { actor, mock, target } = await bootActor(sys, jetstreamOptions);
      const pc = mock.mockConnection.js.pullConsumers.get('ORDERS::puller')!;
      pc.enqueueBatch([makeHandle(1), makeHandle(2), makeHandle(3)]);

      actor.tell({ kind: 'fetch', batch: 3, expiresMs: 1_000 });
      await awaitForwarded(target, 3);
      // Both assertions below are exact — one fetch call, three sequences and
      // no fourth; see SETTLE_MS.
      await sleep(SETTLE_MS);

      // All three messages delivered to target before any ack.
      expect(target.received.map((m) => m.streamSeq).sort()).toEqual([1, 2, 3]);
      // Fetch was called with the requested parameters.
      expect(pc.fetchCalls).toEqual([{ max_messages: 3, expires: 1_000 }]);

      // Acknowledgment them all so the pending-map drains.  The batch handles
      // are constructed inline, so there is nothing to poll here — this is a
      // drain before teardown, not a wait before an assertion.
      for (const message of target.received) {
        actor.tell({ kind: 'acknowledgment', ackToken: message.ackToken });
      }
      await sleep(30);  // drain before teardown, per the comment above
    } finally {
      await sys.terminate();
    }
  });

  test('expires-without-messages returns cleanly (empty batch is not an error)', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-pull-empty', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'puller', mode: 'pull' });
      const { actor, mock, target } = await bootActor(sys, jetstreamOptions);
      const pc = mock.mockConnection.js.pullConsumers.get('ORDERS::puller')!;
      // No batch enqueued — fetch yields an empty iterator immediately.

      actor.tell({ kind: 'fetch', batch: 10, expiresMs: 100 });
      // "no messages" is an absence, so waiting for the *fetch call* is what
      // makes it mean anything: an empty target could otherwise equally mean
      // the fetch had not been issued yet.
      await awaitCondition(() => pc.fetchCalls.length >= 1, {
        timeoutMs: 4_000, label: 'the fetch reached the pull consumer',
      });
      await sleep(SETTLE_MS);  // "no messages" is the absence; see SETTLE_MS

      expect(target.received).toHaveLength(0);
      // The 100 ms the command asked for is clamped to the floor nats.js
      // enforces: below a second the client rejects the fetch outright, so a
      // short request would be an exception rather than a short wait.
      expect(pc.fetchCalls).toEqual([{ max_messages: 10, expires: 1_000 }]);
    } finally {
      await sys.terminate();
    }
  });

  test('subsequent fetch resumes from a fresh batch (durable offset is server-side)', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-pull-resume', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'puller', mode: 'pull' });
      const { actor, mock, target } = await bootActor(sys, jetstreamOptions);
      const pc = mock.mockConnection.js.pullConsumers.get('ORDERS::puller')!;
      pc.enqueueBatch([makeHandle(10), makeHandle(11)]);
      pc.enqueueBatch([makeHandle(12), makeHandle(13), makeHandle(14)]);

      actor.tell({ kind: 'fetch', batch: 2, expiresMs: 100 });
      await awaitForwarded(target, 2);
      for (const message of target.received) {
        actor.tell({ kind: 'acknowledgment', ackToken: message.ackToken });
      }
      // The two acks have to be processed before the second fetch, or the
      // pending map is still full and the fetch under test never runs.  The
      // batch handles are inline, so the ack landing is not observable from
      // here — hence a delay, not a poll.
      await sleep(SETTLE_MS);

      actor.tell({ kind: 'fetch', batch: 3, expiresMs: 100 });
      await awaitForwarded(target, 5);
      // The sequence list is exact, and so is the fetch count; see SETTLE_MS.
      await sleep(SETTLE_MS);
      expect(target.received.map((m) => m.streamSeq)).toEqual([10, 11, 12, 13, 14]);
      expect(pc.fetchCalls).toHaveLength(2);

      // Drain the pending map before teardown; see the first ack pair above.
      for (const message of target.received.slice(2)) {
        actor.tell({ kind: 'acknowledgment', ackToken: message.ackToken });
      }
      await sleep(SETTLE_MS);  // drain before teardown, per the comment above
    } finally {
      await sys.terminate();
    }
  });

  test('fetch with batch <= 0 is silently dropped (no consumer call)', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-pull-bad-batch', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'puller', mode: 'pull' });
      const { actor, mock } = await bootActor(sys, jetstreamOptions);
      const pc = mock.mockConnection.js.pullConsumers.get('ORDERS::puller')!;
      actor.tell({ kind: 'fetch', batch: 0, expiresMs: 100 });
      actor.tell({ kind: 'fetch', batch: -5, expiresMs: 100 });
      // An absence — `fetchCalls` is already empty, so a predicate over it
      // returns at t=0.  This is the turn a wrongly-forwarded fetch would use.
      await sleep(SETTLE_MS);
      expect(pc.fetchCalls).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('fetch on a push-mode actor is a silent no-op', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-pull-wrong-mode', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'pusher' }); // mode omitted → push (default)
      const { actor, mock } = await bootActor(sys, jetstreamOptions);
      // No pull consumer was ever fetched.
      expect(mock.mockConnection.js.pullConsumers.size).toBe(0);
      actor.tell({ kind: 'fetch', batch: 5, expiresMs: 100 });
      // An absence, and the second reading of one that already held; this is
      // the turn in which a push-mode actor that wrongly honoured the fetch
      // would materialise a pull consumer.
      await sleep(SETTLE_MS);
      // Still no pull consumer.
      expect(mock.mockConnection.js.pullConsumers.size).toBe(0);
    } finally {
      await sys.terminate();
    }
  });
});

/* ============ Delivery-scoped acknowledgment tokens (#710) ============== */

/**
 * A mock actor that mints a **fresh** connection on every connect, so a
 * reconnect is a real second connection with its own subscription rather
 * than the first one handed out twice.
 *
 * The single-connection {@link MockJetStreamActor} cannot model this: its
 * `closed()` promise resolves the first time `disconnectImplementation`
 * drains it and stays resolved, so the reconnect would report a lost
 * connection the instant it opened one.
 */
class ReconnectingMockJetStreamActor extends JetStreamActor {
  readonly connections: MockNatsConnection[] = [];

  protected override async createNatsConnection(): Promise<NatsConnectionLike> {
    const connection = new MockNatsConnection();
    this.connections.push(connection);
    return connection;
  }

  protected override async jetStreamModule(): Promise<JetStreamModuleLike> {
    return mockJetStreamModule();
  }

  /** Test seam — report a lost connection the way a driver callback does. */
  dropConnection(): void {
    this.handleConnectionLost(new Error('nats connection closed'));
  }

  publicConnectionState(): string { return this.connectionState; }
}

/**
 * A mock whose ack window can be re-timed **between** two deliveries.
 *
 * `deliverAndAwaitAcknowledgment` reads `acknowledgmentTimeout` off the
 * resolved options once per delivery, so changing it between two fetches is
 * what lets a case arm a *short* timer on the stale delivery and a long one
 * on the live redelivery.  Without it both timers are armed milliseconds
 * apart and fire milliseconds apart, and the case would be racing the second
 * one to get its acknowledgment in — a flake, not a test.
 */
class RetimableMockJetStreamActor extends MockJetStreamActor {
  /** Re-time the window the *next* delivery gets; armed timers keep theirs. */
  retimeAcknowledgmentWindow(ms: number): void {
    // The resolved options are a plain snapshot object, not a frozen one —
    // the cast only sheds `readonly`.
    (this.publicResolvedOptions() as { acknowledgmentTimeout?: number }).acknowledgmentTimeout = ms;
  }
}

describe('JetStreamActor — delivery-scoped acknowledgment tokens (#710)', () => {
  test('two overlapping pull deliveries of one streamSeq are settled independently', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-pull-overlap', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'puller', mode: 'pull', ackWaitMs: 4_000 });
      const { actor, mock, target } = await bootActor(sys, jetstreamOptions);
      const pullConsumer = mock.mockConnection.js.pullConsumers.get('ORDERS::puller')!;
      const firstDelivery = makeHandle(4242);
      const redelivery = makeRedelivery(4242, 2);
      pullConsumer.enqueueBatch([firstDelivery]);
      pullConsumer.enqueueBatch([redelivery]);

      // Batch 1.  Its handler is slow and settles nothing yet.
      actor.tell({ kind: 'fetch', batch: 1, expiresMs: 100 });
      await awaitForwarded(target, 1);
      // Batch 2 *while batch 1 is still outstanding* — the ordinary pull
      // pattern, not a contrived one: `onCommand` dispatches `fetch` with
      // `void`, so the mailbox turn ends before the first batch's acks
      // arrive.  Meanwhile the server's ack_wait lapsed and it redelivered
      // 4242, so this batch carries a second delivery of the same message.
      actor.tell({ kind: 'fetch', batch: 1, expiresMs: 100 });
      await awaitForwarded(target, 2);

      // The premise: same message, two live deliveries, distinguishable only
      // by the token.  Keyed on `streamSeq` these two were one map entry.
      expect(target.received.map((m) => m.streamSeq)).toEqual([4242, 4242]);
      expect(target.received[0]!.ackToken).not.toBe(target.received[1]!.ackToken);

      // Settle the *stale* delivery, then the live one.  Under a per-message
      // key both commands named the same entry: the nak consumed the live
      // delivery's entry and the acknowledgment that followed found nothing.
      actor.tell({ kind: 'negativeAcknowledgment', ackToken: target.received[0]!.ackToken });
      await awaitCondition(() => firstDelivery.naked, {
        timeoutMs: 4_000, label: 'the negative acknowledgment reached the stale delivery',
      });
      actor.tell({ kind: 'acknowledgment', ackToken: target.received[1]!.ackToken });
      await awaitCondition(() => redelivery.acked, {
        timeoutMs: 4_000, label: 'the acknowledgment reached the live redelivery',
      });

      // Each command reached its own delivery and no other.
      expect(firstDelivery.acked).toBe(false);
      expect(redelivery.naked).toBe(false);
      expect(redelivery.nakCount).toBe(0);
    } finally {
      await sys.terminate();
    }
  });

  test("a stale delivery's ack-timeout fires while the live redelivery is pending, and leaves it alone", async () => {
    // Step 4 of #710, which no shipped case drove: the *stale* entry's own
    // `setTimeout` firing — and running its `pending.delete` — while a live
    // delivery of the same `streamSeq` is still outstanding.  The overlap
    // case above settles the stale delivery with an explicit
    // `negativeAcknowledgment` instead, and the ack-timeout case has a single
    // delivery, so the identity-checked delete in the timer rested on reading
    // rather than on a test (#1508).
    const logger = new CapturingLogger();
    const sys = observedSystem('js-stale-timer', logger);
    /** Short enough that the stale entry's timer fires inside this case. */
    const staleWindowMs = 300;
    /** Wide enough that the live redelivery's own timer cannot. */
    const liveWindowMs = 4_000;
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'puller', mode: 'pull', ackWaitMs: staleWindowMs })
        .withAcknowledgmentTimeout(staleWindowMs);
      const { actor, mock, target } = await bootActorOfKind(
        sys, jetstreamOptions, (built) => new RetimableMockJetStreamActor(built),
      );
      const pullConsumer = mock.mockConnection.js.pullConsumers.get('ORDERS::puller')!;
      const firstDelivery = makeHandle(4242);
      const redelivery = makeRedelivery(4242, 2);
      pullConsumer.enqueueBatch([firstDelivery]);
      pullConsumer.enqueueBatch([redelivery]);

      actor.tell({ kind: 'fetch', batch: 1, expiresMs: 100 });
      await awaitForwarded(target, 1);
      // The redelivery gets a window of its own, so the two timers are 300 ms
      // and 4 s wide rather than both 300 ms and armed a millisecond apart.
      mock.retimeAcknowledgmentWindow(liveWindowMs);
      actor.tell({ kind: 'fetch', batch: 1, expiresMs: 100 });
      await awaitForwarded(target, 2);

      // The premise, checked rather than assumed: two live deliveries of one
      // message, and the stale one's timer has *not* fired yet.  A runner slow
      // enough to have burned the whole 300 ms getting here fails this line
      // instead of passing the case without ever reaching the overlap.
      expect(target.received.map((m) => m.streamSeq)).toEqual([4242, 4242]);
      expect(firstDelivery.naked).toBe(false);
      const liveToken = target.received[1]!.ackToken;

      // Now let the stale entry's timer run: it rejects its own wait, naks
      // its own handle, and deletes its own key.
      await awaitCondition(() => firstDelivery.naked, {
        timeoutMs: 4_000,
        label: "the stale delivery's ack-timeout fired while the redelivery was pending",
      });

      // The live entry is still registered *after* that delete ran — an
      // `inProgress` naming its token finds it and reports nothing.  Under
      // the per-message key with an unconditional delete, this is exactly
      // where the live entry had gone.
      actor.tell({ kind: 'inProgress', ackToken: liveToken });
      await awaitCondition(() => redelivery.working_called, {
        timeoutMs: 4_000, label: 'the in-progress signal reached the live redelivery',
      });
      expect(logger.unknownTokenWarnings).toEqual([]);

      // …and it can still be settled by its own token.
      actor.tell({ kind: 'acknowledgment', ackToken: liveToken });
      await awaitCondition(() => redelivery.acked, {
        timeoutMs: 4_000, label: 'the live redelivery was acknowledged by its own token',
      });
      expect(firstDelivery.acked).toBe(false);
      expect(redelivery.naked).toBe(false);
      expect(redelivery.nakCount).toBe(0);
    } finally {
      await sys.terminate();
    }
  });

  test('a delivery in flight at disconnect is settled, so no timer survives the reconnect', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-reconnect-orphan', sysOptions);
    /** Short on purpose: the test has to outlive one whole ack window. */
    const ackTimeoutMs = 120;
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'pusher', ackWaitMs: ackTimeoutMs })
        .withAcknowledgmentTimeout(ackTimeoutMs)
        .withReconnect({ initialDelayMs: 5, maxDelayMs: 5, factor: 1, randomFactor: 0 });
      const { actor, mock, target } = await bootActorOfKind(
        sys, jetstreamOptions, (built) => new ReconnectingMockJetStreamActor(built),
      );
      const beforeDrop = makeHandle(77);
      mock.connections[0]!.js.subscription.push(beforeDrop);
      await awaitForwarded(target, 1);

      // The connection drops with 77 still unacknowledged.  Its ack-timeout
      // is armed and, before #710, `disconnectImplementation` cleared the map
      // without settling the entry — leaving that timer to fire into a tree
      // that had already reconnected.
      mock.dropConnection();
      await awaitCondition(
        () => mock.connections.length >= 2 && mock.publicConnectionState() === 'connected',
        { timeoutMs: 4_000, label: 'the actor reconnected on a fresh connection' },
      );

      // The server redelivers 77 on the new connection, and the application
      // settles it promptly — so from here on the only thing that can touch a
      // handle is an ack-timeout that should no longer exist.
      const afterReconnect = makeRedelivery(77, 2);
      mock.connections[1]!.js.subscription.push(afterReconnect);
      await awaitForwarded(target, 2);
      actor.tell({ kind: 'acknowledgment', ackToken: target.received[1]!.ackToken });
      await awaitCondition(() => afterReconnect.acked, {
        timeoutMs: 4_000, label: 'the redelivery after the reconnect was acknowledged',
      });

      // The elapsed time *is* what is under test: an orphaned ack-timeout
      // fires `ackTimeoutMs` after its delivery and there is nothing to poll
      // for its absence.  Four windows is the margin over a loaded runner.
      await sleep(ackTimeoutMs * 4);

      // Exactly one nak — the disconnect's.  A second one is the orphaned
      // timer firing after the reconnect, which is also what evicted the live
      // entry back when both shared the `streamSeq` key.
      expect(beforeDrop.nakCount).toBe(1);
      expect(beforeDrop.acked).toBe(false);
      // The redelivery was never disturbed by it.
      expect(afterReconnect.nakCount).toBe(0);
    } finally {
      await sys.terminate();
    }
  });

  test('a token minted before a reconnect is never minted again after it', async () => {
    // `nextAcknowledgmentToken` is monotonic per actor instance and is never
    // reset — the JSDoc on the field says so and nothing observed it.  The
    // reconnect case above reads `target.received[1]!.ackToken` rather than
    // comparing the two, so resetting the counter in
    // `disconnectImplementation` left the whole suite green.
    //
    // What the reset costs is not abstract.  A settle command that raced the
    // disconnect carries a token minted before it; if the counter restarts,
    // that token names a *different*, live delivery on the new connection, and
    // the stale command settles it.  That is the same class of defect as #710
    // itself — one delivery's settle landing on another's entry — arrived at
    // through the reconnect rather than through the key.
    const logger = new CapturingLogger();
    const sys = observedSystem('js-token-monotonic', logger);
    /** Long enough that no ack-timeout fires inside this case. */
    const ackTimeoutMs = 4_000;
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'pusher', ackWaitMs: ackTimeoutMs })
        .withAcknowledgmentTimeout(ackTimeoutMs)
        .withReconnect({ initialDelayMs: 5, maxDelayMs: 5, factor: 1, randomFactor: 0 });
      const { actor, mock, target } = await bootActorOfKind(
        sys, jetstreamOptions, (built) => new ReconnectingMockJetStreamActor(built),
      );
      const beforeDrop = makeHandle(11);
      mock.connections[0]!.js.subscription.push(beforeDrop);
      await awaitForwarded(target, 1);
      const staleToken = target.received[0]!.ackToken;

      mock.dropConnection();
      await awaitCondition(
        () => mock.connections.length >= 2 && mock.publicConnectionState() === 'connected',
        { timeoutMs: 4_000, label: 'the actor reconnected on a fresh connection' },
      );

      // An unrelated message on the new connection — a different stream
      // sequence, so nothing but the token could confuse the two.
      const afterReconnect = makeHandle(12);
      mock.connections[1]!.js.subscription.push(afterReconnect);
      await awaitForwarded(target, 2);
      const liveToken = target.received[1]!.ackToken;

      // The claim, stated directly.
      expect(liveToken).toBeGreaterThan(staleToken);

      // And the consequence, so the assertion above is not the only thing
      // standing between a reset counter and a mis-settled delivery: the
      // settle command that raced the disconnect arrives late and must find
      // nothing, leaving the live delivery untouched.
      actor.tell({ kind: 'acknowledgment', ackToken: staleToken });
      await awaitCondition(() => logger.unknownTokenWarnings.length === 1, {
        timeoutMs: 4_000,
        label: 'the raced settle command found no pending entry',
      });
      // "Untouched" is an absence; settle past where an ack would have landed.
      await sleep(SETTLE_MS);
      expect(afterReconnect.acked).toBe(false);
      expect(afterReconnect.naked).toBe(false);
      expect(logger.unknownTokenWarnings[0]).toContain(`ackToken=${staleToken}`);

      // Release the pump so teardown is not racing an outstanding ack wait.
      actor.tell({ kind: 'acknowledgment', ackToken: liveToken });
      await awaitCondition(() => afterReconnect.acked, {
        timeoutMs: 4_000, label: 'the live delivery was acknowledged by its own token',
      });
    } finally {
      await sys.terminate();
    }
  });

  test('a disconnect with five deliveries in flight writes one aggregate WARN, not one per delivery', async () => {
    // Routing every in-flight delivery through the shared catch made each
    // reconnect emit one WARN per outstanding delivery, where the pre-#710
    // path had been silent.  On a consumer with `maxAcknowledgmentPending` in
    // the hundreds a flapping connection then produces hundreds of warn lines
    // per flap — so the count is the WARN and the per-delivery detail is
    // `debug` (#1510).  Pull mode, because the push pump awaits each delivery
    // in turn and can only ever have one in flight.
    const logger = new DebugCapturingLogger();
    const sys = observedSystem('js-disconnect-aggregate', logger);
    /** Long enough that no ack-timeout fires inside this case. */
    const ackTimeoutMs = 4_000;
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'puller', mode: 'pull', ackWaitMs: ackTimeoutMs })
        .withAcknowledgmentTimeout(ackTimeoutMs)
        .withReconnect({ initialDelayMs: 5, maxDelayMs: 5, factor: 1, randomFactor: 0 });
      const { actor, mock, target } = await bootActorOfKind(
        sys, jetstreamOptions, (built) => new ReconnectingMockJetStreamActor(built),
      );
      const inFlight = [10, 11, 12, 13, 14].map((seq) => makeHandle(seq));
      mock.connections[0]!.js.pullConsumers.get('ORDERS::puller')!.enqueueBatch(inFlight);
      actor.tell({ kind: 'fetch', batch: 5, expiresMs: 100 });
      await awaitForwarded(target, 5);

      mock.dropConnection();
      // The best-effort `nak()` is the last thing the shared catch does, so
      // five naks means all five catch paths have run and every line they
      // write is already in the log.  That is what makes "exactly one" here
      // an exact claim rather than a poll that returned early.
      await awaitCondition(() => inFlight.every((handle) => handle.nakCount === 1), {
        timeoutMs: 4_000,
        label: 'all five in-flight deliveries were failed and nak\'d by the disconnect',
      });

      expect(logger.connectionLostWarnings).toHaveLength(1);
      expect(logger.connectionLostWarnings[0]).toBe(
        'JetStreamActor: connection lost with 5 deliveries in flight — letting the consumer redeliver',
      );
      // The per-delivery lines went to `debug`, so the WARN log carries the
      // aggregate and nothing else from this disconnect…
      expect(logger.warnings.filter((w) => w.includes('before ack/nak/term'))).toEqual([]);
      // …and they are still *written*, which is the other half of "demoted to
      // `debug`" and the half a WARN-only capture cannot see.
      expect(logger.pumpDebugs).toEqual([10, 11, 12, 13, 14].map((streamSeq, index) =>
        `JetStreamActor: pump connection lost before ack/nak/term for `
        + `streamSeq=${streamSeq} (ackToken=${index + 1}) — letting consumer redeliver`));
      // No line is prefixed twice — at either level.  The `debug` half is
      // load-bearing here: the connection-lost message is the one that used
      // to carry the prefix a second time, and it is no longer a warning.
      expect(logger.doublyPrefixedWarnings).toEqual([]);
      expect(logger.doublyPrefixedDebugs).toEqual([]);

      // Let the reconnect finish before teardown, so the system is not torn
      // down through a connect that is still in flight.
      await awaitCondition(
        () => mock.connections.length >= 2 && mock.publicConnectionState() === 'connected',
        { timeoutMs: 4_000, label: 'the actor reconnected on a fresh connection' },
      );
    } finally {
      await sys.terminate();
    }
  });

  test('an ack-timeout stays at WARN, and its line carries the prefix once', async () => {
    // The other half of the level split: a timeout names one handler that did
    // not answer in time, which is still the operator's business.  It shares
    // the catch with the connection-lost case, so a fix that moved the whole
    // catch to `debug` would silence this too (#1510).
    const logger = new CapturingLogger();
    const sys = observedSystem('js-timeout-warn', logger);
    /** Short on purpose: the case has to outlive one whole ack window. */
    const ackTimeoutMs = 60;
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd', ackWaitMs: ackTimeoutMs })
        .withAcknowledgmentTimeout(ackTimeoutMs);
      const { mock } = await bootActor(sys, jetstreamOptions);
      const handle = makeHandle(8);
      mock.mockConnection.js.subscription.push(handle);
      await awaitCondition(() => handle.naked, {
        timeoutMs: 4_000, label: 'the ack timeout naked the un-acknowledged handle',
      });

      const timeoutWarnings = logger.warnings.filter((w) => w.includes('no ack/nak/term'));
      expect(timeoutWarnings).toHaveLength(1);
      expect(timeoutWarnings[0]).toBe(
        `JetStreamActor: pump no ack/nak/term for streamSeq=8 (ackToken=1) `
        + `within ${ackTimeoutMs}ms — letting consumer redeliver`,
      );
      expect(logger.doublyPrefixedWarnings).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });
});
