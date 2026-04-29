/**
 * Unit tests for JetStreamActor (#3) — push consumer + ack/nak/term
 * handshake.  Same test-seam pattern as KafkaActor (#2): subclass
 * JetStreamActor and override `createNatsConnection` to inject a
 * pure-JS mock.  Lets us drive the manual-ack pump without involving
 * the real `nats` peer-dep.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import {
  JetStreamActor,
  type JetStreamActorSettings,
  type JetStreamClientLike,
  type JetStreamCmd,
  type JetStreamManagerLike,
  type JetStreamMessage,
  type JetStreamMsgHandleLike,
  type JetStreamSubscriptionLike,
  type NatsConnectionLike,
} from '../../../../src/io/broker/JetStreamActor.js';

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

class MockJetStream implements JetStreamClientLike {
  readonly published: Array<{
    subject: string; payload: Uint8Array;
    msgID?: string; expectLastSeq?: number; headers?: Record<string, string>;
  }> = [];
  readonly subscription = new MockSubscription();
  readonly subscribeCalls: Array<{ subject: string; stream: string; consumer: string }> = [];

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
  sys: ActorSystem, settings: Partial<JetStreamActorSettings>,
): Promise<{ actor: ActorRef<JetStreamCmd>; mock: MockJetStreamActor; target: CapturingTarget }> {
  const target = new CapturingTarget();
  const targetRef = sys.actorOf(Props.create(() => target), 'target');
  const ref = { current: null as MockJetStreamActor | null };
  const actor = sys.actorOf(
    Props.create(() => {
      const a = new MockJetStreamActor({ ...settings, target: targetRef });
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
    const sys = ActorSystem.create('js-lifecycle', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { mock } = await bootActor(sys, {
        servers: ['nats://fake:4222'],
        stream: { name: 'ORDERS', subjects: ['orders.>'] },
        consumer: { durable: 'order-proc', ackWaitMs: 5_000 },
      });
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
    const sys = ActorSystem.create('js-noupsert', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { mock } = await bootActor(sys, {
        servers: ['nats://fake:4222'],
        stream: { name: 'EVENTS', subjects: ['events.>'], create: false },
        consumer: { durable: 'd', create: false },
      });
      expect(mock.mockConn.jsm.streamsAdd).toEqual([]);
      expect(mock.mockConn.jsm.consumersAdd).toEqual([]);
      // Subscribe should still have happened.
      expect(mock.mockConn.js.subscribeCalls).toHaveLength(1);
    } finally {
      await sys.terminate();
    }
  });

  test('byStartSeq deliverPolicy translates correctly', async () => {
    const sys = ActorSystem.create('js-policy', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { mock } = await bootActor(sys, {
        servers: ['nats://fake:4222'],
        stream: { name: 'S', subjects: ['s.>'] },
        consumer: { durable: 'd', deliverPolicy: { kind: 'byStartSeq', startSeq: 100 } },
      });
      expect(mock.mockConn.jsm.consumersAdd[0]?.deliver_policy).toBe('by_start_sequence');
    } finally {
      await sys.terminate();
    }
  });
});

describe('JetStreamActor — ack/nak/term', () => {
  test('ack acknowledges the handle and resolves the pump', async () => {
    const sys = ActorSystem.create('js-ack', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { actor, mock, target } = await bootActor(sys, {
        servers: ['nats://fake:4222'],
        stream: { name: 'S', subjects: ['s.>'] },
        consumer: { durable: 'd', ackWaitMs: 5_000 },
      });
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
    const sys = ActorSystem.create('js-nak', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { actor, mock } = await bootActor(sys, {
        servers: ['nats://fake:4222'],
        stream: { name: 'S', subjects: ['s.>'] },
        consumer: { durable: 'd' },
      });
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
    const sys = ActorSystem.create('js-term', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { actor, mock } = await bootActor(sys, {
        servers: ['nats://fake:4222'],
        stream: { name: 'S', subjects: ['s.>'] },
        consumer: { durable: 'd' },
      });
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
    const sys = ActorSystem.create('js-inprog', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { actor, mock } = await bootActor(sys, {
        servers: ['nats://fake:4222'],
        stream: { name: 'S', subjects: ['s.>'] },
        consumer: { durable: 'd' },
      });
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
    const sys = ActorSystem.create('js-timeout', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { mock, target } = await bootActor(sys, {
        servers: ['nats://fake:4222'],
        stream: { name: 'S', subjects: ['s.>'] },
        consumer: { durable: 'd', ackWaitMs: 60 },
        ackTimeoutMs: 60,
      });
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
    const sys = ActorSystem.create('js-none', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { mock, target } = await bootActor(sys, {
        servers: ['nats://fake:4222'],
        stream: { name: 'S', subjects: ['s.>'] },
        consumer: { durable: 'd', ackPolicy: 'none' },
      });
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
    const sys = ActorSystem.create('js-unknown', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { actor } = await bootActor(sys, {
        servers: ['nats://fake:4222'],
        stream: { name: 'S', subjects: ['s.>'] },
        consumer: { durable: 'd' },
      });
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
    const sys = ActorSystem.create('js-pub', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { actor, mock } = await bootActor(sys, {
        servers: ['nats://fake:4222'],
        // No consumer — pure producer.
      });
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
    const sys = ActorSystem.create('js-wiring', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { mock } = await bootActor(sys, {
        servers: ['nats://fake:4222'],
        stream: { name: 'BILLING', subjects: ['billing.>'] },
        consumer: { durable: 'billing-proc', filterSubject: 'billing.charges' },
      });
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
