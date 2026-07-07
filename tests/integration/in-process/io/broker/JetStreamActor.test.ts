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
  type JetStreamCmd,
  type JetStreamManagerLike,
  type JetStreamMessage,
  type JetStreamMsgHandleLike,
  type JetStreamSubscriptionLike,
  type NatsConnectionLike,
} from '../../../../../src/io/broker/JetStreamActor.js';
import { JetStreamOptions } from '../../../../../src/io/broker/JetStreamOptions.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/* --------------------------- Mocks ----------------------------- */

class MockHandle implements JetStreamMsgHandleLike {
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
  private resolveNext: ((m: IteratorResult<JetStreamMsgHandleLike>) => void) | null = null;
  private buffer: JetStreamMsgHandleLike[] = [];
  destroyed = false;

  push(h: JetStreamMsgHandleLike): void {
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: h, done: false });
    } else {
      this.buffer.push(h);
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<JetStreamMsgHandleLike> {
    return {
      next: (): Promise<IteratorResult<JetStreamMsgHandleLike>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.destroyed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<JetStreamMsgHandleLike>>((r) => { this.resolveNext = r; });
      },
    };
  }
}

class MockPullConsumer {
  /** Queue of message batches to hand out on `fetch()`.  Test pushes via `enqueueBatch`. */
  readonly batches: JetStreamMsgHandleLike[][] = [];
  readonly fetchCalls: Array<{ max_messages: number; expires: number }> = [];

  enqueueBatch(handles: JetStreamMsgHandleLike[]): void {
    this.batches.push(handles);
  }

  async fetch(opts: { max_messages: number; expires: number }): Promise<AsyncIterable<JetStreamMsgHandleLike>> {
    this.fetchCalls.push({ max_messages: opts.max_messages, expires: opts.expires });
    const batch = this.batches.shift() ?? [];
    // Slice the batch to `max_messages` so the test can model "fewer
    // available than asked".
    const delivered = batch.slice(0, opts.max_messages);
    return (async function* () { for (const h of delivered) yield h; })();
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

  async publish(subject: string, payload: Uint8Array, opts?: {
    msgID?: string; expect?: { lastSequence?: number };
    headers?: Readonly<Record<string, string>>;
  }): Promise<unknown> {
    this.published.push({
      subject, payload,
      msgID: opts?.msgID,
      expectLastSeq: opts?.expect?.lastSequence,
      headers: opts?.headers ? { ...opts.headers } : undefined,
    });
    return { seq: this.published.length };
  }

  async subscribe(subject: string, opts: { stream: string; consumer: string }): Promise<JetStreamSubscriptionLike> {
    this.subscribeCalls.push({ subject, stream: opts.stream, consumer: opts.consumer });
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
    add: async (cfg: { name: string; subjects: string[]; retention?: string; storage?: string; max_msgs?: number; max_bytes?: number; max_age?: number }) => {
      this.streamsAdd.push({ name: cfg.name, subjects: [...cfg.subjects] });
    },
    update: async (name: string) => {
      this.streamsUpdate.push({ name });
    },
  };
  readonly consumers = {
    add: async (stream: string, cfg: {
      durable_name: string; ack_policy?: string; ack_wait?: number;
      filter_subject?: string; max_ack_pending?: number;
      deliver_policy?: string; opt_start_seq?: number; opt_start_time?: string;
    }) => {
      this.consumersAdd.push({
        stream,
        durable: cfg.durable_name,
        deliver_policy: cfg.deliver_policy,
        ack_wait: cfg.ack_wait,
      });
    },
    update: async (_stream: string, _durable: string) => { /* no-op */ },
  };
}

class MockNatsConnection implements NatsConnectionLike {
  readonly js = new MockJetStream();
  readonly jsm = new MockJsm();
  private closedResolve!: (e: Error | undefined) => void;
  private closedPromise = new Promise<Error | undefined>((r) => { this.closedResolve = r; });

  jetstream(): JetStreamClientLike { return this.js; }
  async jetstreamManager(): Promise<JetStreamManagerLike> { return this.jsm; }
  async drain(): Promise<void> { this.closedResolve(undefined); }
  closed(): Promise<Error | undefined> { return this.closedPromise; }
}

class MockJetStreamActor extends JetStreamActor {
  readonly mockConn = new MockNatsConnection();
  protected override async createNatsConnection(): Promise<NatsConnectionLike> {
    return this.mockConn;
  }
}

/* --------------------------- Helpers ---------------------------- */

class CapturingTarget extends Actor<JetStreamMessage> {
  readonly received: JetStreamMessage[] = [];
  override onReceive(m: JetStreamMessage): void { this.received.push(m); }
}

async function bootActor(
  sys: ActorSystem, options: JetStreamOptions,
): Promise<{ actor: ActorRef<JetStreamCmd>; mock: MockJetStreamActor; target: CapturingTarget }> {
  const target = new CapturingTarget();
  const targetRef = sys.spawn(Props.create(() => target), 'target');
  const ref = { current: null as MockJetStreamActor | null };
  const actor = sys.spawn(
    Props.create(() => {
      const a = new MockJetStreamActor(options.withTarget(targetRef));
      ref.current = a;
      return a;
    }),
    'js',
  );
  // Allow preStart + connect to complete and the pump to enter `for await`.
  await sleep(60);
  return { actor: actor as ActorRef<JetStreamCmd>, mock: ref.current!, target };
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
    const sys = ActorSystem.create('js-lifecycle', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { mock } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'order-proc', ackWaitMs: 5_000 }));
      expect(mock.mockConn.jsm.streamsAdd).toHaveLength(1);
      expect(mock.mockConn.jsm.streamsAdd[0]?.name).toBe('ORDERS');
      expect(mock.mockConn.jsm.consumersAdd).toHaveLength(1);
      expect(mock.mockConn.jsm.consumersAdd[0]?.durable).toBe('order-proc');
      // ackWaitMs translates to nanoseconds in the underlying API.
      expect(mock.mockConn.jsm.consumersAdd[0]?.ack_wait).toBe(5_000_000_000);
      // Subscription wired with stream + durable name.
      expect(mock.mockConn.js.subscribeCalls[0]?.stream).toBe('ORDERS');
      expect(mock.mockConn.js.subscribeCalls[0]?.consumer).toBe('order-proc');
    } finally {
      await sys.terminate();
    }
  });

  test('skips upsert when create=false on stream / consumer', async () => {
    const sys = ActorSystem.create('js-noupsert', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { mock } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'EVENTS', subjects: ['events.>'], create: false })
        .withConsumer({ durable: 'd', create: false }));
      expect(mock.mockConn.jsm.streamsAdd).toEqual([]);
      expect(mock.mockConn.jsm.consumersAdd).toEqual([]);
      // Subscribe should still have happened.
      expect(mock.mockConn.js.subscribeCalls).toHaveLength(1);
    } finally {
      await sys.terminate();
    }
  });

  test('byStartSeq deliverPolicy translates correctly', async () => {
    const sys = ActorSystem.create('js-policy', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { mock } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd', deliverPolicy: { kind: 'byStartSeq', startSeq: 100 } }));
      expect(mock.mockConn.jsm.consumersAdd[0]?.deliver_policy).toBe('by_start_sequence');
    } finally {
      await sys.terminate();
    }
  });
});

describe('JetStreamActor — ack/nak/term', () => {
  test('ack acknowledges the handle and resolves the pump', async () => {
    const sys = ActorSystem.create('js-ack', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { actor, mock, target } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd', ackWaitMs: 5_000 }));
      const h = makeHandle(42);
      mock.mockConn.js.subscription.push(h);
      await sleep(40);
      expect(target.received).toHaveLength(1);
      expect(target.received[0]!.streamSeq).toBe(42);

      actor.tell({ kind: 'ack', streamSeq: 42 });
      await sleep(40);
      expect(h.acked).toBe(true);
    } finally {
      await sys.terminate();
    }
  });

  test('nak with delayMs forwards the delay to the handle', async () => {
    const sys = ActorSystem.create('js-nak', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { actor, mock } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd' }));
      const h = makeHandle(7);
      mock.mockConn.js.subscription.push(h);
      await sleep(40);
      actor.tell({ kind: 'nak', streamSeq: 7, delayMs: 1500 });
      await sleep(40);
      expect(h.naked).toBe(true);
      expect(h.nakDelay).toBe(1500);
      expect(h.acked).toBe(false);
    } finally {
      await sys.terminate();
    }
  });

  test('term marks the handle terminated (drop-forever)', async () => {
    const sys = ActorSystem.create('js-term', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { actor, mock } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd' }));
      const h = makeHandle(99);
      mock.mockConn.js.subscription.push(h);
      await sleep(40);
      actor.tell({ kind: 'term', streamSeq: 99, reason: 'unparseable' });
      await sleep(40);
      expect(h.termed).toBe(true);
    } finally {
      await sys.terminate();
    }
  });

  test('inProgress calls handle.working() to extend the ack window', async () => {
    const sys = ActorSystem.create('js-inprog', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { actor, mock } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd' }));
      const h = makeHandle(5);
      mock.mockConn.js.subscription.push(h);
      await sleep(40);
      actor.tell({ kind: 'inProgress', streamSeq: 5 });
      await sleep(20);
      expect(h.working_called).toBe(true);
      // The handle is still pending — neither acked nor naked.
      expect(h.acked).toBe(false);
      expect(h.naked).toBe(false);
      // Clean up.
      actor.tell({ kind: 'ack', streamSeq: 5 });
      await sleep(40);
    } finally {
      await sys.terminate();
    }
  });

  test('ack-timeout naks the handle automatically and the pump continues', async () => {
    const sys = ActorSystem.create('js-timeout', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { mock, target } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd', ackWaitMs: 60 })
        .withAckTimeout(60));
      const h1 = makeHandle(1);
      mock.mockConn.js.subscription.push(h1);
      await sleep(120);   // past the timeout
      expect(h1.naked).toBe(true);
      // Pump should be free to receive the next message now.
      const h2 = makeHandle(2);
      mock.mockConn.js.subscription.push(h2);
      await sleep(40);
      expect(target.received).toHaveLength(2);
      expect(target.received[1]!.streamSeq).toBe(2);
    } finally {
      await sys.terminate();
    }
  });

  test('ackPolicy=none skips the handshake — every message is forwarded immediately', async () => {
    const sys = ActorSystem.create('js-none', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { mock, target } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd', ackPolicy: 'none' }));
      const h1 = makeHandle(1);
      const h2 = makeHandle(2);
      mock.mockConn.js.subscription.push(h1);
      mock.mockConn.js.subscription.push(h2);
      await sleep(80);
      expect(target.received.map((r) => r.streamSeq)).toEqual([1, 2]);
      expect(h1.acked).toBe(false);   // pump didn't call ack
      expect(h2.acked).toBe(false);
    } finally {
      await sys.terminate();
    }
  });

  test('ack for unknown streamSeq is a silent no-op', async () => {
    const sys = ActorSystem.create('js-unknown', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { actor } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'S', subjects: ['s.>'] })
        .withConsumer({ durable: 'd' }));
      // No handle pushed, so no pending entry.  Sending ack should not throw.
      actor.tell({ kind: 'ack', streamSeq: 999 });
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
    const sys = ActorSystem.create('js-pub', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { actor, mock } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222']));
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
      const p = mock.mockConn.js.published[0];
      expect(p?.subject).toBe('orders.new');
      expect(new TextDecoder().decode(p!.payload)).toBe('hello');
      expect(p?.msgID).toBe('abc-123');
      expect(p?.expectLastSeq).toBe(42);
      expect(p?.headers).toEqual({ 'X-Tenant': 't1' });
    } finally {
      await sys.terminate();
    }
  });
});

describe('JetStreamActor — settings parsing', () => {
  test('subscription is wired with the configured stream + durable consumer', async () => {
    const sys = ActorSystem.create('js-wiring', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { mock } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'BILLING', subjects: ['billing.>'] })
        .withConsumer({ durable: 'billing-proc', filterSubject: 'billing.charges' }));
      const sub = mock.mockConn.js.subscribeCalls[0];
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
    const sys = ActorSystem.create('js-pull-setup', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { mock } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'puller', mode: 'pull' }));
      // No subscribe — pull mode is on-demand.
      expect(mock.mockConn.js.subscribeCalls).toHaveLength(0);
      // Pull-consumer handle materialised for ORDERS::puller.
      expect(mock.mockConn.js.pullConsumers.size).toBe(1);
      expect(mock.mockConn.js.pullConsumers.has('ORDERS::puller')).toBe(true);
    } finally {
      await sys.terminate();
    }
  });

  test('fetch delivers messages and waits for ack before returning', async () => {
    const sys = ActorSystem.create('js-pull-fetch', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { actor, mock, target } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'puller', mode: 'pull', ackWaitMs: 1_000 }));
      const pc = mock.mockConn.js.pullConsumers.get('ORDERS::puller')!;
      pc.enqueueBatch([makeHandle(1), makeHandle(2), makeHandle(3)]);

      actor.tell({ kind: 'fetch', batch: 3, expiresMs: 1_000 });
      await sleep(50);

      // All three messages delivered to target before any ack.
      expect(target.received.map((m) => m.streamSeq).sort()).toEqual([1, 2, 3]);
      // Fetch was called with the requested parameters.
      expect(pc.fetchCalls).toEqual([{ max_messages: 3, expires: 1_000 }]);

      // Ack them all so the pending-map drains.
      actor.tell({ kind: 'ack', streamSeq: 1 });
      actor.tell({ kind: 'ack', streamSeq: 2 });
      actor.tell({ kind: 'ack', streamSeq: 3 });
      await sleep(30);
    } finally {
      await sys.terminate();
    }
  });

  test('expires-without-messages returns cleanly (empty batch is not an error)', async () => {
    const sys = ActorSystem.create('js-pull-empty', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { actor, mock, target } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'puller', mode: 'pull' }));
      const pc = mock.mockConn.js.pullConsumers.get('ORDERS::puller')!;
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
    const sys = ActorSystem.create('js-pull-resume', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { actor, mock, target } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'puller', mode: 'pull' }));
      const pc = mock.mockConn.js.pullConsumers.get('ORDERS::puller')!;
      pc.enqueueBatch([makeHandle(10), makeHandle(11)]);
      pc.enqueueBatch([makeHandle(12), makeHandle(13), makeHandle(14)]);

      actor.tell({ kind: 'fetch', batch: 2, expiresMs: 100 });
      await sleep(30);
      actor.tell({ kind: 'ack', streamSeq: 10 });
      actor.tell({ kind: 'ack', streamSeq: 11 });
      await sleep(20);

      actor.tell({ kind: 'fetch', batch: 3, expiresMs: 100 });
      await sleep(30);
      expect(target.received.map((m) => m.streamSeq)).toEqual([10, 11, 12, 13, 14]);
      expect(pc.fetchCalls).toHaveLength(2);

      actor.tell({ kind: 'ack', streamSeq: 12 });
      actor.tell({ kind: 'ack', streamSeq: 13 });
      actor.tell({ kind: 'ack', streamSeq: 14 });
      await sleep(20);
    } finally {
      await sys.terminate();
    }
  });

  test('fetch with batch <= 0 is silently dropped (no consumer call)', async () => {
    const sys = ActorSystem.create('js-pull-bad-batch', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { actor, mock } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'puller', mode: 'pull' }));
      const pc = mock.mockConn.js.pullConsumers.get('ORDERS::puller')!;
      actor.tell({ kind: 'fetch', batch: 0, expiresMs: 100 });
      actor.tell({ kind: 'fetch', batch: -5, expiresMs: 100 });
      await sleep(20);
      expect(pc.fetchCalls).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('fetch on a push-mode actor is a silent no-op', async () => {
    const sys = ActorSystem.create('js-pull-wrong-mode', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    try {
      const { actor, mock } = await bootActor(sys, JetStreamOptions.create()
        .withServers(['nats://fake:4222'])
        .withStream({ name: 'ORDERS', subjects: ['orders.>'] })
        .withConsumer({ durable: 'pusher' })); // mode omitted → push (default)
      // No pull consumer was ever fetched.
      expect(mock.mockConn.js.pullConsumers.size).toBe(0);
      actor.tell({ kind: 'fetch', batch: 5, expiresMs: 100 });
      await sleep(20);
      // Still no pull consumer.
      expect(mock.mockConn.js.pullConsumers.size).toBe(0);
    } finally {
      await sys.terminate();
    }
  });
});
