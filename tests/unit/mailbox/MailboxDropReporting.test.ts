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
 * The first tell and the `await` are load-bearing for the `class` label:
 * `_onMailboxDrop` reads `this.actor`, which is null until the cell has
 * handled its `create` system message, so a burst issued in the same tick as
 * the spawn is attributed to `class="unknown"`.  That is pre-existing and
 * unrelated to #1149 — it just needs the realistic ordering to be asserted
 * against, because in production a mailbox overflows long after its actor
 * exists.  (The stray `unknown` series it can mint belongs with #745.)
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
    expect(samples[0]!.labels.reason).toBe('drop-head');
    expect(samples[0]!.labels.class).toBe('Sink');
    expect(samples[0]!.labels.path).toContain('$anonymous');
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
