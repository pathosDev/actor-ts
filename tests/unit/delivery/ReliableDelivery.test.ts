import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ReliableDelivery, ProducerControllerOptions } from '../../../src/delivery/index.js';
import type { Delivery } from '../../../src/delivery/index.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('ReliableDelivery — happy path', () => {
  test('producer → consumer delivers every message exactly once', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('rd-hp', kitOptions);
    const received: string[] = [];

    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: (m) => { received.push(m); },
    });
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(consumer.ref as never)
      .withResendTimeout(200)
      .withWindowSize(4);
    const producer = ReliableDelivery.producer<string>(kit.system,
      producerOptions,
    );

    for (const s of ['a', 'b', 'c']) producer.tell(s);
    await awaitCondition(() => received.length === 3, {
      timeoutMs: 4_000,
      label: 'all three messages reached the consumer',
    });

    expect(received).toEqual(['a', 'b', 'c']);
    producer.stop(); consumer.stop();
    await kit.system.terminate();
  });

  test('confirm callback fires once per message after the ack', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('rd-confirm', kitOptions);
    const confirmed: Array<{ body: string; err: Error | null }> = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, { handler: () => {} });
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(consumer.ref as never)
      .withResendTimeout(200);
    const producer = ReliableDelivery.producer<string>(kit.system,
      producerOptions,
    );

    for (const s of ['x', 'y', 'z']) {
      producer.tell(s, (err) => confirmed.push({ body: s, err }));
    }

    await awaitCondition(() => confirmed.length === 3, {
      timeoutMs: 4_000,
      label: 'all three sends were confirmed',
    });
    expect(confirmed).toHaveLength(3);
    expect(confirmed.every(c => c.err === null)).toBe(true);
    producer.stop(); consumer.stop();
    await kit.system.terminate();
  });
});

describe('ReliableDelivery — resilience', () => {
  test('consumer dedups a redelivered (same-seq) message', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('rd-dedup', kitOptions);
    const received: string[] = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: (m) => { received.push(m); },
    });

    // Build a synthetic delivery and send it twice under the same seq.
    const selfProbe = kit.createTestProbe();
    const dup1: Delivery<string> = {
      kind: 'reliable-delivery.delivery',
      producerId: 'test-producer',
      seq: 1,
      body: 'once',
      replyTo: selfProbe as never,
    };
    consumer.ref.tell(dup1 as never);
    // The duplicate only exercises dedup if the original was handled first —
    // it carries a different body, so an early second delivery would be
    // recorded and the test would fail on the wrong thing.
    await awaitCondition(() => received.length === 1, {
      timeoutMs: 4_000,
      label: 'the first delivery was handled',
    });
    consumer.ref.tell({ ...dup1, body: 'twice-but-same-seq' } as never);
    // Both deliveries acknowledge, so two acks is the end of the sequence.
    await awaitCondition(() => selfProbe.messageCount === 2, {
      timeoutMs: 4_000,
      label: 'both deliveries were acknowledged',
    });

    expect(received).toEqual(['once']); // second was deduped
    // Both deliveries should have produced an Acknowledgment message to selfProbe.
    const a1 = await selfProbe.receiveOne(200);
    const a2 = await selfProbe.receiveOne(200);
    expect((a1 as { kind: string }).kind).toBe('reliable-delivery.ack');
    expect((a2 as { kind: string }).kind).toBe('reliable-delivery.ack');

    consumer.stop();
    await kit.system.terminate();
  });

  test('producer re-sends when no ack arrives', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('rd-resend', kitOptions);

    // Flaky consumer that drops the first 2 deliveries.
    let seen = 0;
    let delivered: string | null = null;
    class Flaky extends Actor<Delivery<string>> {
      override onReceive(d: Delivery<string>): void {
        seen++;
        if (seen < 3) return; // drop
        delivered = d.body;
        // Acknowledgment manually to match ConsumerController's protocol.
        d.replyTo.tell({ kind: 'reliable-delivery.ack', producerId: d.producerId, seq: d.seq });
      }
    }
    const consumerRef = kit.system.spawn(Flaky, 'flaky');

    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(consumerRef)
      .withResendTimeout(40);
    const producer = ReliableDelivery.producer<string>(kit.system,
      producerOptions,
    );
    producer.tell('persistent-message');

    // Wait for the third attempt to land rather than budgeting 200 ms for a
    // 40 ms resend timer to fire five times.
    await awaitCondition(() => delivered !== null, {
      timeoutMs: 4_000,
      label: 'a resend finally got through to the flaky consumer',
    });
    expect(seen).toBeGreaterThanOrEqual(3);
    expect(delivered).toBe('persistent-message');
    producer.stop();
    await kit.system.terminate();
  });
});

describe('ReliableDelivery — flow control', () => {
  test('messages beyond windowSize queue and drain as acks arrive', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('rd-window', kitOptions);
    const received: string[] = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: async (m) => {
        await sleep(10); // slow handler — creates back-pressure
        received.push(m);
      },
    });
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(consumer.ref as never)
      .withResendTimeout(500)
      .withWindowSize(2);
    const producer = ReliableDelivery.producer<string>(kit.system,
      producerOptions,
    );

    const N = 6;
    for (let i = 0; i < N; i++) producer.tell(`m-${i}`);

    // Even with a tiny window, all messages eventually arrive in order.
    await awaitCondition(() => received.length === N, {
      timeoutMs: 4_000,
      intervalMs: 20,
      label: 'every message drained through the two-message window',
    });
    expect(received).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5']);

    producer.stop(); consumer.stop();
    await kit.system.terminate();
  });
});

describe('ReliableDelivery — shutdown (#451)', () => {
  test('stopping the producer settles in-flight sends, not only queued ones', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('rd-stop-inflight', kitOptions);
    const confirmed: Array<{ body: string; err: Error | null }> = [];

    // A probe stands in for the consumer so nothing is ever acked.  With a
    // window of 2 the first two sends sit in-flight and the other two queue
    // behind them — covering both collections `postStop` has to drain.
    const neverAcknowledges = kit.createTestProbe();
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(neverAcknowledges as never)
      .withResendTimeout(10_000)
      .withWindowSize(2);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);

    for (const s of ['a', 'b', 'c', 'd']) {
      producer.tell(s, (err) => confirmed.push({ body: s, err }));
    }
    // The window is two, so two arrive and stop — waiting for the third that
    // must not come is what the settle below is for.
    await awaitCondition(() => neverAcknowledges.messageCount === 2, {
      timeoutMs: 4_000,
      label: 'the window-sized batch reached the consumer',
    });
    await sleep(30);

    // Two delivered and awaiting an ack that never comes, two still queued.
    expect(neverAcknowledges.messageCount).toBe(2);
    expect(confirmed).toHaveLength(0);

    producer.stop();
    await awaitCondition(() => confirmed.length === 4, {
      timeoutMs: 4_000,
      label: 'every send — queued and in-flight — was called back',
    });

    // Before the fix this was 2 — the queued sends only.  The two in-flight
    // callers were never called back at all and waited forever.
    expect(confirmed).toHaveLength(4);
    expect(confirmed.map(c => c.body).sort()).toEqual(['a', 'b', 'c', 'd']);
    for (const c of confirmed) {
      expect(c.err).toBeInstanceOf(Error);
      expect(c.err?.message).toBe('producer stopped');
    }

    await kit.system.terminate();
  });
});

describe('ReliableDelivery — generated controller names', () => {
  const GENERATED = /^(consumer|producer)-\d+-[0-9a-f]{12}$/;

  const newKit = (name: string): TestKit => TestKit.create(name, TestKitOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off));

  test('an unnamed controller gets a counter and a random suffix', async () => {
    // These names become actor names under /system/delivery/, so they become
    // paths — and a path is an address.  `consumer-1` was the first one of
    // every run; the random half is what stops that being an address anyone
    // can derive.
    const kit = newKit('rd-generated');

    const consumer = ReliableDelivery.consumer<string>(kit.system, { handler: () => {} });
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(consumer.ref as never);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);

    expect(consumer.ref.path.name).toMatch(GENERATED);
    expect(producer.ref.path.name).toMatch(GENERATED);
    expect(consumer.ref.path.name.startsWith('consumer-')).toBe(true);
    expect(producer.ref.path.name.startsWith('producer-')).toBe(true);

    producer.stop(); consumer.stop();
    await kit.system.terminate();
  });

  test('an explicit name is still used verbatim', async () => {
    const kit = newKit('rd-explicit-name');
    const consumer = ReliableDelivery.consumer<string>(kit.system, { handler: () => {} }, 'my-consumer');
    expect(consumer.ref.path.name).toBe('my-consumer');
    consumer.stop();
    await kit.system.terminate();
  });

  test('two unnamed consumers do not collide, in one system or across two', async () => {
    // The counter alone made these unique per process, not per system — two
    // systems in one process drew from the same sequence.  The random half is
    // what actually separates them now.
    const first = newKit('rd-names-a');
    const second = newKit('rd-names-b');

    const names = [
      ReliableDelivery.consumer<string>(first.system, { handler: () => {} }).ref.path.name,
      ReliableDelivery.consumer<string>(first.system, { handler: () => {} }).ref.path.name,
      ReliableDelivery.consumer<string>(second.system, { handler: () => {} }).ref.path.name,
    ];

    for (const name of names) expect(name).toMatch(GENERATED);
    expect(new Set(names).size).toBe(3);
    // Random halves, not just the counters, must differ.
    expect(new Set(names.map((n) => n.slice(n.lastIndexOf('-') + 1))).size).toBe(3);

    await first.system.terminate();
    await second.system.terminate();
  });
});
