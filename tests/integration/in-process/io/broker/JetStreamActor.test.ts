/**
 * Unit tests for JetStreamActor (#3) — push consumer + ack/nak/term
 * handshake.  Same test-seam pattern as KafkaActor (#2): subclass
 * JetStreamActor and override `createNatsConnection` to inject a
 * pure-JS mock.  Lets us drive the manual-ack pump without involving
 * the real `nats` peer-dep.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import {
  JetStreamActor,
  type JetStreamClientLike,
  type JetStreamCommand,
  type JetStreamManagerLike,
  type JetStreamMessage,
  type JetStreamMessageHandleLike,
  type JetStreamSubscriptionLike,
  type NatsConnectionLike,
} from '../../../../../src/io/broker/JetStreamActor.js';
import { JetStreamOptions, JetStreamOptionsBuilder } from '../../../../../src/io/broker/JetStreamOptions.js';

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
class MockSubscription implements JetStreamSubscriptionLike {
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

  async destroy(): Promise<void> {
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
  readonly subscribeCalls: Array<{ subject: string; stream: string; consumer: string }> = [];
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

  async subscribe(subject: string, options: { stream: string; consumer: string }): Promise<JetStreamSubscriptionLike> {
    this.subscribeCalls.push({ subject, stream: options.stream, consumer: options.consumer });
    return this.subscription;
  }

  readonly consumers = {
    get: async (stream: string, durable: string): Promise<MockPullConsumer> => {
      const key = `${stream}::${durable}`;
      let pc = this.pullConsumers.get(key);
      if (!pc) { pc = new MockPullConsumer(); this.pullConsumers.set(key, pc); }
      return pc;
    },
  };
}

class MockJsm implements JetStreamManagerLike {
  readonly streamsAdd: Array<{ name: string; subjects: string[] }> = [];
  readonly streamsUpdate: Array<{ name: string }> = [];
  readonly consumersAdd: Array<{ stream: string; durable: string; deliver_policy?: string; ack_wait?: number }> = [];
  readonly streams = {
    add: async (config: { name: string; subjects: string[]; retention?: string; storage?: string; max_msgs?: number; max_bytes?: number; max_age?: number }) => {
      this.streamsAdd.push({ name: config.name, subjects: [...config.subjects] });
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
    }) => {
      this.consumersAdd.push({
        stream,
        durable: config.durable_name,
        deliver_policy: config.deliver_policy,
        ack_wait: config.ack_wait,
      });
    },
    update: async (_stream: string, _durable: string) => { /* no-op */ },
  };
}

class MockNatsConnection implements NatsConnectionLike {
  readonly js = new MockJetStream();
  readonly jsm = new MockJsm();
  private closedResolve!: (e: Error | undefined) => void;
  private closedPromise = new Promise<Error | undefined>((resolveNext) => { this.closedResolve = resolveNext; });

  jetstream(): JetStreamClientLike { return this.js; }
  async jetstreamManager(): Promise<JetStreamManagerLike> { return this.jsm; }
  async drain(): Promise<void> { this.closedResolve(undefined); }
  closed(): Promise<Error | undefined> { return this.closedPromise; }
}

class MockJetStreamActor extends JetStreamActor {
  readonly mockConnection = new MockNatsConnection();
  protected override async createNatsConnection(): Promise<NatsConnectionLike> {
    return this.mockConnection;
  }

  publicConnectionState(): string { return this.connectionState; }
}

/* --------------------------- Helpers ---------------------------- */

class CapturingTarget extends Actor<JetStreamMessage> {
  readonly received: JetStreamMessage[] = [];
  override onReceive(m: JetStreamMessage): void { this.received.push(m); }
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
      expect(mock.mockConnection.js.subscribeCalls[0]?.stream).toBe('ORDERS');
      expect(mock.mockConnection.js.subscribeCalls[0]?.consumer).toBe('order-proc');
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
      expect(mock.mockConnection.js.subscribeCalls).toHaveLength(1);
    } finally {
      await sys.terminate();
    }
  });

  test('byStartSeq deliverPolicy translates correctly', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-policy', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd', deliverPolicy: { kind: 'byStartSeq', startSeq: 100 } });
      const { mock } = await bootActor(sys, jetstreamOptions);
      expect(mock.mockConnection.jsm.consumersAdd[0]?.deliver_policy).toBe('by_start_sequence');
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

  test('term marks the handle terminated (drop-forever)', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-term', sysOptions);
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

  test('ackPolicy=none skips the handshake — every message is forwarded immediately', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-none', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd', ackPolicy: 'none' });
      const { mock, target } = await bootActor(sys, jetstreamOptions);
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
    } finally {
      await sys.terminate();
    }
  });

  test('ack for an unknown ackToken is a no-op (and now logs a warning)', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('js-unknown', sysOptions);
    try {
      const jetstreamOptions = JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd' });
      const { actor } = await bootActor(sys, jetstreamOptions);
      // No handle pushed, so no pending entry.  Sending ack should not throw.
      actor.tell({ kind: 'acknowledgment', ackToken: 999 });
      // The claim is an absence whose observable side is a crash that did not
      // happen — there is nothing to poll for, only a turn to give away.
      await sleep(SETTLE_MS);
      // Test passes if we get here without unhandled rejection.
      expect(true).toBe(true);
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
      const sub = mock.mockConnection.js.subscribeCalls[0];
      expect(sub?.stream).toBe('BILLING');
      expect(sub?.consumer).toBe('billing-proc');
      // Filter subject is forwarded as the subscribe subject.
      expect(sub?.subject).toBe('billing.charges');
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
      // No subscribe — pull mode is on-demand.
      expect(mock.mockConnection.js.subscribeCalls).toHaveLength(0);
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
      expect(pc.fetchCalls).toEqual([{ max_messages: 10, expires: 100 }]);
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

  /** Test seam — report a lost connection the way a driver callback does. */
  dropConnection(): void {
    this.handleConnectionLost(new Error('nats connection closed'));
  }

  publicConnectionState(): string { return this.connectionState; }
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
});
