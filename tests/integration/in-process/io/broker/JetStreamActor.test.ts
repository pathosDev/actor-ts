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
import { Props } from '../../../../../src/Props.js';
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

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/* --------------------------- Mocks ----------------------------- */

class MockHandle implements JetStreamMessageHandleLike {
  acked = false;
  naked = false;
  termed = false;
  working_called = false;
  nakDelay?: number;

  constructor(
    public readonly subject: string,
    public readonly data: Uint8Array,
    public readonly info: { streamSequence: number; deliverySequence: number; deliveryCount: number; timestampNanos?: number },
    public readonly reply: string | undefined,
    public readonly headers: undefined,
  ) {}

  ack(): void { this.acked = true; }
  nak(delayMs?: number): void { this.naked = true; this.nakDelay = delayMs; }
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
}

/* --------------------------- Helpers ---------------------------- */

class CapturingTarget extends Actor<JetStreamMessage> {
  readonly received: JetStreamMessage[] = [];
  override onReceive(m: JetStreamMessage): void { this.received.push(m); }
}

async function bootActor(
  sys: ActorSystem, options: JetStreamOptionsBuilder,
): Promise<{ actor: ActorRef<JetStreamCommand>; mock: MockJetStreamActor; target: CapturingTarget }> {
  const target = new CapturingTarget();
  const targetRef = sys.spawn(Props.create(() => target), 'target');
  const ref = { current: null as MockJetStreamActor | null };
  const actor = sys.spawn(
    Props.create(() => {
      const mockActor = new MockJetStreamActor(options.withTarget(targetRef));
      ref.current = mockActor;
      return mockActor;
    }),
    'js',
  );
  // Allow preStart + connect to complete and the pump to enter `for await`.
  await sleep(60);
  return { actor: actor as ActorRef<JetStreamCommand>, mock: ref.current!, target };
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
      await sleep(40);
      expect(target.received).toHaveLength(1);
      expect(target.received[0]!.streamSeq).toBe(42);

      actor.tell({ kind: 'acknowledgment', streamSeq: 42 });
      await sleep(40);
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
      const { actor, mock } = await bootActor(sys, jetstreamOptions);
      const handle = makeHandle(7);
      mock.mockConnection.js.subscription.push(handle);
      await sleep(40);
      actor.tell({ kind: 'negativeAcknowledgment', streamSeq: 7, delayMs: 1500 });
      await sleep(40);
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
      const { actor, mock } = await bootActor(sys, jetstreamOptions);
      const handle = makeHandle(99);
      mock.mockConnection.js.subscription.push(handle);
      await sleep(40);
      actor.tell({ kind: 'terminate', streamSeq: 99, reason: 'unparseable' });
      await sleep(40);
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
      const { actor, mock } = await bootActor(sys, jetstreamOptions);
      const handle = makeHandle(5);
      mock.mockConnection.js.subscription.push(handle);
      await sleep(40);
      actor.tell({ kind: 'inProgress', streamSeq: 5 });
      await sleep(20);
      expect(handle.working_called).toBe(true);
      // The handle is still pending — neither acked nor naked.
      expect(handle.acked).toBe(false);
      expect(handle.naked).toBe(false);
      // Clean up.
      actor.tell({ kind: 'acknowledgment', streamSeq: 5 });
      await sleep(40);
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
      await sleep(120);   // past the timeout
      expect(h1.naked).toBe(true);
      // Pump should be free to receive the next message now.
      const h2 = makeHandle(2);
      mock.mockConnection.js.subscription.push(h2);
      await sleep(40);
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
      await sleep(80);
      expect(target.received.map((resolveNext) => resolveNext.streamSeq)).toEqual([1, 2]);
      expect(h1.acked).toBe(false);   // pump didn't call ack
      expect(h2.acked).toBe(false);
    } finally {
      await sys.terminate();
    }
  });

  test('ack for unknown streamSeq is a silent no-op', async () => {
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
      actor.tell({ kind: 'acknowledgment', streamSeq: 999 });
      await sleep(20);
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
      await sleep(40);
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
      await sleep(50);

      // All three messages delivered to target before any ack.
      expect(target.received.map((m) => m.streamSeq).sort()).toEqual([1, 2, 3]);
      // Fetch was called with the requested parameters.
      expect(pc.fetchCalls).toEqual([{ max_messages: 3, expires: 1_000 }]);

      // Acknowledgment them all so the pending-map drains.
      actor.tell({ kind: 'acknowledgment', streamSeq: 1 });
      actor.tell({ kind: 'acknowledgment', streamSeq: 2 });
      actor.tell({ kind: 'acknowledgment', streamSeq: 3 });
      await sleep(30);
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
      await sleep(40);

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
      await sleep(30);
      actor.tell({ kind: 'acknowledgment', streamSeq: 10 });
      actor.tell({ kind: 'acknowledgment', streamSeq: 11 });
      await sleep(20);

      actor.tell({ kind: 'fetch', batch: 3, expiresMs: 100 });
      await sleep(30);
      expect(target.received.map((m) => m.streamSeq)).toEqual([10, 11, 12, 13, 14]);
      expect(pc.fetchCalls).toHaveLength(2);

      actor.tell({ kind: 'acknowledgment', streamSeq: 12 });
      actor.tell({ kind: 'acknowledgment', streamSeq: 13 });
      actor.tell({ kind: 'acknowledgment', streamSeq: 14 });
      await sleep(20);
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
      await sleep(20);
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
      await sleep(20);
      // Still no pull consumer.
      expect(mock.mockConnection.js.pullConsumers.size).toBe(0);
    } finally {
      await sys.terminate();
    }
  });
});