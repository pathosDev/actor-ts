import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { BoundedMailbox } from '../../../src/mailbox/BoundedMailbox.js';
import { PriorityMailbox } from '../../../src/mailbox/PriorityMailbox.js';
import { Mailbox, type Envelope, type MailboxDropReason } from '../../../src/internal/Mailbox.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import type { MetricSample } from '../../../src/metrics/Metrics.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * #1149 — `actor_mailbox_dropped_total` was fed by an `onDrop` the cell passed
 * into the mailbox it *constructed*, so a mailbox the caller supplied through
 * `withMailbox` reported nothing.  That was tolerable while the default was
 * bounded and most bounded mailboxes were the framework's own; #1148 made
 * bounding an opt-in and both ways of opting in equally idiomatic.
 *
 * The wiring now runs after the mailbox is chosen, through a structural probe,
 * so every shape reports — including a subclass the framework has never heard
 * of.
 */

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
  system.extension(MetricsExtensionId).enable();
  return system;
}

const dropSamples = (system: ActorSystem): ReadonlyArray<MetricSample> =>
  system.extension(MetricsExtensionId).get().collect()
    .filter((s) => s.name === 'actor_mailbox_dropped_total');

/**
 * Wedges the actor so a burst really queues, and returns the release.
 *
 * The first tell and the `await` are load-bearing for the *wedge*: without a
 * round-trip the actor is not yet parked on the latch when the burst arrives,
 * so which messages a `drop-head` mailbox sheds depends on how far the drain
 * got, and the tests below want a deterministic overflow.
 *
 * They used to be load-bearing for the `class` label too — `_onMailboxDrop`
 * read `this.actor`, which is null until the cell has handled its `create`
 * system message, so a burst issued in the same tick as the spawn was
 * attributed to `class="unknown"`.  #745 fixed that by holding such drops
 * until the name is known; the same-tick case is now asserted directly, at
 * the bottom of this file, rather than avoided here.
 */
async function floodBehindLatch(
  system: ActorSystem,
  options: ActorOptions<number>,
  count: number,
): Promise<() => void> {
  let release: () => void = () => {};
  const latch = new Promise<void>((resolve) => { release = resolve; });

  class Sink extends Actor<number> {
    override async onReceive(n: number): Promise<void> { if (n === 0) await latch; }
  }
  const ref = system.spawnAnonymous(Sink, options);
  ref.tell(0);                 // wedges the actor on the latch
  await Bun.sleep(10);         // ... and lets the instance come into existence
  for (let i = 1; i <= count; i++) ref.tell(i);
  return release;
}

describe('mailbox drop reporting (#1149)', () => {
  test('a withMailbox-supplied BoundedMailbox reaches the counter, with labels', async () => {
    const system = startSystem('drop-supplied');
    const options = ActorOptions.create<number>()
      .withMailbox(() => new BoundedMailbox<number>({ capacity: 4, overflow: 'drop-head' }) as never);

    const release = await floodBehindLatch(system, options, 64);

    const samples = dropSamples(system);
    expect(samples.length).toBe(1);
    expect(samples[0]!.value).toBeGreaterThan(0);
    // The exact set, not just its members: until #658 there was a third
    // label, `path`, and this asserted it contained `$anonymous`.  That was
    // the defect stated as an expectation — one permanent series per
    // dropping actor — so the assertion was deleted rather than repaired.
    expect(samples[0]!.labels).toEqual({ class: 'Sink', reason: 'drop-head' });
    release();
  });

  test('withMailboxCapacity still reports — the built-in path did not regress', async () => {
    const system = startSystem('drop-capacity');
    const options = ActorOptions.create<number>()
      .withMailboxCapacity(4)
      .withMailboxOverflow('drop-new');

    const release = await floodBehindLatch(system, options, 64);

    const samples = dropSamples(system);
    expect(samples.length).toBe(1);
    expect(samples[0]!.value).toBeGreaterThan(0);
    expect(samples[0]!.labels.reason).toBe('drop-new');
    release();
  });

  test('a bounded PriorityMailbox reports through the same probe (#647)', async () => {
    // The second built-in bound.  It shares the drop bookkeeping with
    // `BoundedMailbox` through `DroppingMailbox` rather than reimplementing
    // it, which is what keeps it out of the failure mode #1149 fixed: a
    // second copy of the wiring is a second chance to leave the observer out.
    const system = startSystem('drop-priority');
    const options = ActorOptions.create<number>().withMailbox(
      // Negated so every arrival outranks the backlog and the *tail* is what
      // gets shed — the `drop-head` reason rather than `drop-new`.
      () => new PriorityMailbox<number>({
        priorityFor: (n) => -n,
        capacity: 4,
        overflow: 'drop-lowest-priority',
      }) as never,
    );

    const release = await floodBehindLatch(system, options, 64);

    const samples = dropSamples(system);
    expect(samples.length).toBe(1);
    expect(samples[0]!.value).toBeGreaterThan(0);
    expect(samples[0]!.labels.reason).toBe('drop-head');
    expect(samples[0]!.labels.class).toBe('Sink');
    release();
  });

  test('a caller-supplied onDrop still fires — the observer is additive, not a setter', async () => {
    // The whole reason `observeDrops` appends instead of assigning: someone
    // who wired their own metric must not lose it because the framework
    // wired the stock one.
    const system = startSystem('drop-additive');
    const mine: MailboxDropReason[] = [];
    const options = ActorOptions.create<number>().withMailbox(
      () => new BoundedMailbox<number>({
        capacity: 4,
        overflow: 'drop-head',
        onDrop: (reason) => { mine.push(reason); },
      }) as never,
    );

    const release = await floodBehindLatch(system, options, 64);

    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine)).toEqual(new Set(['drop-head']));
    // Both ran for the same drops.
    expect(dropSamples(system)[0]!.value).toBe(mine.length);
    release();
  });

  test('a Mailbox subclass of your own is counted once it reports', async () => {
    // The probe is structural, so a queue that discards for its own reasons
    // is not second-class — which is why this is an interface rather than an
    // `instanceof BoundedMailbox` check.
    class EverySecondMailbox<T> extends Mailbox<T> {
      private seen = 0;
      private readonly observers: Array<(reason: MailboxDropReason) => void> = [];

      observeDrops(observer: (reason: MailboxDropReason) => void): void {
        this.observers.push(observer);
      }

      override enqueue(envelope: Envelope<T>): void {
        if (++this.seen % 2 === 0) {
          for (const observer of this.observers) observer('drop-new');
          return;
        }
        super.enqueue(envelope);
      }
    }

    const system = startSystem('drop-custom');
    const options = ActorOptions.create<number>()
      .withMailbox(() => new EverySecondMailbox<number>() as never);

    const release = await floodBehindLatch(system, options, 20);

    const samples = dropSamples(system);
    expect(samples.length).toBe(1);
    expect(samples[0]!.value).toBe(10);
    expect(samples[0]!.labels.reason).toBe('drop-new');
    release();
  });

  test('a mailbox that does not report is left alone', async () => {
    // No `observeDrops`, no wiring, no crash — the probe has to tolerate the
    // ordinary case of a queue that simply never drops.
    const system = startSystem('drop-silent');
    const options = ActorOptions.create<number>()
      .withMailbox(() => new Mailbox<number>() as never);

    const release = await floodBehindLatch(system, options, 64);

    expect(dropSamples(system)).toEqual([]);
    release();
  });

  test('two cells sharing one mailbox instance both observe it', () => {
    // Sharing is a documented mistake, but `observeDrops` appending rather
    // than assigning means the second cell does not silently unhook the
    // first — the failure stays visible instead of becoming a missing metric.
    const shared = new BoundedMailbox<number>({ capacity: 2, overflow: 'drop-head' });
    const reasons: MailboxDropReason[] = [];
    shared.observeDrops((reason) => { reasons.push(reason); });
    shared.observeDrops((reason) => { reasons.push(reason); });

    for (let i = 0; i < 5; i++) shared.enqueue({ message: i, sender: null });

    expect(shared.droppedCount).toBe(3);
    expect(reasons.length).toBe(6);       // three drops, two observers each
  });
});

/**
 * Spawns `actorCount` bounded, deliberately-overflowing actors of one class,
 * leaving each wedged mid-flood.  Returns their releases.
 *
 * Awaits a real round-trip per actor rather than reusing `floodBehindLatch`'s
 * sleep: the number of series is the thing under assertion here, and an actor
 * whose `create` has not been handled yet drops under `class="unknown"` and
 * mints a second one.  That would make the test flaky in precisely the
 * direction that looks like the defect.
 */
async function floodBoundedSinks(
  system: ActorSystem,
  actorCount: number,
  burst: number,
): Promise<Array<() => void>> {
  const options = ActorOptions.create<number>()
    .withMailboxCapacity(4)
    .withMailboxOverflow('drop-head');
  const releases: Array<() => void> = [];

  for (let i = 0; i < actorCount; i++) {
    let release: () => void = () => {};
    let running: () => void = () => {};
    const latch = new Promise<void>((resolve) => { release = resolve; });
    const alive = new Promise<void>((resolve) => { running = resolve; });

    class Sink extends Actor<number> {
      override async onReceive(n: number): Promise<void> {
        if (n === 0) { running(); await latch; }
      }
    }
    const ref = system.spawnAnonymous(Sink, options);
    ref.tell(0);
    await alive;                 // the instance exists, so `class` has settled
    for (let n = 1; n <= burst; n++) ref.tell(n);
    releases.push(release);
  }
  return releases;
}

describe('drop-counter cardinality (#658)', () => {
  test('the series count does not grow with the number of dropping actors', async () => {
    // #658's acceptance criterion — "spawning 10 000 anonymous actors that
    // overflow produces O(1) series" — at a size a unit test can afford.
    // Asserted by comparing two populations rather than by pinning a number
    // at one N: the property is the shape of the growth, and with `path` this
    // read 4 and 16, which satisfies any single-N expectation you care to
    // write.  Each of those series was permanent, and still would be: #745
    // gave the registry a `remove`, but evicting a *counter's* series reads
    // downstream as a reset that never happened, so it is no remedy here.  A
    // bounded mailbox sheds as its designed steady state, so a healthy system
    // paid that cardinality.
    const few = startSystem('drop-cardinality-few');
    const many = startSystem('drop-cardinality-many');

    const releases = [
      ...await floodBoundedSinks(few, 4, 32),
      ...await floodBoundedSinks(many, 16, 32),
    ];
    // Unwedged before the assertions, not after: every drop has already been
    // counted (`tell` enqueues synchronously, so the overflow fires there),
    // and a failed expectation must not leave 20 actors latched for the
    // afterEach to time out on — that turns one red assertion into a red
    // assertion plus a hook timeout.
    for (const release of releases) release();

    expect(dropSamples(many).length).toBe(dropSamples(few).length);
    expect(dropSamples(many).length).toBe(1);
    // `class` is a source-code constant and `reason` a closed two-value set,
    // which is what leaves the family bounded by the program rather than by
    // its traffic or by whoever chose the entity ids.
    expect(dropSamples(many)[0]!.labels).toEqual({ class: 'Sink', reason: 'drop-head' });
    expect(dropSamples(many)[0]!.value).toBeGreaterThan(0);
  });
});

describe('drop attribution before the instance exists (#745)', () => {
  test('a burst in the same tick as the spawn is attributed to the real class', async () => {
    // `tell` enqueues on the *sender's* stack, so nothing here yields and the
    // cell cannot have handled its `create` yet: every one of these drops
    // happens while `this.actor` is still null.  Attributing them to a
    // placeholder minted a permanent `class="unknown"` series for an actor
    // that mints its real one moments later.
    const system = startSystem('drop-same-tick');
    const options = ActorOptions.create<number>()
      .withMailboxCapacity(4)
      .withMailboxOverflow('drop-new');

    class Sink extends Actor<number> {
      override onReceive(_n: number): void { /* drains */ }
    }
    const ref = system.spawnAnonymous(Sink, options);
    for (let n = 0; n < 64; n++) ref.tell(n);

    // Nothing to poll on the counter's value — the drops are held until the
    // instance is built, so until then the series does not exist at all.
    await awaitCondition(() => dropSamples(system).length > 0, {
      timeoutMs: 4_000,
      label: 'the deferred drops reached the counter',
    });

    const samples = dropSamples(system);
    expect(samples.length).toBe(1);
    expect(samples[0]!.labels).toEqual({ class: 'Sink', reason: 'drop-new' });
    // Holding them loses nothing: four fit, sixty did not.
    expect(samples[0]!.value).toBe(60);
  });

  test('drops from both sides of the instance land on one series, not two', async () => {
    // The exact shape the issue reported: a mailbox flooded in the same tick
    // as its spawn minted `class="unknown"`, and the same actor minted its
    // real `class="Sink"` moments later — two permanent series for one actor,
    // one of them meaningless.
    const system = startSystem('drop-both-sides');
    const options = ActorOptions.create<number>()
      .withMailboxCapacity(4)
      .withMailboxOverflow('drop-new');

    const park = -1;
    let release: () => void = () => {};
    let parked: () => void = () => {};
    const latch = new Promise<void>((resolve) => { release = resolve; });
    const running = new Promise<void>((resolve) => { parked = resolve; });

    class Sink extends Actor<number> {
      override async onReceive(n: number): Promise<void> {
        if (n === park) { parked(); await latch; }
      }
    }
    const ref = system.spawnAnonymous(Sink, options);
    ref.tell(park);
    for (let n = 0; n < 23; n++) ref.tell(n);      // 24 sent, 4 queued, 20 shed

    await awaitCondition(() => dropSamples(system)[0]?.value === 20, {
      timeoutMs: 4_000,
      label: 'the deferred drops were flushed under the real class',
    });
    await running;                                 // the instance exists, and is wedged

    for (let n = 100; n < 200; n++) ref.tell(n);   // so it sheds again
    await awaitCondition(() => (dropSamples(system)[0]?.value ?? 0) > 20, {
      timeoutMs: 4_000,
      label: 'the post-instance drops were counted too',
    });

    // Unwedged before the assertions, like the #658 case above: a failed
    // expectation must not leave the actor latched for the afterEach to time
    // out on, which turns one red assertion into a red assertion plus a hook
    // timeout.  Every drop is already counted — `tell` enqueues synchronously.
    release();

    // One series carrying both halves.  Reverting the deferral splits it into
    // `{class: "unknown"}` and `{class: "Sink"}`.
    const samples = dropSamples(system);
    expect(samples.length).toBe(1);
    expect(samples[0]!.labels).toEqual({ class: 'Sink', reason: 'drop-new' });
  });

  test('a cell whose actor never starts counts its drops as class="unknown"', async () => {
    // `unknown` survives the fix, but it stops being a timing artifact and
    // starts being a signal: this cell's constructor threw, so there is no
    // class to attribute to and never will be.  Holding the counts for a name
    // that is not coming would leave the stock counter quietly short of what
    // the caller's own `onDrop` saw for the very same messages, which is what
    // the last assertion pins.
    const system = startSystem('drop-never-started');
    const mine: MailboxDropReason[] = [];
    const options = ActorOptions.create<number>().withMailbox(
      () => new BoundedMailbox<number>({
        capacity: 4,
        overflow: 'drop-new',
        onDrop: (reason) => { mine.push(reason); },
      }) as never,
    );

    class Doomed extends Actor<number> {
      constructor() { super(); throw new Error('this actor cannot be built'); }
      override onReceive(_n: number): void { /* never reached */ }
    }
    const ref = system.spawnAnonymous(Doomed, options);
    for (let n = 0; n < 64; n++) ref.tell(n);

    await awaitCondition(() => dropSamples(system).length > 0, {
      timeoutMs: 4_000,
      label: 'the held drops were released once creation had failed',
    });

    const samples = dropSamples(system);
    expect(samples.length).toBe(1);
    expect(samples[0]!.labels).toEqual({ class: 'unknown', reason: 'drop-new' });
    expect(samples[0]!.value).toBe(mine.length);
  });
});
