/**
 * `actor_dispatcher_queue_delay_seconds` — how long a turn waited between
 * being handed to a dispatcher and starting (#196).
 *
 * #196 asked for `dispatcher_saturation_ratio`, a 0-1 busy fraction. It does
 * not exist and these tests are not it. The only primitive that could have
 * produced one, `performance.eventLoopUtilization`, is **absent on Bun, real
 * on Node and a hard-zero stub on Deno** — measured, and re-asserted by
 * `tests/smoke/cases/30-metrics-saturation.mjs` on each runtime in turn. A
 * ratio that reads 0 on a third of the support matrix is worse than none,
 * because an alert built on it never fires and nobody finds out.
 *
 * Scheduling delay answers the same operational question with two reads of a
 * clock every runtime has. "100 % saturated" becomes "delay p99 exceeds your
 * latency budget", which is directly alertable, so the two cases the original
 * plan called *idle ≈ 0 %* and *saturated ≈ 100 %* are stated here as
 * *bounded* and *growing*.
 *
 * The comparison is deliberately controlled: both dispatchers below are
 * `ThroughputDispatcher(1)`, identical in every respect but the load offered
 * to them. Anything that separates their series is the load and nothing else.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ThroughputDispatcher } from '../../../src/Dispatcher.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DISPATCHER_QUEUE_DELAY_BUCKETS_SECONDS } from '../../../src/metrics/Constants.js';
import {
  DEFAULT_HISTOGRAM_BUCKETS,
  METRICS_OVERFLOW_LABEL_VALUE,
} from '../../../src/metrics/Metrics.js';
import type { MetricsRegistry, MetricSample } from '../../../src/metrics/Metrics.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { MetricsRegistryOptions } from '../../../src/metrics/MetricsRegistryOptions.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

const DELAY = 'actor_dispatcher_queue_delay_seconds';

/** Milliseconds of loop-blocking work per message in the saturation case. */
const SPIN_MS = 6;
/** Turns offered to the saturated dispatcher in one synchronous burst. */
const BURST = 16;
/** Per-family series cap used by the overflow case — small so it is reached. */
const SERIES_CAP = 3;

function samplesOf(registry: MetricsRegistry, dispatcherId?: string): ReadonlyArray<MetricSample> {
  return registry.collect().filter((s) => s.name === DELAY
    && (dispatcherId === undefined || s.labels.dispatcher === dispatcherId));
}

/** The `_sum` / `_count` entry of one dispatcher's series. */
function totals(registry: MetricsRegistry, dispatcherId: string): { count: number; sum: number } {
  const summary = samplesOf(registry, dispatcherId).find((s) => s.count !== undefined);
  return { count: summary?.count ?? 0, sum: summary?.sum ?? 0 };
}

/** Mean observed delay in seconds, or 0 when nothing was observed. */
function meanSeconds(registry: MetricsRegistry, dispatcherId: string): number {
  const { count, sum } = totals(registry, dispatcherId);
  return count === 0 ? 0 : sum / count;
}

/** Cumulative observations at or below `boundary`, for one dispatcher. */
function cumulativeAt(registry: MetricsRegistry, dispatcherId: string, boundary: number): number {
  return samplesOf(registry, dispatcherId).find((s) => s.bucket === boundary)?.value ?? 0;
}

function dispatcherLabels(registry: MetricsRegistry): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const sample of samplesOf(registry)) seen.add(String(sample.labels.dispatcher));
  return [...seen].sort();
}

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, options);
}

/** Returns immediately — the dispatcher's queue is the only thing measured. */
class Prompt extends Actor<number> {
  override onReceive(_message: number): void { /* nothing to do */ }
}

/**
 * Occupies the loop synchronously for {@link SPIN_MS}.
 *
 * Synchronous on purpose. `runSafely` does not await the unit, so an `async`
 * handler would return to the drain loop at its first `await` and the next
 * queued turn would start immediately — the saturation would be real but
 * invisible to a dispatcher-side measurement. A busy handler that never
 * yields is the shape that actually delays the queue behind it, and it is also
 * the shape an operator is trying to detect.
 */
class Occupying extends Actor<number> {
  override onReceive(_message: number): void {
    const until = performance.now() + SPIN_MS;
    while (performance.now() < until) { /* hold the loop */ }
  }
}

describe('actor_dispatcher_queue_delay_seconds', () => {
  test('resolves microseconds, because a healthy hand-off is one', async () => {
    const system = newSystem('delay-buckets');
    const registry = system.extension(MetricsExtensionId).enable();
    try {
      system.spawn(Prompt, 'a').tell(1);
      await awaitCondition(() => samplesOf(registry).length > 0, {
        timeoutMs: 4_000,
        label: 'the first delay observation landed',
      });

      const boundaries = samplesOf(registry)
        .filter((s) => s.bucket !== undefined)
        .map((s) => s.bucket!);
      expect(boundaries).toEqual([...DISPATCHER_QUEUE_DELAY_BUCKETS_SECONDS, Infinity]);
      // 10 µs, two decades below the mailbox families' 1 ms floor. An
      // unloaded `queueMicrotask` hand-off takes ~1 µs and `setImmediate`
      // ~3 µs, so a 1 ms floor would have reported every dispatcher — healthy
      // or two decades into degradation — as a single indistinguishable
      // bucket. That is #998, and this family exists to notice degradation.
      expect(boundaries[0]).toBe(0.00001);
      expect(boundaries).not.toEqual([...DEFAULT_HISTOGRAM_BUCKETS, Infinity]);
    } finally {
      await system.terminate();
    }
  });

  test('labels each series with the dispatcher that was slow, and nothing else', async () => {
    const system = newSystem('delay-labels');
    const registry = system.extension(MetricsExtensionId).enable();
    const named = new ThroughputDispatcher(1, 'named-dispatcher');
    const namedOptions = ActorOptions.create().withDispatcher(named);
    try {
      system.spawn(Prompt, 'on-the-system-dispatcher').tell(1);
      system.spawn(Prompt, 'on-its-own-dispatcher', namedOptions).tell(1);
      await awaitCondition(() => dispatcherLabels(registry).length >= 2, {
        timeoutMs: 4_000,
        label: 'both dispatchers reported a turn',
      });

      // A per-actor dispatcher is invisible to the system — nothing
      // enumerates dispatchers — so measuring cell-side is what makes it
      // appear at all.
      expect(dispatcherLabels(registry)).toContain('named-dispatcher');
      expect(dispatcherLabels(registry)).toContain(system.dispatcher.id);
      // One label only. `Dispatcher.id` is a string in the deployment's own
      // source, so its domain is bounded by code and never by traffic or by a
      // remote party — the policy #658 set. Adding an actor path here is what
      // would have needed the reporting floor `actor_mailbox_size` carries.
      for (const sample of samplesOf(registry)) {
        expect(Object.keys(sample.labels).sort()).toEqual(['dispatcher']);
      }
    } finally {
      await system.terminate();
    }
  });

  test('stays bounded for a dispatcher that is keeping up, and grows for one that is not', async () => {
    const system = newSystem('delay-saturation');
    const registry = system.extension(MetricsExtensionId).enable();
    // Identical configuration; only the offered load differs.
    const calm = new ThroughputDispatcher(1, 'calm-dispatcher');
    const saturated = new ThroughputDispatcher(1, 'saturated-dispatcher');
    const calmOptions = ActorOptions.create().withDispatcher(calm);
    const saturatedOptions = ActorOptions.create().withDispatcher(saturated);
    try {
      // Keeping up: one turn at a time, each observed before the next is
      // offered, so nothing is ever queued ahead of it.
      const calmRef = system.spawn(Prompt, 'calm', calmOptions);
      for (let i = 0; i < BURST; i++) {
        calmRef.tell(i);
        await awaitCondition(() => totals(registry, 'calm-dispatcher').count >= i + 1, {
          timeoutMs: 4_000,
          label: `the calm dispatcher's turn ${i + 1} started`,
        });
      }

      // Not keeping up: BURST cells all offer a turn in the same synchronous
      // stretch, and the dispatcher retires one per tick with SPIN_MS of
      // loop-blocking work in each. The last turn waits out every one before
      // it.
      const saturatedRefs = Array.from(
        { length: BURST },
        (_unused, i) => system.spawn(Occupying, `saturated-${i}`, saturatedOptions),
      );
      for (const ref of saturatedRefs) ref.tell(1);
      await awaitCondition(() => totals(registry, 'saturated-dispatcher').count >= BURST, {
        timeoutMs: 10_000,
        label: 'every saturated turn eventually started',
      });

      const calmMean = meanSeconds(registry, 'calm-dispatcher');
      const saturatedMean = meanSeconds(registry, 'saturated-dispatcher');
      // The backlog is triangular: turn k waits about (k-1) spins, so the
      // mean is about half of BURST spins. Asserted at a quarter of that, to
      // leave room for a machine that schedules the burst less tidily.
      const expectedMeanSeconds = (BURST * SPIN_MS) / 1_000 / 2;
      expect(saturatedMean).toBeGreaterThan(expectedMeanSeconds / 4);
      // …and the separation, which is the property an alert rests on: the two
      // dispatchers are the same class with the same throughput, so a metric
      // that could not tell them apart would be measuring nothing.
      expect(saturatedMean).toBeGreaterThan(calmMean * 20);
      // The two distributions land on opposite sides of one boundary, which
      // is what makes 10 ms writable into an alert rule. Stated as a majority
      // on each side rather than as every single observation: the guarantee a
      // scheduling metric can make is distributional, and a machine that
      // stalls once during the calm phase must not fail this.
      const calmCount = totals(registry, 'calm-dispatcher').count;
      const saturatedCount = totals(registry, 'saturated-dispatcher').count;
      expect(cumulativeAt(registry, 'calm-dispatcher', 0.01))
        .toBeGreaterThanOrEqual(Math.ceil(calmCount * 0.75));
      const pastTenMs = saturatedCount - cumulativeAt(registry, 'saturated-dispatcher', 0.01);
      expect(pastTenMs).toBeGreaterThanOrEqual(Math.floor(saturatedCount / 2));
    } finally {
      await system.terminate();
    }
  });

  test('is not emitted at all while metrics are disabled', async () => {
    const system = newSystem('delay-off');
    try {
      const ref = system.spawn(Prompt, 'a');
      for (let i = 0; i < 5; i++) ref.tell(i);
      // An absence: the family must not exist, so there is no condition to
      // poll for — give the turns time to run and prove nothing was written.
      // This is the #411 property the branch in `schedule()` protects: an
      // uninstrumented system pays no clock read and allocates no closure
      // over one.
      await sleep(60);
      const registry = system.extension(MetricsExtensionId).get();
      expect(registry.collect().filter((s) => s.name === DELAY)).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('starts measuring turns armed after enable(), not the ones already in flight', async () => {
    const system = newSystem('delay-late-enable');
    // A dispatcher of its own, so the count below is this actor's turns and
    // nothing the system happens to schedule alongside them.
    const late = new ThroughputDispatcher(1, 'late-dispatcher');
    const lateOptions = ActorOptions.create().withDispatcher(late);
    try {
      const ref = system.spawn(Prompt, 'a', lateOptions);
      ref.tell(1);
      // That turn — and the `create` command's before it — are armed against a
      // null registry, so they carry no clock read and must not be back-filled
      // with a wrong one. Give them time to complete before switching metrics
      // on; there is nothing to poll for, since the family does not exist yet.
      await sleep(30);
      const registry = system.extension(MetricsExtensionId).enable();
      expect(samplesOf(registry)).toEqual([]);

      ref.tell(2);
      await awaitCondition(() => totals(registry, 'late-dispatcher').count >= 1, {
        timeoutMs: 4_000,
        label: 'the turn armed after enable() was observed',
      });
      // Exactly the one armed afterwards. The earlier ones are absent rather
      // than observed against a clock read that never happened — the same rule
      // `Envelope.enqueuedAtMs` follows, and the reason the gate is evaluated
      // at arming time rather than at collection time.
      expect(totals(registry, 'late-dispatcher').count).toBe(1);
    } finally {
      await system.terminate();
    }
  });

  test('folds an unbounded set of dispatcher ids into one overflow series (#131)', async () => {
    const system = newSystem('delay-cardinality');
    // `Dispatcher.id` is declared by the deployment, so the label's domain is
    // as wide as the code that names it — a deployment that mints one id per
    // actor is possible, just not something traffic can cause. The registry's
    // per-family cap is the backstop for that case, and this pins that it
    // reaches this family too.
    const registryOptions = MetricsRegistryOptions.create().withMaxSeriesPerFamily(SERIES_CAP);
    const registry = system.extension(MetricsExtensionId).enable(registryOptions);
    const offered = 6;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    // Captured across the await, not just the loop: the overflow happens when
    // a turn actually starts, which is a tick after the tells. The warning is
    // a bare `console.warn` — the registry has no `ActorSystem` behind it — so
    // this is the only seam, and it keeps the noise out of the test output.
    console.warn = (...args: unknown[]): void => { warnings.push(args.map(String).join(' ')); };
    try {
      for (let i = 0; i < offered; i++) {
        const dispatcher = new ThroughputDispatcher(1, `minted-dispatcher-${i}`);
        const actorOptions = ActorOptions.create().withDispatcher(dispatcher);
        system.spawn(Prompt, `a-${i}`, actorOptions).tell(i);
      }
      await awaitCondition(
        () => dispatcherLabels(registry).includes(METRICS_OVERFLOW_LABEL_VALUE),
        { timeoutMs: 4_000, label: 'the cap folded a tuple into the overflow series' },
      );

      // At most the cap in real series plus the single overflow one, however
      // many distinct ids arrived.
      expect(offered).toBeGreaterThan(SERIES_CAP + 1);
      expect(dispatcherLabels(registry).length).toBeLessThanOrEqual(SERIES_CAP + 1);
      // The warning names the family, so an operator who sees it knows which
      // label to bound.
      expect(warnings.some((line) => line.includes(DELAY))).toBe(true);
    } finally {
      console.warn = originalWarn;
      await system.terminate();
    }
  });
});
