/**
 * `actor_mailbox_depth` — the *distribution* of queue depth (#196).
 *
 * #196 asked for a depth histogram with the reasoning "most actors have
 * mailbox depth 0-1; some have spikes to 1000+ — a histogram reveals the
 * tail".  What shipped first, under #1148, was `actor_mailbox_size`: a gauge,
 * sampled every 2 s, that mints no series at all below
 * `MAILBOX_DEPTH_REPORTING_FLOOR`.  That floor is load-bearing — it is what
 * keeps the gauge's remote-derived `path` label affordable (#745) — so the two
 * are complementary rather than redundant, and the *last* test here is the one
 * that proves it: the same burst the histogram resolves in detail leaves the
 * gauge completely silent.
 *
 * Every case below therefore pins a property the gauge cannot have: a
 * distribution rather than an instant, coverage of the 1-9 999 range, and no
 * labels at all.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  MAILBOX_DEPTH_BUCKETS_MESSAGES,
  MAILBOX_DEPTH_REPORTING_FLOOR,
  MAILBOX_WAIT_BUCKETS_SECONDS,
} from '../../../src/metrics/Constants.js';
import { DEFAULT_HISTOGRAM_BUCKETS } from '../../../src/metrics/Metrics.js';
import type { MetricsRegistry, MetricSample } from '../../../src/metrics/Metrics.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

const DEPTH = 'actor_mailbox_depth';
const SIZE = 'actor_mailbox_size';

function samplesOf(registry: MetricsRegistry): ReadonlyArray<MetricSample> {
  return registry.collect().filter((s) => s.name === DEPTH);
}

/** The `_sum` / `_count` sample — the one entry that carries neither bucket. */
function totals(registry: MetricsRegistry): { count: number; sum: number } {
  const summary = samplesOf(registry).find((s) => s.count !== undefined);
  return { count: summary?.count ?? 0, sum: summary?.sum ?? 0 };
}

/** Cumulative observations at or below `boundary`. */
function cumulativeAt(registry: MetricsRegistry, boundary: number): number {
  return samplesOf(registry).find((s) => s.bucket === boundary)?.value ?? 0;
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

/** Handles everything instantly, so a queue only builds while it is starting. */
class Counting extends Actor<number> {
  handled = 0;
  override onReceive(_message: number): void { this.handled++; }
}

/**
 * Parks the first message until told to resume, so a backlog can be built to
 * a known depth without racing the drain.
 *
 * `gate` is a promise the handler awaits, not a sleep: the depth under test is
 * "how much piled up while one handler was busy", and a timed handler would
 * make that depth a function of how fast the machine enqueues.
 */
class Gated extends Actor<string> {
  private static release: (() => void) | null = null;
  static gate: Promise<void> = new Promise<void>((resolve) => { Gated.release = resolve; });
  static open(): void { Gated.release?.(); }
  static reset(): void {
    Gated.gate = new Promise<void>((resolve) => { Gated.release = resolve; });
  }
  override async onReceive(message: string): Promise<void> {
    if (message === 'hold') await Gated.gate;
  }
}

describe('actor_mailbox_depth', () => {
  test('has its own ladder, topped at the gauge\'s reporting floor', async () => {
    const system = newSystem('depth-buckets');
    const registry = system.extension(MetricsExtensionId).enable();
    try {
      system.spawn(Counting, 'a').tell(1);
      await awaitCondition(() => totals(registry).count >= 1, {
        timeoutMs: 4_000,
        label: 'the first depth observation landed',
      });

      // The registry appends `+Inf` itself, so the declared ladder is the
      // whole series minus that last boundary.
      const boundaries = bucketBoundaries(registry);
      expect(boundaries).toEqual([...MAILBOX_DEPTH_BUCKETS_MESSAGES, Infinity]);
      // Counts, not seconds — sharing the wait family's ladder would put
      // every real depth in the `+Inf` bucket, and the client-library
      // defaults are seconds too (#998).
      expect(boundaries).not.toEqual([...MAILBOX_WAIT_BUCKETS_SECONDS, Infinity]);
      expect(boundaries).not.toEqual([...DEFAULT_HISTOGRAM_BUCKETS, Infinity]);
      // The hand-off to `actor_mailbox_size`: everything past the last real
      // boundary is an actor that gauge is already reporting by path, so the
      // two families cover 1-∞ between them with no gap and no overlap.
      expect(boundaries[boundaries.length - 2]).toBe(MAILBOX_DEPTH_REPORTING_FLOOR);
    } finally {
      await system.terminate();
    }
  });

  test('counts the message being delivered, so a quiet actor reads 1 and never 0', async () => {
    const system = newSystem('depth-quiet');
    const registry = system.extension(MetricsExtensionId).enable();
    try {
      const ref = system.spawn(Counting, 'a');
      // One message at a time, each awaited before the next is sent, so the
      // queue is provably empty behind every delivery.
      for (let i = 0; i < 3; i++) {
        ref.tell(i);
        await awaitCondition(() => totals(registry).count >= i + 1, {
          timeoutMs: 4_000,
          label: `delivery ${i + 1} was observed`,
        });
      }

      const { count, sum } = totals(registry);
      expect(count).toBe(3);
      // Three deliveries of depth exactly 1.  `mailbox.size` is the *rest* of
      // the queue at that point — zero here — so without the `+ 1` this sum
      // would be 0 and the first bucket would be unreachable.
      expect(sum).toBe(3);
      expect(cumulativeAt(registry, 1)).toBe(3);
    } finally {
      await system.terminate();
    }
  });

  test('resolves a burst the size gauge is blind to, and reveals its tail', async () => {
    Gated.reset();
    const system = newSystem('depth-burst');
    const registry = system.extension(MetricsExtensionId).enable();
    try {
      const ref = system.spawn(Gated, 'a');
      // The first message parks the handler; the next 120 pile up behind it,
      // so the deepest delivery sees a queue of 121 and the shallowest sees 1.
      ref.tell('hold');
      await awaitCondition(() => totals(registry).count >= 1, {
        timeoutMs: 4_000,
        label: 'the gate message was delivered and is now parked',
      });
      for (let i = 0; i < 120; i++) ref.tell('drain');
      Gated.open();
      await awaitCondition(() => totals(registry).count >= 121, {
        timeoutMs: 4_000,
        label: 'the whole backlog drained',
      });

      // The tail is what the issue asked to see.  Depths run 121 down to 1 as
      // the queue drains, so at least 20 observations sat above 100 — a
      // reading no instant-valued gauge can produce, because it samples every
      // 2 s and this burst is over in milliseconds.
      const { count } = totals(registry);
      const atOrBelow100 = cumulativeAt(registry, 100);
      expect(count).toBeGreaterThanOrEqual(121);
      expect(count - atOrBelow100).toBeGreaterThanOrEqual(20);
      // …and the bulk is still shallow, which is the shape that makes a
      // histogram the right instrument: a mean would have hidden both halves.
      expect(cumulativeAt(registry, 200)).toBe(count);
      expect(atOrBelow100).toBeGreaterThanOrEqual(100);
    } finally {
      Gated.open();
      await system.terminate();
    }
  });

  test('is the metric actor_mailbox_size cannot be: the same burst mints no gauge series', async () => {
    Gated.reset();
    const system = newSystem('depth-vs-gauge');
    const extension = system.extension(MetricsExtensionId);
    const registry = extension.enable();
    try {
      const ref = system.spawn(Gated, 'a');
      ref.tell('hold');
      await awaitCondition(() => totals(registry).count >= 1, {
        timeoutMs: 4_000,
        label: 'the gate message was delivered and is now parked',
      });
      for (let i = 0; i < 200; i++) ref.tell('drain');
      // Force a gauge reading while the backlog is at its deepest, rather
      // than waiting out the 2 s tick — this is the most favourable moment
      // the gauge will ever get, and it still reports nothing.
      extension._sampleMailboxDepth();
      expect(registry.collect().filter((s) => s.name === SIZE)).toEqual([]);

      Gated.open();
      await awaitCondition(() => totals(registry).count >= 201, {
        timeoutMs: 4_000,
        label: 'the whole backlog drained',
      });
      // 200 queued messages is 2 % of `MAILBOX_DEPTH_REPORTING_FLOOR`, so the
      // gauge is silent by design — the floor is what keeps its `path` label
      // affordable (#745) and lowering it is not the fix.  The histogram is
      // the different metric `metrics/Constants.ts` says a per-class depth
      // signal has to be, and it resolved the same burst in detail.
      expect(registry.collect().filter((s) => s.name === SIZE)).toEqual([]);
      expect(totals(registry).count).toBeGreaterThanOrEqual(201);
      expect(totals(registry).count - cumulativeAt(registry, 100)).toBeGreaterThanOrEqual(100);
    } finally {
      Gated.open();
      await system.terminate();
    }
  });

  test('carries no labels, so depth costs one series per bucket however many actors exist', async () => {
    const system = newSystem('depth-labels');
    const registry = system.extension(MetricsExtensionId).enable();
    try {
      // Ten actors, ten distinct paths.  A `path`-labelled family would be
      // ten series wide here and unbounded under sharding, where the path is
      // `entity-<id>` and the id comes from whoever addressed the region.
      for (let i = 0; i < 10; i++) system.spawn(Counting, `a-${i}`).tell(i);
      await awaitCondition(() => totals(registry).count >= 10, {
        timeoutMs: 4_000,
        label: 'all ten deliveries were observed',
      });

      for (const sample of samplesOf(registry)) {
        expect(Object.keys(sample.labels)).toEqual([]);
      }
      // One `+Inf`, one `_sum`/`_count` entry, one per declared boundary —
      // and that total does not move with the actor count.
      expect(samplesOf(registry)).toHaveLength(MAILBOX_DEPTH_BUCKETS_MESSAGES.length + 2);
    } finally {
      await system.terminate();
    }
  });

  test('is not emitted at all while metrics are disabled', async () => {
    const system = newSystem('depth-off');
    try {
      const ref = system.spawn(Counting, 'a');
      for (let i = 0; i < 5; i++) ref.tell(i);
      // An absence: the family must not exist, so there is no condition to
      // poll for — give the deliveries a turn and prove nothing was written.
      await sleep(60);
      const registry = system.extension(MetricsExtensionId).get();
      expect(registry.collect().filter((s) => s.name === DEPTH)).toEqual([]);
    } finally {
      await system.terminate();
    }
  });
});
