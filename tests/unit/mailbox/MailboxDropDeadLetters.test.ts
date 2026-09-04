/**
 * #773 — a message a bounded or priority mailbox discards used to leave no
 * forensic record: the drop seam carried a *reason* and nothing else, so the
 * sender and the payload of the lost envelope were destroyed and only
 * `actor_mailbox_dropped_total` remained.  Every other loss path in the
 * framework dead-letters — the stash drain, a tell to a terminated cell, a
 * watcher that refused its `Terminated` — and overflow was the exception.
 *
 * Two halves are asserted here, and they are separable on purpose:
 *
 *   1. **The seam carries the envelope.**  Unconditional, and it is the half
 *      that makes the loss describable at all — `onDrop` and any observer of
 *      your own now see what was discarded, not just that something was.
 *   2. **The routing is opt-in.**  `deadLetterDrops` decides whether the cell
 *      turns each report into a `DeadLetter`, because the drop runs on the
 *      *sender's* stack and `DeadLetterRef.tell` is a durable capture plus a
 *      synchronous publish — per-message work under exactly the pressure the
 *      bound exists to absorb.
 *
 * **Why there is no latch.**  `tell` enqueues synchronously on the caller's
 * stack, and so does the whole chain behind an overflow: `enqueue` →
 * `reportDrop` → observer → `deadLetters.tell` → `eventStream.publish`.  The
 * cell's drain is a microtask and cannot interleave with a synchronous `for`
 * loop, so a burst issued in one tick meets a mailbox nothing has dequeued
 * from — every expectation below is counted from an untouched queue — and its
 * letters are already sitting in the listener's mailbox when the loop returns.
 *
 * That last property is what makes the negative assertions honest: publishing
 * a **fence** letter afterwards puts a message strictly behind every letter
 * the burst produced, so "the fence arrived and nothing else did" is a fact
 * rather than a timeout that happened to expire quietly.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogContext } from '../../../src/LogContext.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { RecordingTracer } from '../../../src/tracing/RecordingTracer.js';
import { TracingExtensionId } from '../../../src/tracing/TracingExtension.js';
import { BoundedMailbox } from '../../../src/mailbox/BoundedMailbox.js';
import { PriorityMailbox } from '../../../src/mailbox/PriorityMailbox.js';
import type { Envelope, MailboxDropReason } from '../../../src/internal/Mailbox.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const FENCE = 'fence — every earlier letter is already queued';

const systems: ActorSystem[] = [];

afterEach(async () => {
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

function startSystem(name: string): ActorSystem {
  const system = ActorSystem.create(
    name,
    ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
  );
  systems.push(system);
  return system;
}

/** Handles nothing in particular — the mailbox is the unit under test. */
class Sink extends Actor<unknown> {
  override onReceive(): void { /* whatever survived the bound is ignored */ }
}

type Ranked = { readonly kind: 'ranked'; readonly rank: number };

class RankedSink extends Actor<Ranked> {
  override onReceive(): void { /* as above */ }
}

/** Somebody to be the `sender` on the tells, so the letter has one to keep. */
class Bystander extends Actor<unknown> {
  override onReceive(): void { /* never told anything */ }
}

type Capture = {
  readonly letters: DeadLetter[];
  /** Publish the fence and resolve once it has been delivered. */
  readonly settle: () => Promise<void>;
};

/**
 * Subscribe to the dead-letter stream and hand back the fence.
 *
 * The listener is an ordinary actor, so its mailbox is FIFO and unbounded:
 * anything published before the fence is delivered before the fence.
 */
async function captureDeadLetters(system: ActorSystem): Promise<Capture> {
  const letters: DeadLetter[] = [];
  const subscribed = { value: false };
  class Listener extends Actor<DeadLetter> {
    override preStart(): void {
      this.system.eventStream.subscribe(this.self, DeadLetter);
      subscribed.value = true;
    }
    override onReceive(letter: DeadLetter): void { letters.push(letter); }
  }
  system.spawn(Listener, 'dead-letter-listener');
  await awaitCondition(() => subscribed.value, {
    timeoutMs: 4_000,
    label: 'the dead-letter listener subscribed',
  });
  return {
    letters,
    settle: async () => {
      system.deadLetters.tell(FENCE);
      await awaitCondition(() => letters.some((l) => l.message === FENCE), {
        timeoutMs: 4_000,
        label: 'the fence letter came back',
      });
    },
  };
}

/** The burst payloads, minus the fence — what the drops actually produced. */
const dropped = (capture: Capture): unknown[] =>
  capture.letters.filter((l) => l.message !== FENCE).map((l) => l.message);

describe('mailbox drops become dead letters when asked (#773)', () => {
  test('drop-head dead-letters the evicted message, with its sender', async () => {
    const system = startSystem('773-bounded-drop-head');
    const capture = await captureDeadLetters(system);
    const bystander = system.spawn(Bystander, 'bystander');

    const sink = system.spawn(Sink, 'sink', ActorOptions.create<unknown>().withMailbox(
      () => new BoundedMailbox({ capacity: 2, overflow: 'drop-head', deadLetterDrops: true }),
    ));
    // 1 and 2 fill the bound; 3 evicts 1, 4 evicts 2, 5 evicts 3.  The letters
    // therefore name the *queued* messages that lost their place — not the
    // arrivals, which is the whole reason the seam hands over the removed
    // envelope rather than the one being enqueued.
    for (const n of [1, 2, 3, 4, 5]) sink.tell(n, bystander);
    await capture.settle();

    expect(dropped(capture)).toEqual([1, 2, 3]);
    const first = capture.letters.find((l) => l.message === 1)!;
    expect(first.sender?.path.toString()).toBe(bystander.path.toString());
    expect(first.recipient.path.toString()).toBe(sink.path.toString());
  });

  test('drop-new dead-letters the arriving message', async () => {
    const system = startSystem('773-bounded-drop-new');
    const capture = await captureDeadLetters(system);

    const sink = system.spawn(Sink, 'sink', ActorOptions.create<unknown>().withMailbox(
      () => new BoundedMailbox({ capacity: 2, overflow: 'drop-new', deadLetterDrops: true }),
    ));
    for (const n of [1, 2, 3, 4, 5]) sink.tell(n);
    await capture.settle();

    expect(dropped(capture)).toEqual([3, 4, 5]);
  });

  test('the switch is off by default — the drop happens and no letter does', async () => {
    const system = startSystem('773-gate-off');
    const capture = await captureDeadLetters(system);

    const mailbox = new BoundedMailbox({ capacity: 2, overflow: 'drop-new' });
    const sink = system.spawn(
      Sink, 'sink', ActorOptions.create<unknown>().withMailbox(() => mailbox),
    );
    for (const n of [1, 2, 3, 4, 5]) sink.tell(n);
    await capture.settle();

    // The drops are real; only the routing is absent.  Asserting both is what
    // keeps this from passing for the wrong reason — a burst that never
    // overflowed would also produce no letters.
    expect(mailbox.droppedCount).toBe(3);
    expect(dropped(capture)).toEqual([]);
  });

  test('a system with no metrics registry still gets the letters', async () => {
    // `_onMailboxDrop` returns early when metrics are disabled, and it is the
    // same observer that routes the letter.  A dead letter that only appeared
    // for systems running an observability stack would be worthless to the
    // ones that need it most.
    const system = startSystem('773-no-metrics');
    expect(system._metricsRegistry).toBeNull();
    const capture = await captureDeadLetters(system);

    const sink = system.spawn(Sink, 'sink', ActorOptions.create<unknown>().withMailbox(
      () => new BoundedMailbox({ capacity: 1, overflow: 'drop-new', deadLetterDrops: true }),
    ));
    for (const n of [1, 2, 3]) sink.tell(n);
    await capture.settle();

    expect(dropped(capture)).toEqual([2, 3]);
    expect(system._metricsRegistry).toBeNull();
  });

  test('the letters arrive alongside the counter, not instead of it', async () => {
    const system = startSystem('773-with-metrics');
    system.extension(MetricsExtensionId).enable();
    const capture = await captureDeadLetters(system);

    const sink = system.spawn(Sink, 'sink', ActorOptions.create<unknown>().withMailbox(
      () => new BoundedMailbox({ capacity: 1, overflow: 'drop-new', deadLetterDrops: true }),
    ));
    for (const n of [1, 2, 3]) sink.tell(n);
    await capture.settle();

    expect(dropped(capture)).toEqual([2, 3]);
    await awaitCondition(
      () => system.extension(MetricsExtensionId).get().collect()
        .some((s) => s.name === 'actor_mailbox_dropped_total' && s.value === 2),
      { timeoutMs: 4_000, label: 'the drop counter reached 2' },
    );
  });

  test('a priority mailbox dead-letters whichever end lost', async () => {
    const system = startSystem('773-priority');
    const capture = await captureDeadLetters(system);

    const sink = system.spawn(RankedSink, 'sink', ActorOptions.create<Ranked>().withMailbox(
      () => new PriorityMailbox<Ranked>({
        priorityFor: (m) => m.rank,
        capacity: 2,
        overflow: 'drop-lowest-priority',
        deadLetterDrops: true,
      }),
    ));
    const ranked = (rank: number): Ranked => ({ kind: 'ranked', rank });
    // 9 and 8 fill the bound.  rank 1 outranks both, so the queued 9 is shed
    // (`drop-head`); rank 2 then displaces the queued 8.  rank 100 ranks below
    // everything left, so the *arrival* is what goes — reported `drop-new`,
    // which is the distinction the closed two-value vocabulary can still draw.
    for (const rank of [9, 8, 1, 2, 100]) sink.tell(ranked(rank));
    await capture.settle();

    expect(dropped(capture).map((m) => (m as Ranked).rank)).toEqual([9, 8, 100]);
  });
});

describe('the drop seam carries the envelope (#773)', () => {
  test('observers and onDrop both receive what was discarded', () => {
    const seen: Array<[MailboxDropReason, unknown]> = [];
    const hookSaw: Array<[MailboxDropReason, unknown]> = [];
    const mailbox = new BoundedMailbox<string>({
      capacity: 1,
      overflow: 'drop-head',
      onDrop: (reason, envelope) => hookSaw.push([reason, envelope.message]),
    });
    mailbox.observeDrops((reason, envelope) => seen.push([reason, envelope.message]));

    mailbox.enqueue({ message: 'first', sender: null });
    mailbox.enqueue({ message: 'second', sender: null });

    expect(seen).toEqual([['drop-head', 'first']]);
    // Registration order is fixed — the caller's hook is the first observer —
    // and both see the same envelope rather than one of them seeing a reason.
    expect(hookSaw).toEqual([['drop-head', 'first']]);
  });

  test('an undroppable envelope produces neither a drop nor a letter', () => {
    // The seam is the only route to a dead letter, so "no report" is "no
    // letter".  A lifecycle notification is exempt from every policy (#729);
    // what this pins is that the exemption survives the widened seam — and
    // that the envelope handed over is the one actually removed.
    const seen: Array<[MailboxDropReason, unknown]> = [];
    const mailbox = new BoundedMailbox<string>({
      capacity: 1,
      overflow: 'drop-head',
      deadLetterDrops: true,
    });
    mailbox.observeDrops((reason, envelope) => seen.push([reason, envelope.message]));

    const notification: Envelope<string> = {
      message: 'terminated',
      sender: null,
      undroppable: true,
    };
    mailbox.enqueueSignal(notification);
    // Full by the bound, but the only queued envelope may not be dropped, so
    // the arrival is admitted and nothing is reported.
    mailbox.enqueue({ message: 'ordinary', sender: null });
    expect(seen).toEqual([]);
    expect(mailbox.droppedCount).toBe(0);

    // The next arrival finds something droppable and evicts *that*, stepping
    // over the notification still sitting at the head.
    mailbox.enqueue({ message: 'later', sender: null });
    expect(seen).toEqual([['drop-head', 'ordinary']]);
  });
});

/**
 * The second half of #773, and the one the first pass deferred: what the
 * letter can say about *which request* lost the message.
 *
 * The message and the sender name what was lost and who sent it; the MDC
 * `context` and the tracing `trace` are what tie the loss back to the work
 * that produced it.  `DeadLetter` had no slot for either, so the fidelity the
 * issue asks for was unreachable in the type rather than merely unwired — and
 * this is the only loss path in the framework that still holds a whole
 * envelope at the moment it gives up on it, so it is the only one that could
 * have filled such a slot.
 */
describe('a mailbox-drop letter carries what the envelope was attributed to (#773)', () => {
  test('the MDC in force at tell time rides along', async () => {
    const system = startSystem('773-attribution-mdc');
    const capture = await captureDeadLetters(system);

    // `drop-head` deliberately, not `drop-new`.  Under `drop-new` the
    // discarded envelope *is* the arriving one, so a drop site that read
    // `LogContext.get()` off the sender's live scope instead of copying the
    // envelope's own would produce the right answer by coincidence.  Here the
    // evicted message is an older one whose context is long out of scope.
    const sink = system.spawn(Sink, 'sink', ActorOptions.create<unknown>().withMailbox(
      () => new BoundedMailbox({ capacity: 2, overflow: 'drop-head', deadLetterDrops: true }),
    ));
    // Each send under its own context, so a letter that carried the wrong one
    // — or the same one for every drop — is visible rather than plausible.
    for (const n of [1, 2, 3, 4]) {
      LogContext.run({ requestId: `request-${n}` }, () => sink.tell(n));
    }
    await capture.settle();

    // 1 and 2 fill the bound; 3 evicts 1 and 4 evicts 2.
    const lost = capture.letters.filter((l) => l.message !== FENCE);
    expect(lost.map((l) => l.message)).toEqual([1, 2]);
    expect(lost.map((l) => l.attribution.context)).toEqual([
      { requestId: 'request-1' },
      { requestId: 'request-2' },
    ]);
  });

  test('the span context in force at tell time rides along', async () => {
    const system = startSystem('773-attribution-trace');
    const tracer = new RecordingTracer();
    system.extension(TracingExtensionId).enable(tracer);
    const capture = await captureDeadLetters(system);

    const sink = system.spawn(Sink, 'sink', ActorOptions.create<unknown>().withMailbox(
      () => new BoundedMailbox({ capacity: 1, overflow: 'drop-head', deadLetterDrops: true }),
    ));
    // Two unrelated requests, and the second is what evicts the first — so a
    // drop site that read the *live* active span rather than the envelope's
    // would name `second` on a letter about `first`.  Under one span, or under
    // `drop-new`, the two answers coincide and the test would prove nothing.
    const first = tracer.startSpan('client.first-request');
    tracer.withActiveSpan(first, () => sink.tell(1));
    first.end();
    const second = tracer.startSpan('client.second-request');
    tracer.withActiveSpan(second, () => sink.tell(2));
    second.end();
    await capture.settle();

    const lost = capture.letters.filter((l) => l.message !== FENCE);
    expect(lost.map((l) => l.message)).toEqual([1]);
    // The sender's span, copied off the envelope — so the loss lands in the
    // trace of the request that produced the message, and both spans have
    // ended by now: the context is a value the envelope carried, not a handle
    // into a live span.
    expect(lost[0]!.attribution.trace?.traceId).toBe(first.context().traceId);
    expect(lost[0]!.attribution.trace?.spanId).toBe(first.context().spanId);
    expect(lost[0]!.attribution.trace?.spanId).not.toBe(second.context().spanId);
  });

  test('a letter with nothing to attribute carries an empty attribution', async () => {
    // The default, and it is the truth rather than a gap: a `tell` outside any
    // `LogContext.run` on a system with tracing disabled carries neither
    // field, so there is nothing for the drop site to copy.  Reading
    // `attribution` therefore never needs a `?.` — the object is always there.
    const system = startSystem('773-attribution-absent');
    const capture = await captureDeadLetters(system);

    const sink = system.spawn(Sink, 'sink', ActorOptions.create<unknown>().withMailbox(
      () => new BoundedMailbox({ capacity: 1, overflow: 'drop-new', deadLetterDrops: true }),
    ));
    for (const n of [1, 2]) sink.tell(n);
    await capture.settle();

    const lost = capture.letters.filter((l) => l.message !== FENCE);
    expect(lost.map((l) => l.message)).toEqual([2]);
    expect(lost[0]!.attribution).toEqual({ context: undefined, trace: undefined });
    // The fence is built by `DeadLetterRef` from a bare message and never had
    // an envelope at all, so it gets the shared empty singleton.
    const fence = capture.letters.find((l) => l.message === FENCE)!;
    expect(fence.attribution).toEqual({});
  });

  test('toString stays free of the attribution', () => {
    // The MDC routinely carries tenant, user and request identifiers, and this
    // string is what ends up pasted into an issue.  `DeadLetterRef` already
    // keeps the payload out of its log line for that reason; printing the
    // context here would put the same class of data back through another door.
    const system = startSystem('773-attribution-tostring');
    const recipient = system.spawn(Sink, 'sink');
    const letter = new DeadLetter('payload', null, recipient, {
      context: { tenantId: 'acme', userId: 'u-42' },
    });

    expect(letter.toString()).not.toContain('acme');
    expect(letter.toString()).not.toContain('tenantId');
    expect(letter.attribution.context).toEqual({ tenantId: 'acme', userId: 'u-42' });
  });
});
