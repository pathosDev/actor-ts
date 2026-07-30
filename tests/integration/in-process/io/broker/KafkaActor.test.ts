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
import { Actor } from '../../../../../src/Actor.js';
import { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Props } from '../../../../../src/Props.js';
import {
  KafkaActor,
  withAutoHeartbeat,
  type KafkaCommand,
  type KafkaConsumerLike,
  type KafkaInstanceLike,
  type KafkaProducerLike,
  type KafkaRecord,
} from '../../../../../src/io/broker/KafkaActor.js';
import { KafkaOptions, KafkaOptionsBuilder } from '../../../../../src/io/broker/KafkaOptions.js';
import { createTestActorSystem } from '../../../../util/TestActorSystem.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/* --------------------------- Mocks ----------------------------- */

interface MockMessage {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
}

class MockProducer implements KafkaProducerLike {
  disconnected = false;
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> { this.disconnected = true; }
  async send(): Promise<unknown> { return undefined; }
}

class MockConsumer implements KafkaConsumerLike {
  /** Records committed via `commitOffsets`, in the order they arrived. */
  readonly committed: Array<{ topic: string; partition: number; offset: string }> = [];
  /** Each `eachMessage` invocation's resolution — `null` while still pending. */
  readonly inflight: Array<{
    message: MockMessage; promise: Promise<void>;
    resolved: boolean; rejected: boolean; rejectError?: Error;
    /** Number of times the captured heartbeat() callback has fired. */
    heartbeats: number;
  }> = [];
  private autoCommit = true;
  private eachMessage: ((m: {
    topic: string; partition: number; message: { offset: string; key: Uint8Array | null; value: Uint8Array | null; timestamp: string; headers?: Record<string, never> };
    heartbeat?: () => Promise<void>;
  }) => Promise<void>) | null = null;

  /** Every subscribe() this consumer received, in order. */
  readonly subscribed: Array<{ topic: string; fromBeginning: boolean }> = [];
  disconnected = false;

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> { this.disconnected = true; }
  async subscribe(args?: { topic: string; fromBeginning?: boolean }): Promise<void> {
    if (args) this.subscribed.push({ topic: args.topic, fromBeginning: args.fromBeginning ?? false });
  }

  /** Topics this consumer was subscribed to, sorted. */
  get subscribedTopics(): string[] {
    return this.subscribed.map((s) => s.topic).sort();
  }

  async run(args: {
    autoCommit?: boolean;
    eachMessage: (m: {
      topic: string; partition: number; message: { offset: string; key: Uint8Array | null; value: Uint8Array | null; timestamp: string; headers?: Record<string, never> };
      heartbeat?: () => Promise<void>;
    }) => Promise<void>;
  }): Promise<void> {
    this.autoCommit = args.autoCommit ?? true;
    this.eachMessage = args.eachMessage;
  }

  async commitOffsets(
    args: ReadonlyArray<{ topic: string; partition: number; offset: string }>,
  ): Promise<void> {
    for (const actor of args) this.committed.push({ ...actor });
  }

  /** Drive a message into the pump.  Returns the in-flight tracker. */
  push(topic: string, partition: number, offset: string): typeof this.inflight[number] {
    if (!this.eachMessage) throw new Error('mock consumer: run() not called yet');
    const tracker = {
      message: { topic, partition, offset },
      promise: Promise.resolve() as Promise<void>,
      resolved: false,
      rejected: false,
      rejectError: undefined as Error | undefined,
      heartbeats: 0,
    };
    // Record every kafkajs heartbeat() invocation so tests can assert
    // the actor really called through to the broker, not just bumped
    // an internal counter.
    const heartbeat = async (): Promise<void> => { tracker.heartbeats += 1; };
    tracker.promise = this.eachMessage({
      topic, partition,
      message: {
        offset, key: null, value: null,
        timestamp: String(Date.now()),
        headers: {},
      },
      heartbeat,
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
  /**
   * One entry per `producer()` / `consumer()` call.  A reconnect asks
   * for fresh clients, so the list length is the number of connect
   * attempts that got that far — which is how the reconnect tests prove
   * a re-subscribe landed on the *new* consumer.
   */
  readonly producers: MockProducer[] = [];
  readonly consumers: MockConsumer[] = [];

  producer(): KafkaProducerLike {
    const producer = new MockProducer();
    this.producers.push(producer);
    return producer;
  }

  consumer(): KafkaConsumerLike {
    const consumer = new MockConsumer();
    this.consumers.push(consumer);
    return consumer;
  }

  /** The most recent producer — the live one while connected. */
  get producer_(): MockProducer {
    const latest = this.producers[this.producers.length - 1];
    if (!latest) throw new Error('mock kafka: no producer was created');
    return latest;
  }

  /** The most recent consumer — the live one while connected. */
  get consumer_(): MockConsumer {
    const latest = this.consumers[this.consumers.length - 1];
    if (!latest) throw new Error('mock kafka: no consumer was created');
    return latest;
  }
}

/** KafkaActor variant that injects a single mock instance. */
class MockKafkaActor extends KafkaActor {
  readonly mock = new MockKafka();
  protected override async createKafkaInstance(): Promise<KafkaInstanceLike> {
    return this.mock;
  }

  /** Real kafkajs surfaces a drop through a failing send / pump. */
  publicSimulateLoss(): void { this.handleConnectionLost(new Error('simulated broker loss')); }
  publicConnectionState(): string { return this.connectionState; }
}

/* --------------------------- Helpers ---------------------------- */

class CapturingTarget extends Actor<KafkaRecord> {
  readonly received: KafkaRecord[] = [];
  override onReceive(rec: KafkaRecord): void { this.received.push(rec); }
}

async function bootActor(
  sys: ActorSystem, options: KafkaOptionsBuilder,
): Promise<{
  actor: ActorRef<KafkaCommand>; mock: MockKafka;
  target: CapturingTarget; instance: MockKafkaActor;
}> {
  const target = new CapturingTarget();
  const targetRef = sys.spawn(Props.create(() => target), 'target');
  const ref = { current: null as MockKafkaActor | null };
  const actor = sys.spawn(
    Props.create(() => {
      const actor = new MockKafkaActor(options.withTarget(targetRef));
      ref.current = actor;
      return actor;
    }),
    'kafka',
  );
  // Wait until preStart has fired connectImplementation + run() registration.
  await sleep(60);
  return {
    actor: actor as ActorRef<KafkaCommand>, mock: ref.current!.mock,
    target, instance: ref.current!,
  };
}

/** Drop the connection and wait for the reconnect to build fresh clients. */
async function reconnect(instance: MockKafkaActor): Promise<void> {
  const consumerCount = instance.mock.consumers.length;
  instance.publicSimulateLoss();
  for (let i = 0; i < 60 && instance.mock.consumers.length === consumerCount; i++) await sleep(10);
  await sleep(20);
}

/* ============================================================== */
/* Tests                                                          */
/* ============================================================== */

describe('KafkaActor — auto-commit (default)', () => {
  test('eachMessage resolves immediately and no commitOffsets call is made', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('kafka-auto', sysOptions);
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1' /* commitMode default = 'auto' */ })
        .withTopics(['orders']);
      const { mock, target } = await bootActor(sys, kafkaOptions);
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
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('kafka-manual', sysOptions);
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1', commitMode: 'manual' })
        .withTopics(['orders']);
      const { actor, mock, target } = await bootActor(sys, kafkaOptions);
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
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('kafka-nack', sysOptions);
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1', commitMode: 'manual' })
        .withTopics(['orders']);
      const { actor, mock } = await bootActor(sys, kafkaOptions);
      const tracker = mock.consumer_.push('orders', 1, '7');
      await sleep(20);
      actor.tell({ kind: 'negativeAcknowledgment', topic: 'orders', partition: 1, offset: '7', reason: 'bad data' });
      await tracker.promise;
      expect(tracker.rejected).toBe(true);
      expect(tracker.rejectError?.message).toBe('bad data');
      expect(mock.consumer_.committed).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('commit-timeout rejects the pending promise after commitTimeoutMs', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('kafka-timeout', sysOptions);
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1', commitMode: 'manual', commitTimeoutMs: 60 })
        .withTopics(['orders']);
      const { mock } = await bootActor(sys, kafkaOptions);
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
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('kafka-unknown', sysOptions);
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1', commitMode: 'manual' })
        .withTopics(['orders']);
      const { actor, mock } = await bootActor(sys, kafkaOptions);
      // No push — no pending entry.  Commit shouldn't throw.
      actor.tell({ kind: 'commit', topic: 'orders', partition: 0, offset: '0' });
      await sleep(30);
      expect(mock.consumer_.committed).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('multiple in-flight commits across partitions resolve independently', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('kafka-multi', sysOptions);
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1', commitMode: 'manual' })
        .withTopics(['orders']);
      const { actor, mock } = await bootActor(sys, kafkaOptions);
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
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('kafka-stop', sysOptions);
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1', commitMode: 'manual' })
        .withTopics(['orders']);
      const { actor, mock } = await bootActor(sys, kafkaOptions);
      const pushed = mock.consumer_.push('orders', 0, '5');
      await sleep(20);
      actor.stop();
      await pushed.promise;
      expect(pushed.rejected).toBe(true);
      expect(pushed.rejectError?.message).toMatch(/disconnecting/);
    } finally {
      await sys.terminate();
    }
  });

  test('large offset values stay exact via BigInt arithmetic', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('kafka-bigint', sysOptions);
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1', commitMode: 'manual' })
        .withTopics(['orders']);
      const { actor, mock } = await bootActor(sys, kafkaOptions);
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

describe('KafkaActor — options parsing', () => {
  test('commitMode + commitTimeoutMs flow through to the consumer pump', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('kafka-options', sysOptions);
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['x:9092'])
        .withConsumer({ groupId: 'g', commitMode: 'manual', commitTimeoutMs: 100 })
        .withTopics(['t']);
      const { mock } = await bootActor(sys, kafkaOptions);
      // run() must have been called with autoCommit: false.
      expect(mock.consumer_.manualCommitConfigured).toBe(true);
    } finally {
      await sys.terminate();
    }
  });
});

describe('KafkaActor — subscriptions across a reconnect (#504)', () => {
  test('configured topics are subscribed with the configured fromBeginning', async () => {
    const sys = createTestActorSystem({ name: 'kafka-sub-config' });
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1', fromBeginning: true })
        .withTopics(['orders', 'invoices']);
      const { mock } = await bootActor(sys, kafkaOptions);
      expect(mock.consumer_.subscribed).toEqual([
        { topic: 'orders', fromBeginning: true },
        { topic: 'invoices', fromBeginning: true },
      ]);
    } finally {
      await sys.terminate();
    }
  });

  test('configured topics are re-subscribed on the reconnect consumer', async () => {
    const sys = createTestActorSystem({ name: 'kafka-sub-reconnect' });
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1' })
        .withTopics(['orders'])
        .withReconnect({ initialDelayMs: 10, maxDelayMs: 20, factor: 1 });
      const { mock, instance } = await bootActor(sys, kafkaOptions);
      const firstConsumer = mock.consumer_;
      const firstProducer = mock.producer_;

      await reconnect(instance);
      expect(instance.publicConnectionState()).toBe('connected');
      expect(mock.consumers).toHaveLength(2);
      // The dead clients were disconnected rather than leaked (#504).
      expect(firstConsumer.disconnected).toBe(true);
      expect(firstProducer.disconnected).toBe(true);
      expect(mock.consumer_.subscribedTopics).toEqual(['orders']);
    } finally {
      await sys.terminate();
    }
  });

  test('a topic added at runtime survives a reconnect', async () => {
    const sys = createTestActorSystem({ name: 'kafka-sub-runtime' });
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1' })
        .withTopics(['orders'])
        .withReconnect({ initialDelayMs: 10, maxDelayMs: 20, factor: 1 });
      const { actor, mock, instance } = await bootActor(sys, kafkaOptions);

      actor.tell({ kind: 'subscribe', topic: 'audit' });
      await sleep(30);
      expect(mock.consumer_.subscribedTopics).toEqual(['audit', 'orders']);

      await reconnect(instance);
      expect(mock.consumers).toHaveLength(2);
      expect(mock.consumer_.subscribedTopics).toEqual(['audit', 'orders']);
    } finally {
      await sys.terminate();
    }
  });

  test('a subscribe issued while disconnected lands on the next connect', async () => {
    const sys = createTestActorSystem({ name: 'kafka-sub-offline' });
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1' })
        .withTopics(['orders'])
        .withReconnect({ initialDelayMs: 80, maxDelayMs: 80, factor: 1 });
      const { actor, mock, instance } = await bootActor(sys, kafkaOptions);

      instance.publicSimulateLoss();
      expect(instance.publicConnectionState()).toBe('disconnected');
      actor.tell({ kind: 'subscribe', topic: 'audit' });
      await sleep(20);

      for (let i = 0; i < 40 && mock.consumers.length < 2; i++) await sleep(10);
      await sleep(20);
      expect(instance.publicConnectionState()).toBe('connected');
      // Not dropped on the floor while offline — applied on the reconnect.
      expect(mock.consumer_.subscribedTopics).toEqual(['audit', 'orders']);
    } finally {
      await sys.terminate();
    }
  });

  test('every subscribe is in before run() so kafkajs sees the full set', async () => {
    const sys = createTestActorSystem({ name: 'kafka-sub-order' });
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1' })
        .withTopics(['a', 'b', 'c']);
      const { mock } = await bootActor(sys, kafkaOptions);
      // run() captures eachMessage — a push only works once it has been
      // called, and the subscriptions must already be recorded by then.
      expect(mock.consumer_.subscribedTopics).toEqual(['a', 'b', 'c']);
      expect(() => mock.consumer_.push('a', 0, '1')).not.toThrow();
    } finally {
      await sys.terminate();
    }
  });
});

describe('KafkaActor — heartbeat (#78)', () => {
  test('heartbeat command forwards to the captured kafkajs callback', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('kafka-hb-1', sysOptions);
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1', commitMode: 'manual', commitTimeoutMs: 1_000 })
        .withTopics(['orders']);
      const { actor, mock } = await bootActor(sys, kafkaOptions);
      const tracker = mock.consumer_.push('orders', 0, '7');
      await sleep(20);

      // Three heartbeats while the handler is "busy".
      actor.tell({ kind: 'heartbeat', topic: 'orders', partition: 0, offset: '7' });
      actor.tell({ kind: 'heartbeat', topic: 'orders', partition: 0, offset: '7' });
      actor.tell({ kind: 'heartbeat', topic: 'orders', partition: 0, offset: '7' });
      await sleep(30);
      expect(tracker.heartbeats).toBe(3);

      // Commit completes the in-flight cleanly — heartbeat must not have
      // affected offset state.
      actor.tell({ kind: 'commit', topic: 'orders', partition: 0, offset: '7' });
      await tracker.promise;
      expect(tracker.resolved).toBe(true);
      expect(mock.consumer_.committed).toEqual([{ topic: 'orders', partition: 0, offset: '8' }]);
    } finally {
      await sys.terminate();
    }
  });

  test('heartbeat for an unknown / already-committed offset is a silent no-op', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('kafka-hb-2', sysOptions);
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1', commitMode: 'manual' })
        .withTopics(['orders']);
      const { actor, mock } = await bootActor(sys, kafkaOptions);
      // No push — pendingCommits is empty.  Stray heartbeats from a
      // racing handler must not crash the actor.
      actor.tell({ kind: 'heartbeat', topic: 'orders', partition: 0, offset: '999' });
      actor.tell({ kind: 'heartbeat', topic: 'unknown', partition: 5, offset: '0' });
      await sleep(20);
      expect(mock.consumer_.committed).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('withAutoHeartbeat schedules periodic heartbeats and clears on completion', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('kafka-hb-3', sysOptions);
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1', commitMode: 'manual', commitTimeoutMs: 1_000 })
        .withTopics(['orders']);
      const { actor, mock } = await bootActor(sys, kafkaOptions);
      const tracker = mock.consumer_.push('orders', 0, '11');
      await sleep(20);

      // Tight 25ms cadence so a 120ms body fires ~4-5 heartbeats.
      const result = await withAutoHeartbeat(
        { kafka: actor, record: { topic: 'orders', partition: 0, offset: '11' }, everyMs: 25 },
        async () => { await sleep(120); return 'done'; },
      );
      expect(result).toBe('done');
      // Heartbeats fire on a setInterval — count is approximate but
      // must be >= 3 (otherwise the helper's not actually firing).
      expect(tracker.heartbeats).toBeGreaterThanOrEqual(3);

      actor.tell({ kind: 'commit', topic: 'orders', partition: 0, offset: '11' });
      await tracker.promise;
      // After commit the timer is gone — wait a full cadence and
      // verify no more heartbeats fired.
      const finalCount = tracker.heartbeats;
      await sleep(60);
      expect(tracker.heartbeats).toBe(finalCount);
    } finally {
      await sys.terminate();
    }
  });

  test('withAutoHeartbeat clears the timer when the body throws', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('kafka-hb-4', sysOptions);
    try {
      const kafkaOptions = KafkaOptions.create()
        .withBrokers(['fake:9092'])
        .withConsumer({ groupId: 'g1', commitMode: 'manual' })
        .withTopics(['orders']);
      const { actor, mock } = await bootActor(sys, kafkaOptions);
      const tracker = mock.consumer_.push('orders', 0, '13');
      await sleep(20);

      await expect(withAutoHeartbeat(
        { kafka: actor, record: { topic: 'orders', partition: 0, offset: '13' }, everyMs: 20 },
        async () => { await sleep(50); throw new Error('boom'); },
      )).rejects.toThrow('boom');

      // Brief drain so any heartbeat `tell()`s already on the actor's
      // mailbox at throw-time finish processing before we sample.
      await sleep(30);
      const countAfterDrain = tracker.heartbeats;
      // Timer must be cleared even on throw — otherwise a lingering
      // setInterval would keep telling heartbeats forever.  After
      // another full cadence, the counter must stay flat.
      await sleep(60);
      expect(tracker.heartbeats).toBe(countAfterDrain);

      actor.tell({ kind: 'negativeAcknowledgment', topic: 'orders', partition: 0, offset: '13' });
      await tracker.promise;
      expect(tracker.rejected).toBe(true);
    } finally {
      await sys.terminate();
    }
  });
});
