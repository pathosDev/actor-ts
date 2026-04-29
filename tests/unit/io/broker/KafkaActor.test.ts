/**
 * Manual-commit / exactly-once-with-processing tests for KafkaActor (#2).
 *
 * The test seam is `KafkaActor.createKafkaInstance()` — we subclass
 * the actor and return a mock `KafkaInstanceLike` whose consumer/
 * producer are pure JavaScript objects we can drive synchronously.
 * That lets us exercise the manual-commit pump's promise dance
 * without involving kafkajs at all.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import {
  KafkaActor,
  type KafkaActorSettings,
  type KafkaCmd,
  type KafkaConsumerLike,
  type KafkaInstanceLike,
  type KafkaProducerLike,
  type KafkaRecord,
} from '../../../../src/io/broker/KafkaActor.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/* --------------------------- Mocks ----------------------------- */

interface MockMessage {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
}

class MockProducer implements KafkaProducerLike {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(): Promise<unknown> { return undefined; }
}

class MockConsumer implements KafkaConsumerLike {
  /** Records committed via `commitOffsets`, in the order they arrived. */
  readonly committed: Array<{ topic: string; partition: number; offset: string }> = [];
  /** Each `eachMessage` invocation's resolution — `null` while still pending. */
  readonly inflight: Array<{
    msg: MockMessage; promise: Promise<void>;
    resolved: boolean; rejected: boolean; rejectError?: Error;
  }> = [];
  private autoCommit = true;
  private eachMessage: ((m: {
    topic: string; partition: number; message: { offset: string; key: Uint8Array | null; value: Uint8Array | null; timestamp: string; headers?: Record<string, never> };
  }) => Promise<void>) | null = null;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async subscribe(): Promise<void> {}

  async run(args: {
    autoCommit?: boolean;
    eachMessage: (m: {
      topic: string; partition: number; message: { offset: string; key: Uint8Array | null; value: Uint8Array | null; timestamp: string; headers?: Record<string, never> };
    }) => Promise<void>;
  }): Promise<void> {
    this.autoCommit = args.autoCommit ?? true;
    this.eachMessage = args.eachMessage;
  }

  async commitOffsets(
    args: ReadonlyArray<{ topic: string; partition: number; offset: string }>,
  ): Promise<void> {
    for (const a of args) this.committed.push({ ...a });
  }

  /** Drive a message into the pump.  Returns the in-flight tracker. */
  push(topic: string, partition: number, offset: string): typeof this.inflight[number] {
    if (!this.eachMessage) throw new Error('mock consumer: run() not called yet');
    const tracker = {
      msg: { topic, partition, offset },
      promise: Promise.resolve() as Promise<void>,
      resolved: false,
      rejected: false,
      rejectError: undefined as Error | undefined,
    };
    tracker.promise = this.eachMessage({
      topic, partition,
      message: {
        offset, key: null, value: null,
        timestamp: String(Date.now()),
        headers: {},
      },
    }).then(
      () => { tracker.resolved = true; },
      (err: Error) => { tracker.rejected = true; tracker.rejectError = err; },
    );
    this.inflight.push(tracker);
    return tracker;
  }

  /** True iff `args.autoCommit === false` was set in run(). */
  get manualCommitConfigured(): boolean { return !this.autoCommit; }
}

class MockKafka implements KafkaInstanceLike {
  readonly producer_ = new MockProducer();
  readonly consumer_ = new MockConsumer();
  producer(): KafkaProducerLike { return this.producer_; }
  consumer(): KafkaConsumerLike { return this.consumer_; }
}

/** KafkaActor variant that injects a single mock instance. */
class MockKafkaActor extends KafkaActor {
  readonly mock = new MockKafka();
  protected override async createKafkaInstance(): Promise<KafkaInstanceLike> {
    return this.mock;
  }
}

/* --------------------------- Helpers ---------------------------- */

class CapturingTarget extends Actor<KafkaRecord> {
  readonly received: KafkaRecord[] = [];
  override onReceive(rec: KafkaRecord): void { this.received.push(rec); }
}

async function bootActor(
  sys: ActorSystem, settings: Partial<KafkaActorSettings>,
): Promise<{ actor: ActorRef<KafkaCmd>; mock: MockKafka; target: CapturingTarget }> {
  const target = new CapturingTarget();
  const targetRef = sys.actorOf(Props.create(() => target), 'target');
  const ref = { current: null as MockKafkaActor | null };
  const actor = sys.actorOf(
    Props.create(() => {
      const a = new MockKafkaActor({ ...settings, target: targetRef });
      ref.current = a;
      return a;
    }),
    'kafka',
  );
  // Wait until preStart has fired connectImpl + run() registration.
  await sleep(60);
  return { actor: actor as ActorRef<KafkaCmd>, mock: ref.current!.mock, target };
}

/* ============================================================== */
/* Tests                                                          */
/* ============================================================== */

describe('KafkaActor — auto-commit (default)', () => {
  test('eachMessage resolves immediately and no commitOffsets call is made', async () => {
    const sys = ActorSystem.create('kafka-auto', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { mock, target } = await bootActor(sys, {
        brokers: ['fake:9092'],
        consumer: { groupId: 'g1' /* commitMode default = 'auto' */ },
        topics: ['orders'],
      });
      expect(mock.consumer_.manualCommitConfigured).toBe(false);
      const tracker = mock.consumer_.push('orders', 0, '42');
      await tracker.promise;
      expect(tracker.resolved).toBe(true);
      // Tell delivery is async via the mailbox — let it drain.
      await sleep(20);
      expect(target.received).toHaveLength(1);
      expect(target.received[0]!.offset).toBe('42');
      // Auto-mode → kafkajs handles commits internally; no commitOffsets call.
      expect(mock.consumer_.committed).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });
});

describe('KafkaActor — manual commit (#2)', () => {
  test('eachMessage stays pending until a commit command arrives', async () => {
    const sys = ActorSystem.create('kafka-manual', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { actor, mock, target } = await bootActor(sys, {
        brokers: ['fake:9092'],
        consumer: { groupId: 'g1', commitMode: 'manual' },
        topics: ['orders'],
      });
      expect(mock.consumer_.manualCommitConfigured).toBe(true);

      const tracker = mock.consumer_.push('orders', 0, '42');
      await sleep(40);   // mailbox drain + pump enters await
      expect(target.received).toHaveLength(1);
      // Still pending — manual mode hasn't received commit yet.
      expect(tracker.resolved).toBe(false);
      expect(tracker.rejected).toBe(false);

      actor.tell({ kind: 'commit', topic: 'orders', partition: 0, offset: '42' });
      await tracker.promise;
      expect(tracker.resolved).toBe(true);
      // Committed offset is `next` = 43.
      expect(mock.consumer_.committed).toEqual([
        { topic: 'orders', partition: 0, offset: '43' },
      ]);
    } finally {
      await sys.terminate();
    }
  });

  test('nack rejects the pending promise and skips the commit', async () => {
    const sys = ActorSystem.create('kafka-nack', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { actor, mock } = await bootActor(sys, {
        brokers: ['fake:9092'],
        consumer: { groupId: 'g1', commitMode: 'manual' },
        topics: ['orders'],
      });
      const tracker = mock.consumer_.push('orders', 1, '7');
      await sleep(20);
      actor.tell({ kind: 'nack', topic: 'orders', partition: 1, offset: '7', reason: 'bad data' });
      await tracker.promise;
      expect(tracker.rejected).toBe(true);
      expect(tracker.rejectError?.message).toBe('bad data');
      expect(mock.consumer_.committed).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('commit-timeout rejects the pending promise after commitTimeoutMs', async () => {
    const sys = ActorSystem.create('kafka-timeout', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { mock } = await bootActor(sys, {
        brokers: ['fake:9092'],
        consumer: { groupId: 'g1', commitMode: 'manual', commitTimeoutMs: 60 },
        topics: ['orders'],
      });
      const tracker = mock.consumer_.push('orders', 0, '99');
      await tracker.promise;   // wait for the timeout to fire
      expect(tracker.rejected).toBe(true);
      expect(tracker.rejectError?.message).toMatch(/no commit\/nack/);
      expect(mock.consumer_.committed).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('commit for unknown / already-committed offset is a silent no-op', async () => {
    const sys = ActorSystem.create('kafka-unknown', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { actor, mock } = await bootActor(sys, {
        brokers: ['fake:9092'],
        consumer: { groupId: 'g1', commitMode: 'manual' },
        topics: ['orders'],
      });
      // No push — no pending entry.  Commit shouldn't throw.
      actor.tell({ kind: 'commit', topic: 'orders', partition: 0, offset: '0' });
      await sleep(30);
      expect(mock.consumer_.committed).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('multiple in-flight commits across partitions resolve independently', async () => {
    const sys = ActorSystem.create('kafka-multi', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { actor, mock } = await bootActor(sys, {
        brokers: ['fake:9092'],
        consumer: { groupId: 'g1', commitMode: 'manual' },
        topics: ['orders'],
      });
      const t1 = mock.consumer_.push('orders', 0, '10');
      const t2 = mock.consumer_.push('orders', 1, '20');
      const t3 = mock.consumer_.push('orders', 2, '30');
      await sleep(20);
      expect(t1.resolved || t2.resolved || t3.resolved).toBe(false);

      // Commit them out of order to verify the map doesn't care.
      actor.tell({ kind: 'commit', topic: 'orders', partition: 1, offset: '20' });
      actor.tell({ kind: 'commit', topic: 'orders', partition: 2, offset: '30' });
      actor.tell({ kind: 'commit', topic: 'orders', partition: 0, offset: '10' });
      await Promise.all([t1.promise, t2.promise, t3.promise]);
      expect([t1.resolved, t2.resolved, t3.resolved]).toEqual([true, true, true]);
      // Each committed at next-offset.  Order matches the cmd arrival.
      expect(mock.consumer_.committed.map((c) => `${c.partition}:${c.offset}`))
        .toEqual(['1:21', '2:31', '0:11']);
    } finally {
      await sys.terminate();
    }
  });

  test('actor.stop() rejects every pending commit so kafkajs disconnects cleanly', async () => {
    const sys = ActorSystem.create('kafka-stop', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { actor, mock } = await bootActor(sys, {
        brokers: ['fake:9092'],
        consumer: { groupId: 'g1', commitMode: 'manual' },
        topics: ['orders'],
      });
      const t = mock.consumer_.push('orders', 0, '5');
      await sleep(20);
      actor.stop();
      await t.promise;
      expect(t.rejected).toBe(true);
      expect(t.rejectError?.message).toMatch(/disconnecting/);
    } finally {
      await sys.terminate();
    }
  });

  test('large offset values stay exact via BigInt arithmetic', async () => {
    const sys = ActorSystem.create('kafka-bigint', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { actor, mock } = await bootActor(sys, {
        brokers: ['fake:9092'],
        consumer: { groupId: 'g1', commitMode: 'manual' },
        topics: ['orders'],
      });
      // Offset close to Number.MAX_SAFE_INTEGER + a few — Number arithmetic
      // would lose precision; BigInt arithmetic stays exact.
      const big = '9007199254740993';   // 2^53 + 1
      const tracker = mock.consumer_.push('orders', 0, big);
      await sleep(20);
      actor.tell({ kind: 'commit', topic: 'orders', partition: 0, offset: big });
      await tracker.promise;
      expect(mock.consumer_.committed[0]?.offset).toBe('9007199254740994');
    } finally {
      await sys.terminate();
    }
  });
});

describe('KafkaActor — settings parsing', () => {
  test('commitMode + commitTimeoutMs flow through to the consumer pump', async () => {
    const sys = ActorSystem.create('kafka-settings', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const { mock } = await bootActor(sys, {
        brokers: ['x:9092'],
        consumer: { groupId: 'g', commitMode: 'manual', commitTimeoutMs: 100 },
        topics: ['t'],
      });
      // run() must have been called with autoCommit: false.
      expect(mock.consumer_.manualCommitConfigured).toBe(true);
    } finally {
      await sys.terminate();
    }
  });
});
