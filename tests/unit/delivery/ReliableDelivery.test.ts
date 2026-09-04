import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { Config } from '../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Scheduler } from '../../../src/Scheduler.js';
import type { Cancellable } from '../../../src/Scheduler.js';
import { ActorRestarted, DeadLetter } from '../../../src/SystemMessages.js';
import {
  ConsumerController,
  DEFAULT_PRODUCER_IDLE_TTL_MS,
  ReliableDelivery,
  ProducerControllerOptions,
  ProducerControllerOptionsBuilder,
  MAX_DELIVERY_IDENTIFIER_LENGTH,
} from '../../../src/delivery/index.js';
import type { ConsumerControllerOptionsType, Delivery } from '../../../src/delivery/index.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

/**
 * A silent TestKit — every case here would otherwise log its own warnings.
 *
 * The optional scheduler is how a case observes what an actor's `preStart`
 * did: a schedule that was never armed leaves no other trace.
 */
const quietKit = (name: string, scheduler?: Scheduler): TestKit => {
  const kitOptions = TestKitOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (scheduler !== undefined) kitOptions.withScheduler(scheduler);
  return TestKit.create(name, kitOptions);
};

/** One repeating schedule, as the actor that armed it asked for it. */
type ArmedFixedRate = { readonly initialDelayMs: number; readonly intervalMs: number };

/**
 * A real {@link Scheduler} that additionally records every repeating
 * schedule armed on it.
 *
 * A `preStart` that *refuses* to arm leaves nothing else to assert on.  The
 * sweep it would otherwise arm is harmless every time it fires — with an
 * infinite TTL the cutoff is `-Infinity`, so the very first entry is fresh
 * and the loop breaks — so no counter, no map size and no amount of waiting
 * can tell an armed schedule from an absent one.  The arm itself is the only
 * observable, which is why the test watches the seam it happens on.
 *
 * It delegates to `super` rather than swallowing the call: a schedule that
 * *is* armed has to keep behaving exactly as it does in production, or the
 * positive control below would prove nothing about the real thing.
 */
class RecordingScheduler extends Scheduler {
  readonly armedFixedRates: ArmedFixedRate[] = [];

  override scheduleAtFixedRateFunction(
    initialDelayMs: number,
    intervalMs: number,
    task: () => void,
  ): Cancellable {
    this.armedFixedRates.push({ initialDelayMs, intervalMs });
    return super.scheduleAtFixedRateFunction(initialDelayMs, intervalMs, task);
  }
}

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

describe('ReliableDelivery — the handler is serialised (#643)', () => {
  test('onReceive hands the cell a promise rather than discarding one', async () => {
    // The structural half of the fix, and the half the two behavioural cases
    // below cannot see.  Serialising the handler *inside* the controller — a
    // private promise chain each delivery appends itself to — produces the
    // same non-overlap and the same absorbed retransmits while still handing
    // the cell `undefined`, so the mailbox keeps draining at wire speed into
    // an unbounded internal queue.  The cell doing the serialising is what
    // makes the mailbox the back-pressure point, and this is what asserts it.
    const controller = new ConsumerController<string>({
      // Suspends, so the returned promise is genuinely pending rather than an
      // already-settled one a synchronous implementation could also produce.
      handler: async () => { await sleep(5); },
    });
    const returned = controller.onReceive({
      kind: 'reliable-delivery.delivery',
      producerId: 'orders',
      incarnation: 'incarnation-1',
      seq: 1,
      body: 'body',
      // A minimal reply target: nothing here is attached to a system, so the
      // ack must land somewhere that needs no cell behind it.
      replyTo: { tell: () => {} } as never,
    });

    expect(returned).toBeInstanceOf(Promise);
    await returned;
  });

  test('a sleeping handler is never entered while an earlier invocation is still running', async () => {
    // `onReceive` discarded the promise from `handleDelivery` and declared
    // itself `void`, and `ActorCell.run` awaits only what a receive actually
    // returns — so the cell dequeued the next delivery while the user handler
    // was still running.  A burst that fits in the producer's window became
    // that many overlapping invocations, against an options JSDoc that
    // promises the acknowledgment happens after the handler returns.
    const kit = quietKit('rd-serialised-handler');
    let insideHandler = 0;
    let peakInsideHandler = 0;
    const completed: string[] = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: async (m) => {
        insideHandler++;
        peakInsideHandler = Math.max(peakInsideHandler, insideHandler);
        // The overlap window itself.  Without a suspension point every
        // invocation would run to completion inside one synchronous stretch
        // and no two of them could ever be observed at once, so the case
        // would pass against the broken code as happily as against the fix.
        await sleep(15);
        completed.push(m);
        insideHandler--;
      },
    });
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(consumer.ref as never)
      // Far longer than this whole case, so retransmission is never what
      // shapes the arrival pattern here — the window is.
      .withResendTimeout(30_000)
      .withWindowSize(8);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);

    const messages = 6;
    for (let i = 0; i < messages; i++) producer.tell(`m-${i}`);
    await awaitCondition(() => completed.length === messages, {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'every message ran through the handler',
    });

    expect(peakInsideHandler).toBe(1);
    // Serialisation also makes the completion order the arrival order, which
    // an overlapping handler only produces by accident of equal sleeps.
    expect(completed).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5']);

    producer.stop(); consumer.stop();
    await kit.system.terminate();
  });

  test('a producer retransmit does not re-enter the handler for a sequence still in flight', async () => {
    // The duplicate check reads `contiguous` / `above`, and `markDelivered`
    // only writes them after the handler returns — so while a handler is
    // running its own sequence is not yet in the window it is checked
    // against.  Detached, that was a read-check-act race a retransmit won
    // every resend timeout; serialised, the retransmit cannot be dequeued
    // until the write has happened.
    const kit = quietKit('rd-retransmit-reentry');
    const entered: string[] = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: async (m) => {
        entered.push(m);
        // Held open across several resend timeouts on purpose — that is the
        // window the retransmits have to arrive in.
        await sleep(200);
      },
    });

    // Counts what the producer actually put on the wire, and forwards it
    // unchanged (`replyTo` travels in the envelope, not as the sender, so
    // relaying does not disturb the ack path).  Without this a run in which
    // no retransmit happened at all would look exactly like a run in which
    // every retransmit was correctly absorbed.
    const delivered: number[] = [];
    class RetransmitCounter extends Actor<Delivery<string>> {
      override onReceive(delivery: Delivery<string>): void {
        delivered.push(delivery.seq);
        consumer.ref.tell(delivery as never);
      }
    }
    const relay = kit.system.spawn(RetransmitCounter, 'retransmit-counter');

    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(relay)
      .withResendTimeout(30)
      .withWindowSize(1);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);
    producer.tell('slow-body');

    await awaitCondition(() => delivered.length >= 3, {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'the producer retransmitted the in-flight sequence at least twice',
    });
    // All of them carry seq 1, so every one after the first is a retransmit
    // of a delivery whose handler had not returned.
    expect(new Set(delivered)).toEqual(new Set([1]));

    // The assertion is an absence — none of those retransmits may reach the
    // handler — so settling past the handler's own 200 ms IS the assertion.
    await sleep(260);
    expect(entered).toEqual(['slow-body']);

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
    // The assertion is an absence: the window must NOT advance past two, so
    // this is a settle period rather than a condition that becomes true.
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
    // The assertion is an absence: exactly two of the three reach the handler
    // and the third must stay absorbed, so the settle period IS the assertion.
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
    // The assertion is an absence: the forged acknowledgment must settle
    // nothing, so there is no condition to poll for, only one not to meet.
    await sleep(80);
    expect(confirmations).toHaveLength(0);

    producerA.stop(); producerB.stop();
    await kit.system.terminate();
  });

  test('a generated producerId is drawn at random, not from a module counter', async () => {
    // A `producerId` is one of the two fields an Acknowledgment carries, and
    // the other one is a small integer — so a default of `producer-1`,
    // `producer-2`, … handed anyone who could count the half of the pair that
    // is not the sequence number.  The same counter was module-global, so two
    // processes running the same service both minted `producer-1` and then
    // shared — and kept resetting — one dedup entry in the consumer's map.
    //
    // The assertion reads the id off the wire rather than off the controller,
    // because the wire is where both of those problems live.
    const kit = quietKit('rd-generated-producer-id');
    const identifiers: string[] = [];

    for (let i = 0; i < 3; i++) {
      const probe = kit.createTestProbe();
      const producerOptions = ProducerControllerOptions.create<string>()
        .withConsumer(probe as never)
        .withResendTimeout(5_000);
      const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);
      producer.tell('body');
      const delivery = await probe.receiveOne(4_000) as Delivery<string>;
      identifiers.push(delivery.producerId);
      producer.stop();
    }

    for (const identifier of identifiers) {
      // GENERATED_PRODUCER_ID_LENGTH hex characters behind the prefix.
      expect(identifier).toMatch(/^producer-[0-9a-f]{16}$/);
      // Spelled out separately because the shape above is what would change
      // silently if someone reinstated a counter with a wider format.  The
      // bound keeps this from ever colliding with an all-digit random draw.
      expect(identifier).not.toMatch(/^producer-[0-9]{1,4}$/);
      // A generated id the consumer would refuse dead-letters every delivery
      // it stamps, so the default has to sit inside the admission bound.
      expect(identifier.length).toBeLessThanOrEqual(MAX_DELIVERY_IDENTIFIER_LENGTH);
    }
    expect(new Set(identifiers).size).toBe(3);

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

/** Mutable slot the spawn factory writes the live controller into. */
type ControllerSlot = { controller: ConsumerController<string> | null };

/**
 * Spawn a ConsumerController and keep hold of the instance.
 *
 * `ReliableDelivery.consumer` hands back only a ref, and the budget cases
 * assert on `trackedProducers` / `outOfOrderFor` — the counters the growth
 * they bound had no equivalent of before — so they need the object and not
 * just its address.
 */
const spawnBoundedConsumer = (
  kit: TestKit,
  slot: ControllerSlot,
  options: ConsumerControllerOptionsType<string>,
  name: string,
): ActorRef<Delivery<string>> => kit.system.spawn<Delivery<string>>(() => {
  slot.controller = new ConsumerController<string>(options);
  return slot.controller;
}, name);

/**
 * Hand-rolled envelope, because the budget cases turn on a `producerId` and a
 * `seq` the *sender* chose.  A `ProducerController` mints one id per
 * construction and never leaves a gap open, which is precisely the traffic
 * these bounds do not exist for.
 */
const deliver = (
  consumer: ActorRef<Delivery<string>>,
  replyTo: unknown,
  producerId: string,
  seq: number,
  body: string,
): void => {
  consumer.tell({
    kind: 'reliable-delivery.delivery',
    producerId,
    incarnation: 'incarnation-1',
    seq,
    body,
    replyTo,
  } as never);
};

describe('ReliableDelivery — dedup map resource budget (#728)', () => {
  test('maxProducers evicts the least-recently-used producer, and the map never grows past it', async () => {
    const kit = quietKit('rd-max-producers');
    const received: string[] = [];
    const probe = kit.createTestProbe();
    const slot: ControllerSlot = { controller: null };
    // The sweep is off, so age cannot be what reclaims here — only the cap.
    const consumer = spawnBoundedConsumer(kit, slot, {
      handler: (m) => { received.push(m); },
      maxProducers: 2,
      producerIdleTtlMs: Infinity,
    }, 'lru-consumer');

    deliver(consumer, probe, 'producer-a', 1, 'a-1');
    deliver(consumer, probe, 'producer-b', 1, 'b-1');
    await awaitCondition(() => received.length === 2, {
      timeoutMs: 4_000,
      label: 'both producers were handled',
    });
    expect(slot.controller?.trackedProducers).toBe(2);

    // Touch producer-a again before the eviction below, which is the whole
    // difference between least-recently-used and first-in-first-out: a and b
    // arrived in that order, so arrival order condemns a and recency condemns
    // b.  Without this delivery the two policies pick the same victim and
    // every assertion that follows holds under either — which is what made
    // the map's insertion order deletable with the suite still green.
    deliver(consumer, probe, 'producer-a', 2, 'a-2');
    await awaitCondition(() => received.length === 3, {
      timeoutMs: 4_000,
      label: 'the second delivery from producer-a was handled',
    });

    // A third producer needs a slot and the map is full, so the least
    // recently used of the two goes — b, not a.
    deliver(consumer, probe, 'producer-c', 1, 'c-1');
    await awaitCondition(() => received.length === 4, {
      timeoutMs: 4_000,
      label: 'the third producer was handled',
    });
    expect(slot.controller?.trackedProducers).toBe(2);

    // producer-c is still remembered: its seq 1 is absorbed as a duplicate,
    // so `received` does not move and the ack count is what to wait on.
    deliver(consumer, probe, 'producer-c', 1, 'c-1-again');
    await awaitCondition(() => probe.messageCount === 5, {
      timeoutMs: 4_000,
      label: 'the duplicate from producer-c was re-acknowledged',
    });
    expect(received).toEqual(['a-1', 'b-1', 'a-2', 'c-1']);

    // And so is producer-a, because it was used after b: its already-seen
    // seq 1 is a duplicate too.  Under first-in-first-out a is the entry that
    // was dropped instead, and this delivery runs the handler again.
    deliver(consumer, probe, 'producer-a', 1, 'a-1-again');
    await awaitCondition(() => probe.messageCount === 6, {
      timeoutMs: 4_000,
      label: 'the duplicate from producer-a was re-acknowledged',
    });
    expect(received).toEqual(['a-1', 'b-1', 'a-2', 'c-1']);

    // producer-b is the one that lost its window: the same
    // (producerId, incarnation, seq) runs the handler a second time.  That is
    // what an eviction costs, and it is the at-least-once duplicate this
    // protocol already permits — unbounded growth is what it did not.
    deliver(consumer, probe, 'producer-b', 1, 'b-1-again');
    await awaitCondition(() => received.length === 5, {
      timeoutMs: 4_000,
      label: 'the evicted producer was handled again',
    });
    expect(received).toEqual(['a-1', 'b-1', 'a-2', 'c-1', 'b-1-again']);
    expect(slot.controller?.trackedProducers).toBe(2);

    await kit.system.terminate();
  });

  test('a flood of distinct producer ids leaves the map at the cap, not at the message count', async () => {
    // The issue's variant A in miniature: before the cap, the map held one
    // permanent entry per distinct producerId ever admitted — so its size was
    // a function of the message count, which the sender picks.
    const kit = quietKit('rd-producer-flood');
    const received: string[] = [];
    const probe = kit.createTestProbe();
    const slot: ControllerSlot = { controller: null };
    const consumer = spawnBoundedConsumer(kit, slot, {
      handler: (m) => { received.push(m); },
      maxProducers: 8,
      producerIdleTtlMs: Infinity,
    }, 'flood-consumer');

    const flood = 200;
    for (let i = 0; i < flood; i++) deliver(consumer, probe, `flood-${i}`, 1, `m-${i}`);

    await awaitCondition(() => received.length === flood, {
      timeoutMs: 4_000,
      intervalMs: 20,
      label: 'every flooded delivery was handled',
    });
    // Every one of them ran the handler — the cap bounds retention, not
    // admission — and the map is still at eight entries.
    expect(slot.controller?.trackedProducers).toBe(8);

    await kit.system.terminate();
  });

  test('producerIdleTtlMs releases a producer that has gone quiet', async () => {
    const kit = quietKit('rd-producer-idle-ttl');
    const received: string[] = [];
    const probe = kit.createTestProbe();
    const slot: ControllerSlot = { controller: null };
    // No cap at all, so nothing but age can reclaim: the LRU half only
    // evicts when a *new* producer needs the slot, which is why a consumer
    // that saw a burst and then went quiet needed a second mechanism.
    const consumer = spawnBoundedConsumer(kit, slot, {
      handler: (m) => { received.push(m); },
      maxProducers: Infinity,
      producerIdleTtlMs: 50,
    }, 'idle-consumer');

    deliver(consumer, probe, 'quiet-producer', 1, 'first');
    await awaitCondition(() => received.length === 1, {
      timeoutMs: 4_000,
      label: 'the first delivery was handled',
    });
    expect(slot.controller?.trackedProducers).toBe(1);

    await awaitCondition(() => slot.controller?.trackedProducers === 0, {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'the idle producer entry was swept',
    });

    // The window is genuinely gone rather than just uncounted: the same
    // (producerId, incarnation, seq) runs the handler again.
    deliver(consumer, probe, 'quiet-producer', 1, 'after-sweep');
    await awaitCondition(() => received.length === 2, {
      timeoutMs: 4_000,
      label: 'the swept producer was handled again',
    });
    expect(received).toEqual(['first', 'after-sweep']);

    await kit.system.terminate();
  });

  test('the sweep reaches an idle producer parked behind a busy one', async () => {
    // The other half of what the map's least-recently-used ordering buys, and
    // the one that is a leak rather than a policy change when it goes.  Every
    // entry moving to the back on use is what keeps the map ascending by
    // `lastSeenAtMs`, which is the premise `sweepIdleProducers` breaks on —
    // so in arrival order a stale entry sitting behind a continuously
    // refreshed one is never reached, and #728 is back for exactly the
    // producer that stopped talking.
    const kit = quietKit('rd-sweep-behind-busy');
    const received: string[] = [];
    const probe = kit.createTestProbe();
    const slot: ControllerSlot = { controller: null };
    // No cap, so the sweep is the only thing that can reclaim anything.
    const consumer = spawnBoundedConsumer(kit, slot, {
      handler: (m) => { received.push(m); },
      maxProducers: Infinity,
      producerIdleTtlMs: 120,
    }, 'sweep-order-consumer');

    // busy-producer first, so it is the entry an arrival-ordered map parks in
    // front of the idle one.
    deliver(consumer, probe, 'busy-producer', 1, 'busy-first');
    deliver(consumer, probe, 'idle-producer', 1, 'idle-first');
    await awaitCondition(() => received.length === 2, {
      timeoutMs: 4_000,
      label: 'both producers were handled',
    });
    expect(slot.controller?.trackedProducers).toBe(2);

    // Keep busy-producer fresh across every sweep, six ticks to a TTL.  A
    // re-delivery of a seq it has already seen is enough: the entry is looked
    // up — and moved to the back — before the duplicate check refuses it, so
    // this costs no handler call and `received` stays at two.
    const busyTicker = kit.system.scheduler.scheduleAtFixedRateFunction(20, 20, () => {
      deliver(consumer, probe, 'busy-producer', 1, 'busy-again');
    });
    try {
      // Both halves matter.  The size is what the ordering fixes; `received`
      // staying at two is what says the survivor is the *busy* one, so a
      // sweep that took both and let the ticker re-add one cannot pass for a
      // sweep that reached past a fresh entry.
      await awaitCondition(
        () => slot.controller?.trackedProducers === 1 && received.length === 2,
        {
          timeoutMs: 4_000,
          intervalMs: 10,
          label: 'the idle producer was swept from behind the busy one',
        },
      );
    } finally {
      busyTicker.cancel();
    }

    // The idle one's window is genuinely gone rather than merely uncounted.
    deliver(consumer, probe, 'idle-producer', 1, 'idle-after-sweep');
    await awaitCondition(() => received.length === 3, {
      timeoutMs: 4_000,
      label: 'the swept producer was handled again',
    });
    expect(received).toEqual(['busy-first', 'idle-first', 'idle-after-sweep']);

    await kit.system.terminate();
  });

  test('Infinity on both bounds is the documented opt-out', async () => {
    // Retention only: five distinct producers, no cap to evict them and no
    // sweep to age them out.  This case cannot see whether `preStart` armed
    // a sweep, and a comment here used to claim that it could — an armed
    // one deletes nothing when it fires on an infinite TTL, so the map looks
    // identical either way, and waiting longer only makes that more true.
    // `producerIdleTtlMs: Infinity arms no sweep at all` holds that ground.
    const kit = quietKit('rd-unbounded-optout');
    const received: string[] = [];
    const probe = kit.createTestProbe();
    const slot: ControllerSlot = { controller: null };
    const consumer = spawnBoundedConsumer(kit, slot, {
      handler: (m) => { received.push(m); },
      maxProducers: Infinity,
      producerIdleTtlMs: Infinity,
    }, 'unbounded-consumer');

    for (let i = 0; i < 5; i++) deliver(consumer, probe, `unbounded-${i}`, 1, `m-${i}`);
    await awaitCondition(() => received.length === 5, {
      timeoutMs: 4_000,
      label: 'all five producers were handled',
    });
    expect(slot.controller?.trackedProducers).toBe(5);

    await kit.system.terminate();
  });

  test('producerIdleTtlMs: Infinity arms no sweep at all', async () => {
    // `Infinity` is the documented way to switch the sweep off, and
    // `preStart` has to refuse to arm rather than hand the value on:
    // `setInterval` clamps a non-finite delay to a millisecond, so a sweep
    // armed on it is a busy timer for the life of the consumer.  It would
    // also be harmless on every one of those ticks, which is the reason
    // nothing downstream of the arm can notice it — see the note on
    // `RecordingScheduler` above.
    const scheduler = new RecordingScheduler();
    const kit = quietKit('rd-no-sweep-armed', scheduler);
    const received: string[] = [];
    const probe = kit.createTestProbe();

    const sweepOffSlot: ControllerSlot = { controller: null };
    const armedBeforeSweepOff = scheduler.armedFixedRates.length;
    const sweepOff = spawnBoundedConsumer(kit, sweepOffSlot, {
      handler: (m) => { received.push(m); },
      maxProducers: Infinity,
      producerIdleTtlMs: Infinity,
    }, 'sweep-off-consumer');
    // Wait on a handled delivery, so "nothing was armed" cannot be satisfied
    // by a `preStart` that simply had not run yet.
    deliver(sweepOff, probe, 'sweep-off-producer', 1, 'off');
    await awaitCondition(() => received.length === 1, {
      timeoutMs: 4_000,
      label: 'the consumer with the sweep off started and handled a delivery',
    });
    expect(scheduler.armedFixedRates.slice(armedBeforeSweepOff)).toEqual([]);

    // The positive control, on the same seam: a finite TTL arms exactly one
    // schedule, on exactly the interval the option names.  Without it,
    // "nothing was armed" would hold just as well for a probe that records
    // nothing at all.  Its TTL is long enough that it never fires here.
    const sweepOnSlot: ControllerSlot = { controller: null };
    const armedBeforeSweepOn = scheduler.armedFixedRates.length;
    const sweepOn = spawnBoundedConsumer(kit, sweepOnSlot, {
      handler: (m) => { received.push(m); },
      maxProducers: Infinity,
      producerIdleTtlMs: 30_000,
    }, 'sweep-on-consumer');
    deliver(sweepOn, probe, 'sweep-on-producer', 1, 'on');
    await awaitCondition(() => received.length === 2, {
      timeoutMs: 4_000,
      label: 'the consumer with the sweep on started and handled a delivery',
    });
    expect(scheduler.armedFixedRates.slice(armedBeforeSweepOn)).toEqual([
      { initialDelayMs: 30_000, intervalMs: 30_000 },
    ]);

    await kit.system.terminate();
  });

  test('stopping the consumer releases the whole map', async () => {
    const kit = quietKit('rd-stop-releases-map');
    const received: string[] = [];
    const probe = kit.createTestProbe();
    const slot: ControllerSlot = { controller: null };
    const consumer = spawnBoundedConsumer(kit, slot, {
      handler: (m) => { received.push(m); },
      maxProducers: Infinity,
      producerIdleTtlMs: Infinity,
    }, 'stopped-consumer');

    for (let i = 0; i < 3; i++) deliver(consumer, probe, `stopped-${i}`, 1, `m-${i}`);
    await awaitCondition(() => received.length === 3, {
      timeoutMs: 4_000,
      label: 'the three producers were handled',
    });
    expect(slot.controller?.trackedProducers).toBe(3);

    consumer.stop();
    await awaitCondition(() => slot.controller?.trackedProducers === 0, {
      timeoutMs: 4_000,
      label: 'postStop cleared the dedup map',
    });

    await kit.system.terminate();
  });
});

describe('ReliableDelivery — out-of-order window bound (#728, #643)', () => {
  test('a gap that never closes leaves the out-of-order set at maxOutOfOrder, refusing rather than dropping', async () => {
    // Variant B of the issue, and the half #643 claims in its own acceptance
    // criteria.  `contiguous` only advances when the missing predecessor
    // arrives, so a sender that withholds seq 1 and keeps sending the ones
    // after it put every one of them into the per-producer set, permanently
    // and without limit.  The other two bounds do not cover it: `maxProducers`
    // caps how many such sets exist, not the size of one, and the idle sweep
    // never reaches a producer that is actively flooding, because every
    // admitted delivery re-stamps its timestamp.
    const kit = quietKit('rd-out-of-order-cap');
    const received: string[] = [];
    const probe = kit.createTestProbe();
    const slot: ControllerSlot = { controller: null };
    const cap = 4;
    const consumer = spawnBoundedConsumer(kit, slot, {
      handler: (m) => { received.push(m); },
      // Both other bounds off, so nothing but this one can reclaim or refuse.
      maxProducers: Infinity,
      producerIdleTtlMs: Infinity,
      maxOutOfOrder: cap,
    }, 'out-of-order-consumer');

    // seq 1 is withheld and everything above it arrives in ONE burst, with no
    // wait inside it.  That is deliberate and is what makes the cap an exact
    // post-condition rather than an approximate one: the check runs before the
    // handler and the insert after it, so if the cell did not serialise
    // deliveries every message in this burst would pass the check while the
    // set was still empty and the set would end up holding all 44 of them.
    // Phasing the burst around an `awaitCondition` would drain the pipeline
    // between the two halves and hide exactly that.
    const overflow = 40;
    for (let seq = 2; seq <= cap + 1 + overflow; seq++) {
      deliver(consumer, probe, 'gappy', seq, `seq-${seq}`);
    }
    // `>=` rather than `===`: an implementation that admits too many would
    // race straight past the exact count, and this poll is only here to get
    // past the empty state — the assertions after the settle are the test.
    await awaitCondition(() => received.length >= cap, {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'the sequences that fit in the out-of-order window were handled',
    });
    // The rest is an absence — not one of the other 40 may be admitted — so
    // settling past the point where they would have been IS the assertion.
    await sleep(120);
    // Refused means BOTH: no handler call and no acknowledgment.  Withholding
    // the ack stalls the producer's own window instead of growing this
    // consumer's heap; dropping the oldest retained sequence would bound the
    // same heap and would re-run the handler for a message already handled and
    // already acknowledged.
    expect(received).toHaveLength(cap);
    expect(slot.controller?.outOfOrderFor('gappy')).toBe(cap);
    // One acknowledgment per admitted delivery, and none for the refused ones.
    expect(probe.messageCount).toBe(cap);

    // A stall, not a deadlock.  The sequence that closes the gap is admitted
    // at the cap — it drains the set rather than growing it — and the window
    // then slides over the whole retained run in one pass.
    deliver(consumer, probe, 'gappy', 1, 'the-missing-one');
    await awaitCondition(() => slot.controller?.outOfOrderFor('gappy') === 0, {
      timeoutMs: 4_000,
      label: 'the missing sequence drained the whole out-of-order set',
    });
    expect(received).toHaveLength(cap + 1);

    // And the far sequences are admissible again, so nothing was lost by the
    // refusal: the producer's retransmit of any of them now lands.
    deliver(consumer, probe, 'gappy', cap + 2, 'after-the-gap-closed');
    await awaitCondition(() => received.length === cap + 2, {
      timeoutMs: 4_000,
      label: 'a refused sequence is handled once the gap has closed',
    });
    expect(received[received.length - 1]).toBe('after-the-gap-closed');

    await kit.system.terminate();
  });

  test('maxOutOfOrder: Infinity is the documented opt-out', async () => {
    // The counterpart, and the reason the cap is an option rather than a
    // constant: with the opt-out every sequence above the gap is retained,
    // which is the pre-#728 behaviour and is still what someone who asks for
    // it gets.
    const kit = quietKit('rd-out-of-order-unbounded');
    const received: string[] = [];
    const probe = kit.createTestProbe();
    const slot: ControllerSlot = { controller: null };
    const consumer = spawnBoundedConsumer(kit, slot, {
      handler: (m) => { received.push(m); },
      maxProducers: Infinity,
      producerIdleTtlMs: Infinity,
      maxOutOfOrder: Infinity,
    }, 'unbounded-window-consumer');

    const above = 30;
    for (let seq = 2; seq <= above + 1; seq++) deliver(consumer, probe, 'gappy', seq, `seq-${seq}`);
    await awaitCondition(() => received.length === above, {
      timeoutMs: 4_000,
      intervalMs: 10,
      label: 'every sequence above the gap was handled',
    });
    expect(slot.controller?.outOfOrderFor('gappy')).toBe(above);
    expect(probe.messageCount).toBe(above);

    await kit.system.terminate();
  });

  test('the cap is per producer, not shared across them', async () => {
    // The set lives on the dedup entry, so one producer stalled on a gap must
    // not spend another producer's budget.  A single shared counter would
    // satisfy the first case here and fail this one.
    const kit = quietKit('rd-out-of-order-per-producer');
    const received: string[] = [];
    const probe = kit.createTestProbe();
    const slot: ControllerSlot = { controller: null };
    const cap = 2;
    const consumer = spawnBoundedConsumer(kit, slot, {
      handler: (m) => { received.push(m); },
      maxProducers: Infinity,
      producerIdleTtlMs: Infinity,
      maxOutOfOrder: cap,
    }, 'per-producer-window-consumer');

    // Two producers, each withholding its own seq 1 and each filling its own
    // window to the cap.
    for (const producerId of ['gappy-a', 'gappy-b']) {
      for (let seq = 2; seq <= cap + 1; seq++) {
        deliver(consumer, probe, producerId, seq, `${producerId}-${seq}`);
      }
    }
    await awaitCondition(() => received.length === 2 * cap, {
      timeoutMs: 4_000,
      label: 'both producers filled their own out-of-order window',
    });
    expect(slot.controller?.outOfOrderFor('gappy-a')).toBe(cap);
    expect(slot.controller?.outOfOrderFor('gappy-b')).toBe(cap);

    // b closing its gap releases only b's set; a is still stalled on its own.
    deliver(consumer, probe, 'gappy-b', 1, 'gappy-b-1');
    await awaitCondition(() => slot.controller?.outOfOrderFor('gappy-b') === 0, {
      timeoutMs: 4_000,
      label: 'the second producer drained its own window',
    });
    expect(slot.controller?.outOfOrderFor('gappy-a')).toBe(cap);

    await kit.system.terminate();
  });
});

/**
 * Records the one-shot delays armed on it, alongside the repeating schedules
 * {@link RecordingScheduler} already covers.
 *
 * The producer's resend interval has no other observable.  It is a private
 * field, and waiting for the retransmit itself would make the assertion a
 * wall-clock race that the built-in 500 ms default *also* wins given a
 * generous enough timeout — which is to say it would bind to nothing.  The arm
 * carries the number.
 */
class ArmRecordingScheduler extends Scheduler {
  readonly armedOneShotDelays: number[] = [];
  readonly armedFixedRateIntervals: number[] = [];

  override scheduleOnceFunction(delayMs: number, task: () => void): Cancellable {
    this.armedOneShotDelays.push(delayMs);
    return super.scheduleOnceFunction(delayMs, task);
  }

  override scheduleAtFixedRateFunction(
    initialDelayMs: number,
    intervalMs: number,
    task: () => void,
  ): Cancellable {
    this.armedFixedRateIntervals.push(intervalMs);
    return super.scheduleAtFixedRateFunction(initialDelayMs, intervalMs, task);
  }
}

/** A quiet TestKit whose config layer carries `hocon` over reference.conf. */
const configuredKit = (name: string, hocon: string, scheduler?: Scheduler): TestKit => {
  const kitOptions = TestKitOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon));
  if (scheduler !== undefined) kitOptions.withScheduler(scheduler);
  return TestKit.create(name, kitOptions);
};

/** Swallows every delivery without acknowledging, so the window stays shut. */
class NeverAcknowledgingConsumer extends Actor<Delivery<string>> {
  constructor(private readonly delivered: string[]) { super(); }

  override onReceive(delivery: Delivery<string>): void {
    this.delivered.push(delivery.body);
  }
}

describe('ReliableDelivery — actor-ts.reliable-delivery layering (#861)', () => {
  test('the producer takes both of its tunables from HOCON', async () => {
    // Neither value is reachable any other way: `windowSize` and
    // `resendTimeoutMs` are private fields of the controller, and
    // `ReliableDelivery.producer` hands back only a ref.  So the window is
    // read off how many sends actually leave, and the resend interval off the
    // timer the first one arms.
    const scheduler = new ArmRecordingScheduler();
    const kit = configuredKit('rd-config-producer', `
      actor-ts.reliable-delivery.producer {
        resend-timeout = 1234ms
        window-size    = 1
      }
    `, scheduler);
    const delivered: string[] = [];
    const consumerRef = kit.system.spawn(
      () => new NeverAcknowledgingConsumer(delivered),
      'never-acknowledging',
    );
    // Only `consumer` is set explicitly — everything else has to come from the
    // block above, or from the constructor's built-ins if the seam is missing.
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(consumerRef);
    const armedBefore = scheduler.armedOneShotDelays.length;
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);

    for (const body of ['a', 'b', 'c']) producer.tell(body);
    await awaitCondition(() => delivered.length === 1, {
      timeoutMs: 4_000,
      label: 'the first send reached the consumer',
    });
    // Long enough for the other two to arrive if the window were the built-in
    // 16 — they would leave in the same turn — and far short of the 1234 ms
    // that would let a retransmit muddy the count.
    await sleep(100);

    expect(delivered).toEqual(['a']);
    expect(scheduler.armedOneShotDelays.slice(armedBefore)).toContain(1_234);

    producer.stop();
    await kit.system.terminate();
  });

  test('explicit producer options beat the block', async () => {
    // The other half of the precedence rule, on the same two observables: a
    // builder that sets both must win over a config that sets both to
    // something else.
    const scheduler = new ArmRecordingScheduler();
    const kit = configuredKit('rd-explicit-producer', `
      actor-ts.reliable-delivery.producer {
        resend-timeout = 1234ms
        window-size    = 1
      }
    `, scheduler);
    const delivered: string[] = [];
    const consumerRef = kit.system.spawn(
      () => new NeverAcknowledgingConsumer(delivered),
      'never-acknowledging',
    );
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(consumerRef)
      .withResendTimeout(4_321)
      .withWindowSize(3);
    const armedBefore = scheduler.armedOneShotDelays.length;
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);

    for (const body of ['a', 'b', 'c']) producer.tell(body);
    await awaitCondition(() => delivered.length === 3, {
      timeoutMs: 4_000,
      label: 'all three sends left under the explicit window',
    });

    expect(scheduler.armedOneShotDelays.slice(armedBefore)).toContain(4_321);
    expect(scheduler.armedOneShotDelays.slice(armedBefore)).not.toContain(1_234);

    producer.stop();
    await kit.system.terminate();
  });

  test('the consumer idle sweep runs on the interval the block names', async () => {
    const scheduler = new ArmRecordingScheduler();
    const kit = configuredKit(
      'rd-config-consumer-ttl',
      'actor-ts.reliable-delivery.consumer.producer-idle-time-to-live = 7s',
      scheduler,
    );
    const received: string[] = [];
    const probe = kit.createTestProbe();

    const armedBefore = scheduler.armedFixedRateIntervals.length;
    const fromConfig = ReliableDelivery.consumer<string>(kit.system, {
      handler: (body) => { received.push(body); },
    }, 'ttl-from-config');
    // Wait on a handled delivery rather than on the arm itself, so the
    // assertion cannot be satisfied by a `preStart` that has not run yet.
    deliver(fromConfig.ref as never, probe, 'ttl-producer', 1, 'from-config');
    await awaitCondition(() => received.length === 1, {
      timeoutMs: 4_000,
      label: 'the config-built consumer started and handled a delivery',
    });
    expect(scheduler.armedFixedRateIntervals.slice(armedBefore)).toEqual([7_000]);

    // And the explicit layer still wins over it.
    const armedBeforeExplicit = scheduler.armedFixedRateIntervals.length;
    const explicit = ReliableDelivery.consumer<string>(kit.system, {
      handler: (body) => { received.push(body); },
      producerIdleTtlMs: 3_000,
    }, 'ttl-explicit');
    deliver(explicit.ref as never, probe, 'ttl-producer', 1, 'explicit');
    await awaitCondition(() => received.length === 2, {
      timeoutMs: 4_000,
      label: 'the explicitly configured consumer started and handled a delivery',
    });
    expect(scheduler.armedFixedRateIntervals.slice(armedBeforeExplicit)).toEqual([3_000]);

    fromConfig.stop();
    explicit.stop();
    await kit.system.terminate();
  });

  test('the consumer deduplication cap comes from the block', async () => {
    // `trackedProducers` needs the instance and `ReliableDelivery.consumer`
    // hands back a ref, so the cap is observed through what it costs: an
    // evicted producer has lost its duplicate suppression, and its retransmit
    // reaches the handler a second time.  Under the shipped 1024 the third
    // delivery below is absorbed and `received` stays at two.
    const kit = configuredKit(
      'rd-config-max-producers',
      'actor-ts.reliable-delivery.consumer.max-producers = 1',
    );
    const received: string[] = [];
    const probe = kit.createTestProbe();
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: (body) => { received.push(body); },
    }, 'capped-consumer');
    const consumerRef = consumer.ref as never;

    deliver(consumerRef, probe, 'producer-a', 1, 'a-1');
    await awaitCondition(() => received.length === 1, {
      timeoutMs: 4_000,
      label: 'the first producer was handled',
    });
    // One slot, so producer-b's arrival evicts producer-a outright.
    deliver(consumerRef, probe, 'producer-b', 1, 'b-1');
    await awaitCondition(() => received.length === 2, {
      timeoutMs: 4_000,
      label: 'the second producer was handled and took the only slot',
    });
    deliver(consumerRef, probe, 'producer-a', 1, 'a-1-again');
    await awaitCondition(() => received.length === 3, {
      timeoutMs: 4_000,
      label: 'the evicted producer retransmit reached the handler again',
    });

    expect(received).toEqual(['a-1', 'b-1', 'a-1-again']);

    consumer.stop();
    await kit.system.terminate();
  });

  test('a directly constructed controller keeps its built-in defaults', async () => {
    // The documented limit of the seam, asserted rather than only written
    // down: the config layer lives in `ReliableDelivery`, so a controller
    // built with `new` and handed to `system.spawn` never passes through it.
    // Neither controller can read config in its constructor — `Actor.system`
    // is a getter over a context the cell injects afterwards — so this is the
    // trade, not an oversight.
    const scheduler = new ArmRecordingScheduler();
    const kit = configuredKit(
      'rd-direct-construction',
      'actor-ts.reliable-delivery.consumer.producer-idle-time-to-live = 7s',
      scheduler,
    );
    const received: string[] = [];
    const probe = kit.createTestProbe();
    const slot: ControllerSlot = { controller: null };

    const armedBefore = scheduler.armedFixedRateIntervals.length;
    const consumer = spawnBoundedConsumer(kit, slot, {
      handler: (body) => { received.push(body); },
    }, 'directly-constructed');
    deliver(consumer, probe, 'direct-producer', 1, 'direct');
    await awaitCondition(() => received.length === 1, {
      timeoutMs: 4_000,
      label: 'the directly constructed consumer started and handled a delivery',
    });

    expect(scheduler.armedFixedRateIntervals.slice(armedBefore))
      .toEqual([DEFAULT_PRODUCER_IDLE_TTL_MS]);

    await kit.system.terminate();
  });
});
