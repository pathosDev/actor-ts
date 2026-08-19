/**
 * `actor_mailbox_wait_seconds` — how long a user message sat queued before
 * its turn (#196).
 *
 * The companion to `actor_message_handler_seconds`, which starts measuring
 * only once the message is already being handled: an actor that is slow and
 * an actor that is merely behind look identical there and differ here.
 *
 * Most of what these cases pin is *which messages are left out*.  The stamp
 * they read is the same one the explain plan reads, and the explain plan
 * deliberately counts stash residency as mailbox wait — so the interesting
 * assertions are the ones proving this family does not.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MAILBOX_WAIT_BUCKETS_SECONDS } from '../../../src/metrics/Constants.js';
import { DEFAULT_HISTOGRAM_BUCKETS } from '../../../src/metrics/Metrics.js';
import type { MetricsRegistry, MetricSample } from '../../../src/metrics/Metrics.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

const WAIT = 'actor_mailbox_wait_seconds';

function samplesOf(registry: MetricsRegistry): ReadonlyArray<MetricSample> {
  return registry.collect().filter((s) => s.name === WAIT);
}

/** The `_sum` / `_count` sample — the one entry that carries neither bucket. */
function totals(registry: MetricsRegistry): { count: number; sum: number } {
  const summary = samplesOf(registry).find((s) => s.count !== undefined);
  return { count: summary?.count ?? 0, sum: summary?.sum ?? 0 };
}

function bucketBoundaries(registry: MetricsRegistry): ReadonlyArray<number> {
  return samplesOf(registry)
    .filter((s) => s.bucket !== undefined)
    .map((s) => s.bucket!);
}

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, options);
}

/** Sleeps on `slow`, returns immediately otherwise. */
class Sluggish extends Actor<string> {
  override async onReceive(message: string): Promise<void> {
    // A fixture: this delay IS the mailbox wait the histogram is meant to record,
    // so the handler has to genuinely occupy the actor while the next message
    // queues behind it.
    if (message === 'slow') await sleep(80);
  }
}

/** Parks `stash-me` until `unstash` arrives, then replays it. */
class Stasher extends Actor<string> {
  private accepting = false;
  override onReceive(message: string): void {
    if (message === 'stash-me' && !this.accepting) { this.context.stash(); return; }
    if (message === 'unstash') { this.accepting = true; this.context.unstashAll(); }
  }
}

describe('actor_mailbox_wait_seconds', () => {
  test('uses a sub-5ms bucket ladder rather than the library defaults (#998)', async () => {
    const system = newSystem('wait-buckets');
    const registry = system.extension(MetricsExtensionId).enable();
    try {
      const ref = system.spawn(Sluggish, 'a');
      ref.tell('quick');
      await awaitCondition(() => totals(registry).count >= 1, {
        timeoutMs: 4_000,
        label: 'the first observation landed',
      });

      // The registry appends the `+Inf` bucket itself, so the declared
      // ladder is the whole series minus that last boundary.
      const boundaries = bucketBoundaries(registry);
      expect(boundaries).toEqual([...MAILBOX_WAIT_BUCKETS_SECONDS, Infinity]);
      // The point of the family having its own ladder: a mailbox that is
      // keeping up drains in well under the 5 ms the defaults start at, so
      // the default first boundary would answer every question with "all of
      // it is in bucket one".
      expect(boundaries[0]).toBe(0.001);
      expect(boundaries).not.toEqual([...DEFAULT_HISTOGRAM_BUCKETS]);
    } finally {
      await system.terminate();
    }
  });

  test('carries no labels at all, so it cannot grow a per-actor dimension (#658)', async () => {
    const system = newSystem('wait-labels');
    const registry = system.extension(MetricsExtensionId).enable();
    try {
      system.spawn(Sluggish, 'a').tell('quick');
      await awaitCondition(() => totals(registry).count >= 1, {
        timeoutMs: 4_000,
        label: 'the first observation landed',
      });
      // #658 took `path` off the drop counter and set the policy: a stock
      // label's values must be bounded by what the deployment declares.
      // This family sidesteps it by having no labels to bound — which also
      // keeps it clear of `renderLabels` not validating anything (#784).
      for (const sample of samplesOf(registry)) {
        expect(Object.keys(sample.labels)).toEqual([]);
      }
    } finally {
      await system.terminate();
    }
  });

  test('records the time a message spent queued behind a slow handler', async () => {
    const system = newSystem('wait-queued');
    const registry = system.extension(MetricsExtensionId).enable();
    try {
      const ref = system.spawn(Sluggish, 'a');
      // Both are enqueued now; the second cannot be handled until the first
      // handler's 80 ms sleep is over, so its wait is that sleep.
      ref.tell('slow');
      ref.tell('queued-behind-it');
      await awaitCondition(() => totals(registry).count >= 2, {
        timeoutMs: 4_000,
        label: 'both messages were delivered',
      });

      const { count, sum } = totals(registry);
      expect(count).toBe(2);
      // The first waited ~0; the second waited out the sleep.  A generous
      // floor — the assertion is that real queueing shows up at all, not
      // that the scheduler is punctual.
      expect(sum).toBeGreaterThan(0.05);
    } finally {
      await system.terminate();
    }
  });

  test('leaves a replayed stashed message out, so stash time is not read as queue time', async () => {
    const system = newSystem('wait-stash');
    const registry = system.extension(MetricsExtensionId).enable();
    try {
      const ref = system.spawn(Stasher, 'a');
      ref.tell('stash-me');            // fresh — handled (stashes), ~0 wait
      await sleep(120);                // …and sits in the stash for this long
      ref.tell('unstash');             // fresh — handled, ~0 wait
      // Three handlings happen in total; the third is the replay.
      await awaitCondition(
        () => (system.extension(MetricsExtensionId).get().collect()
          .find((s) => s.name === 'actor_messages_delivered_total')?.value ?? 0) >= 3,
        { timeoutMs: 4_000, label: 'the replay was delivered too' },
      );

      const { count, sum } = totals(registry);
      // Two of the three deliveries are fresh arrivals; the replay carries
      // the stamp of an arrival 120 ms ago that predates its current
      // residency, and is skipped rather than counted as a 120 ms queue.
      expect(count).toBe(2);
      // The guard that makes the count meaningful: had the replay been
      // observed it would have contributed ≥ 0.12 s on its own.
      expect(sum).toBeLessThan(0.1);
    } finally {
      await system.terminate();
    }
  });

  test('is not emitted at all while metrics are disabled', async () => {
    const system = newSystem('wait-off');
    try {
      const ref = system.spawn(Sluggish, 'a');
      ref.tell('slow');
      ref.tell('queued-behind-it');
      // An absence: with metrics disabled the family must not exist at all, so the
      // window is what would give a stray sample time to appear.  `toEqual([])` is
      // already true when the wait starts.
      await sleep(150);
      // Nothing stamps and nothing observes: the registry is the noop, so
      // the family does not exist.  This is the #411 property the stamp is
      // gated on — a system that instruments nothing pays no clock read.
      expect(samplesOf(system.extension(MetricsExtensionId).get())).toEqual([]);
    } finally {
      await system.terminate();
    }
  });
});
