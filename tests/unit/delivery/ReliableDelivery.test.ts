import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ActorRestarted, DeadLetter } from '../../../src/SystemMessages.js';
import {
  ReliableDelivery,
  ProducerControllerOptions,
  ProducerControllerOptionsBuilder,
  MAX_DELIVERY_IDENTIFIER_LENGTH,
} from '../../../src/delivery/index.js';
import type { Delivery } from '../../../src/delivery/index.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/** A silent TestKit — every case here would otherwise log its own warnings. */
const quietKit = (name: string): TestKit => TestKit.create(name, TestKitOptions.create()
  .withLogger(new NoopLogger())
  .withLogLevel(LogLevel.Off));

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
      incarnation: 'test-incarnation',
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
        // Acknowledgment manually to match ConsumerController's protocol —
        // including echoing the incarnation, without which the producer
        // rejects it as unauthenticated (#730).
        d.replyTo.tell({
          kind: 'reliable-delivery.ack',
          producerId: d.producerId,
          incarnation: d.incarnation,
          seq: d.seq,
        });
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
    // Explicit `expect<T>`: the only writer is the actor's `onReceive`, a
    // nested function, so the compiler's flow analysis still has `delivered`
    // at its `null` initialiser here.  The `awaitCondition` above is the
    // runtime proof it is not.
    expect<string | null>(delivered).toBe('persistent-message');
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

describe('ReliableDelivery — producer restart (#726)', () => {
  test('a re-created producer with the same producerId is not absorbed as duplicates', async () => {
    // No crash and no supervision needed: stop-and-recreate is the plainest
    // application pattern there is, and `nextSeq` is an instance field with no
    // seed while `producerId` comes off the captured options object — so the
    // second controller numbers from 1 again against a consumer whose dedup
    // entry for that id never went away.
    const kit = quietKit('rd-restart-recreate');
    const received: string[] = [];
    const confirmedDelivered: string[] = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: (m) => { received.push(m); },
    });
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(consumer.ref as never)
      .withProducerId('orders')
      .withResendTimeout(200)
      .withWindowSize(4);

    const first = ReliableDelivery.producer<string>(kit.system, producerOptions, 'orders-first');
    for (const s of ['a', 'b', 'c']) {
      first.tell(s, (err) => { if (err === null) confirmedDelivered.push(s); });
    }
    await awaitCondition(() => confirmedDelivered.length === 3, {
      timeoutMs: 4_000,
      label: 'the first incarnation delivered and confirmed three messages',
    });
    first.stop();

    const second = ReliableDelivery.producer<string>(kit.system, producerOptions, 'orders-second');
    for (const s of ['d', 'e', 'f']) {
      second.tell(s, (err) => { if (err === null) confirmedDelivered.push(s); });
    }
    await awaitCondition(() => received.length === 6, {
      timeoutMs: 4_000,
      label: 'the second incarnation reached the handler too',
    });
    expect(received).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);

    // The worst symptom was not the loss, it was the lie: an absorbed message
    // is answered with an ordinary ack, so `confirm(null)` reported success
    // for a body the handler never saw.  Every confirmed body must be one the
    // handler actually ran.
    await awaitCondition(() => confirmedDelivered.length === 6, {
      timeoutMs: 4_000,
      label: 'both incarnations confirmed all six sends',
    });
    for (const body of confirmedDelivered) expect(received).toContain(body);

    second.stop(); consumer.stop();
    await kit.system.terminate();
  });

  test('a supervised restart of the producer does not silently absorb what follows', async () => {
    // The trigger is ordinary: `onAcknowledgment` runs the caller's `confirm`
    // synchronously inside `onReceive`, so a throwing callback faults the
    // producer.  The default strategy is one-for-one, so only the producer is
    // recreated and the consumer keeps its dedup entry — which is the exact
    // shape the issue describes.
    const kit = quietKit('rd-restart-supervised');
    const received: string[] = [];
    const restarts: string[] = [];
    const subscribed = { value: false };

    class RestartListener extends Actor<ActorRestarted> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, ActorRestarted);
        subscribed.value = true;
      }
      override onReceive(event: ActorRestarted): void { restarts.push(event.actor.path.toString()); }
    }
    kit.system.spawn(RestartListener, 'restart-listener');
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 4_000,
      label: 'the restart listener subscribed to the event stream',
    });

    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: (m) => { received.push(m); },
    });
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(consumer.ref as never)
      .withProducerId('orders')
      .withResendTimeout(2_000)
      .withWindowSize(4);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions, 'orders-supervised');
    const producerPath = producer.ref.path.toString();

    let blewUp = false;
    producer.tell('before', () => {
      if (blewUp) return;
      blewUp = true;
      throw new Error('confirmation callback blew up');
    });

    // Assert the restart really happened.  Without this the test would pass
    // just as happily if the producer had never faulted at all, which is the
    // one thing that would make it prove nothing.
    await awaitCondition(() => restarts.includes(producerPath), {
      timeoutMs: 4_000,
      label: 'the throwing confirmation callback restarted the producer',
    });
    expect(received).toEqual(['before']);

    producer.tell('after-1');
    producer.tell('after-2');
    await awaitCondition(() => received.length === 3, {
      timeoutMs: 4_000,
      label: 'the restarted producer still reached the handler',
    });
    expect(received).toEqual(['before', 'after-1', 'after-2']);

    producer.stop(); consumer.stop();
    await kit.system.terminate();
  });

  test('the same seq from a different incarnation is fresh; from the same one it is a duplicate', async () => {
    // The discriminating case.  A guard keyed on `producerId` alone cannot
    // tell these two apart, so a fix that only widened the *value* stored
    // under the key would pass the suite above and fail here.
    const kit = quietKit('rd-incarnation-key');
    const received: string[] = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: (m) => { received.push(m); },
    });
    const probe = kit.createTestProbe();
    const base = {
      kind: 'reliable-delivery.delivery',
      producerId: 'orders',
      seq: 1,
      replyTo: probe as never,
    } as const;

    consumer.ref.tell({ ...base, incarnation: 'first', body: 'from-first' } as never);
    await awaitCondition(() => received.length === 1, {
      timeoutMs: 4_000,
      label: 'the first incarnation delivery was handled',
    });

    consumer.ref.tell({ ...base, incarnation: 'second', body: 'from-second' } as never);
    await awaitCondition(() => received.length === 2, {
      timeoutMs: 4_000,
      label: 'the second incarnation is not treated as a duplicate of the first',
    });
    expect(received).toEqual(['from-first', 'from-second']);

    // The property the fix must not break: a genuine retransmit — same
    // incarnation, same seq — is still absorbed and still re-acked, so the
    // producer can release its window slot.
    consumer.ref.tell({ ...base, incarnation: 'second', body: 'retransmitted' } as never);
    await awaitCondition(() => probe.messageCount === 3, {
      timeoutMs: 4_000,
      label: 'all three deliveries were acknowledged',
    });
    await sleep(30);
    expect(received).toEqual(['from-first', 'from-second']);

    consumer.stop();
    await kit.system.terminate();
  });
});

describe('ReliableDelivery — acknowledgment authentication (#730)', () => {
  test('an ack that does not echo the producer incarnation is ignored', async () => {
    const kit = quietKit('rd-forged-ack');
    const confirmations: Array<Error | null> = [];
    const probe = kit.createTestProbe();
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(probe as never)
      .withResendTimeout(80)
      .withWindowSize(1);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);
    producer.tell('payment-instruction', (err) => { confirmations.push(err); });

    const first = await probe.receiveOne(4_000) as Delivery<string>;
    expect(first.seq).toBe(1);
    expect(first.incarnation.length).toBeGreaterThan(0);

    // Everything an arbitrary sender can derive on its own: the kind, the
    // enumerable producer id, and the sequence number.  Acting on this would
    // cancel the retransmit and report success for a message that may never
    // have been handled at all.
    producer.ref.tell({
      kind: 'reliable-delivery.ack',
      producerId: first.producerId,
      incarnation: 'forged-incarnation',
      seq: first.seq,
    } as never);

    // The retransmit is the observable proof: the resend timer only fires
    // while the send is still in flight, so a second delivery means the
    // forged ack changed nothing.
    const retransmitted = await probe.receiveOne(4_000) as Delivery<string>;
    expect(retransmitted.seq).toBe(1);
    expect(confirmations).toHaveLength(0);

    // The honest ack — the same two fields plus the incarnation it read off
    // the wire — still settles it exactly once.
    producer.ref.tell({
      kind: 'reliable-delivery.ack',
      producerId: first.producerId,
      incarnation: first.incarnation,
      seq: first.seq,
    } as never);
    await awaitCondition(() => confirmations.length === 1, {
      timeoutMs: 4_000,
      label: 'the honest acknowledgment settled the send',
    });
    expect(confirmations).toEqual([null]);

    producer.stop();
    await kit.system.terminate();
  });

  test('two producers sharing a producerId cannot settle sends for one another', async () => {
    // Not an attack — two processes that both left `producerId` at the same
    // configured string.  Before the incarnation check either one's ack would
    // release the other's window slot and fire the other caller's `confirm`.
    const kit = quietKit('rd-crossed-acks');
    const confirmations: Array<Error | null> = [];
    const probeA = kit.createTestProbe();
    const probeB = kit.createTestProbe();
    const optionsFor = (consumer: unknown): ProducerControllerOptionsBuilder<string> =>
      ProducerControllerOptions.create<string>()
        .withConsumer(consumer as never)
        .withProducerId('shared-id')
        .withResendTimeout(5_000)
        .withWindowSize(1);

    const producerA = ReliableDelivery.producer<string>(kit.system, optionsFor(probeA), 'crossed-a');
    const producerB = ReliableDelivery.producer<string>(kit.system, optionsFor(probeB), 'crossed-b');
    producerA.tell('a-body', (err) => { confirmations.push(err); });
    producerB.tell('b-body', () => {});

    const deliveryB = await probeB.receiveOne(4_000) as Delivery<string>;
    expect(deliveryB.producerId).toBe('shared-id');

    // B's own, entirely honest acknowledgment, delivered to A.
    producerA.ref.tell({
      kind: 'reliable-delivery.ack',
      producerId: deliveryB.producerId,
      incarnation: deliveryB.incarnation,
      seq: deliveryB.seq,
    } as never);
    await sleep(80);
    expect(confirmations).toHaveLength(0);

    producerA.stop(); producerB.stop();
    await kit.system.terminate();
  });
});

describe('ReliableDelivery — malformed delivery (#727)', () => {
  /**
   * Collects dead letters off the event stream.  Returns once the listener has
   * actually subscribed, so a refusal cannot race the subscription.
   */
  const watchDeadLetters = async (kit: TestKit): Promise<DeadLetter[]> => {
    const seen: DeadLetter[] = [];
    const subscribed = { value: false };
    class DeadLetterListener extends Actor<DeadLetter> {
      override preStart(): void {
        this.system.eventStream.subscribe(this.self, DeadLetter);
        subscribed.value = true;
      }
      override onReceive(letter: DeadLetter): void { seen.push(letter); }
    }
    kit.system.spawn(DeadLetterListener, 'dead-letter-listener');
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 4_000,
      label: 'the dead-letter listener subscribed to the event stream',
    });
    return seen;
  };

  test('a delivery with no replyTo is dead-lettered, and the consumer keeps working', async () => {
    // `replyTo` is declared non-optional, which is exactly why nothing
    // guarded it: a wire body that omits it satisfies the type and
    // dereferences to `undefined`.  Because the handling is detached from
    // `onReceive`, that TypeError settled as a rejection nothing was
    // watching — process exit, not a supervised fault.
    const kit = quietKit('rd-malformed-replyto');
    const deadLetters = await watchDeadLetters(kit);
    const received: string[] = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: (m) => { received.push(m); },
    });

    consumer.ref.tell({
      kind: 'reliable-delivery.delivery',
      producerId: 'orders',
      incarnation: 'incarnation-1',
      seq: 1,
      body: 'unroutable',
    } as never);
    await awaitCondition(() => deadLetters.length === 1, {
      timeoutMs: 4_000,
      label: 'the replyTo-less delivery was dead-lettered',
    });
    expect(received).toEqual([]);

    // Still alive and still stateful: a restart would have wiped the dedup
    // window, so proving the next delivery lands is proving it was refused
    // rather than escalated.
    const probe = kit.createTestProbe();
    consumer.ref.tell({
      kind: 'reliable-delivery.delivery',
      producerId: 'orders',
      incarnation: 'incarnation-1',
      seq: 1,
      body: 'well-formed',
      replyTo: probe as never,
    } as never);
    await awaitCondition(() => received.length === 1, {
      timeoutMs: 4_000,
      label: 'the consumer still handles a well-formed delivery',
    });
    expect(received).toEqual(['well-formed']);

    consumer.stop();
    await kit.system.terminate();
  });

  test('a seq that is not a positive safe integer is refused', async () => {
    const kit = quietKit('rd-malformed-seq');
    const deadLetters = await watchDeadLetters(kit);
    const received: string[] = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: (m) => { received.push(m); },
    });
    const probe = kit.createTestProbe();
    const badSequences = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1];

    for (const seq of badSequences) {
      consumer.ref.tell({
        kind: 'reliable-delivery.delivery',
        producerId: 'orders',
        incarnation: 'incarnation-1',
        seq,
        body: `seq-${String(seq)}`,
        replyTo: probe as never,
      } as never);
    }
    await awaitCondition(() => deadLetters.length === badSequences.length, {
      timeoutMs: 4_000,
      label: 'every malformed seq was dead-lettered',
    });
    expect(received).toEqual([]);
    // A refused envelope is never acknowledged — acking it would tell the
    // sender the framework accepted a sequence it will never track.
    expect(probe.messageCount).toBe(0);

    consumer.stop();
    await kit.system.terminate();
  });

  test('an over-long or empty identifier is refused before it becomes a map key', async () => {
    const kit = quietKit('rd-malformed-identifier');
    const deadLetters = await watchDeadLetters(kit);
    const received: string[] = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: (m) => { received.push(m); },
    });
    const probe = kit.createTestProbe();
    const tooLong = 'x'.repeat(MAX_DELIVERY_IDENTIFIER_LENGTH + 1);

    for (const [producerId, incarnation, body] of [
      [tooLong, 'incarnation-1', 'long-producer-id'],
      ['orders', tooLong, 'long-incarnation'],
      ['', 'incarnation-1', 'empty-producer-id'],
    ] as const) {
      consumer.ref.tell({
        kind: 'reliable-delivery.delivery',
        producerId,
        incarnation,
        seq: 1,
        body,
        replyTo: probe as never,
      } as never);
    }

    await awaitCondition(() => deadLetters.length === 3, {
      timeoutMs: 4_000,
      label: 'all three malformed identifiers were dead-lettered',
    });
    expect(received).toEqual([]);
    expect(probe.messageCount).toBe(0);

    // An identifier exactly at the bound is admitted — the cap must be the one
    // the producer-side validator enforces, not one notch tighter, or a
    // legally configured producerId would dead-letter every delivery.
    consumer.ref.tell({
      kind: 'reliable-delivery.delivery',
      producerId: 'x'.repeat(MAX_DELIVERY_IDENTIFIER_LENGTH),
      incarnation: 'incarnation-1',
      seq: 1,
      body: 'at-the-bound',
      replyTo: probe as never,
    } as never);
    await awaitCondition(() => received.length === 1, {
      timeoutMs: 4_000,
      label: 'an identifier exactly at the bound is admitted',
    });
    expect(received).toEqual(['at-the-bound']);

    consumer.stop();
    await kit.system.terminate();
  });
});
