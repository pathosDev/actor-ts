import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Props } from '../../../src/Props.js';
import { ReliableDelivery } from '../../../src/delivery/index.js';
import type { Delivery } from '../../../src/delivery/index.js';
import { TestKit } from '../../../src/testkit/TestKit.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('ReliableDelivery — happy path', () => {
  test('producer → consumer delivers every message exactly once', async () => {
    const kit = TestKit.create('rd-hp', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const received: string[] = [];

    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: (m) => { received.push(m); },
    });
    const producer = ReliableDelivery.producer<string>(kit.system, {
      consumer: consumer.ref as never,
      resendTimeoutMs: 200, windowSize: 4,
    });

    for (const s of ['a', 'b', 'c']) producer.tell(s);
    await sleep(80);

    expect(received).toEqual(['a', 'b', 'c']);
    producer.stop(); consumer.stop();
    await kit.system.terminate();
  });

  test('confirm callback fires once per message after the ack', async () => {
    const kit = TestKit.create('rd-confirm', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const confirmed: Array<{ body: string; err: Error | null }> = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, { handler: () => {} });
    const producer = ReliableDelivery.producer<string>(kit.system, {
      consumer: consumer.ref as never, resendTimeoutMs: 200,
    });

    for (const s of ['x', 'y', 'z']) {
      producer.tell(s, (err) => confirmed.push({ body: s, err }));
    }

    await sleep(80);
    expect(confirmed).toHaveLength(3);
    expect(confirmed.every(c => c.err === null)).toBe(true);
    producer.stop(); consumer.stop();
    await kit.system.terminate();
  });
});

describe('ReliableDelivery — resilience', () => {
  test('consumer dedups a redelivered (same-seq) message', async () => {
    const kit = TestKit.create('rd-dedup', { logger: new NoopLogger(), logLevel: LogLevel.Off });
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
    await sleep(20);
    consumer.ref.tell({ ...dup1, body: 'twice-but-same-seq' } as never);
    await sleep(20);

    expect(received).toEqual(['once']); // second was deduped
    // Both deliveries should have produced an Ack message to selfProbe.
    const a1 = await selfProbe.receiveOne(200);
    const a2 = await selfProbe.receiveOne(200);
    expect((a1 as { kind: string }).kind).toBe('reliable-delivery.ack');
    expect((a2 as { kind: string }).kind).toBe('reliable-delivery.ack');

    consumer.stop();
    await kit.system.terminate();
  });

  test('producer re-sends when no ack arrives', async () => {
    const kit = TestKit.create('rd-resend', { logger: new NoopLogger(), logLevel: LogLevel.Off });

    // Flaky consumer that drops the first 2 deliveries.
    let seen = 0;
    let delivered: string | null = null;
    class Flaky extends Actor<Delivery<string>> {
      override onReceive(d: Delivery<string>): void {
        seen++;
        if (seen < 3) return; // drop
        delivered = d.body;
        // Ack manually to match ConsumerController's protocol.
        d.replyTo.tell({ kind: 'reliable-delivery.ack', producerId: d.producerId, seq: d.seq });
      }
    }
    const consumerRef = kit.system.actorOf(Props.create(() => new Flaky()), 'flaky');

    const producer = ReliableDelivery.producer<string>(kit.system, {
      consumer: consumerRef,
      resendTimeoutMs: 40,
    });
    producer.tell('persistent-message');

    // Give the producer time to resend until the 3rd attempt succeeds.
    await sleep(200);
    expect(seen).toBeGreaterThanOrEqual(3);
    expect(delivered).toBe('persistent-message');
    producer.stop();
    await kit.system.terminate();
  });
});

describe('ReliableDelivery — flow control', () => {
  test('messages beyond windowSize queue and drain as acks arrive', async () => {
    const kit = TestKit.create('rd-window', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const received: string[] = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: async (m) => {
        await sleep(10); // slow handler — creates back-pressure
        received.push(m);
      },
    });
    const producer = ReliableDelivery.producer<string>(kit.system, {
      consumer: consumer.ref as never, resendTimeoutMs: 500, windowSize: 2,
    });

    const N = 6;
    for (let i = 0; i < N; i++) producer.tell(`m-${i}`);

    // Even with a tiny window, all messages eventually arrive in order.
    const deadline = Date.now() + 1_500;
    while (received.length < N && Date.now() < deadline) await sleep(20);
    expect(received).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5']);

    producer.stop(); consumer.stop();
    await kit.system.terminate();
  });
});
