/**
 * A bounded window of dashboard samples, and the rate maths over it.
 *
 * The server sends cumulative counters, never deltas, so a client that
 * reconnects or misses a tick cannot corrupt its figures.  Turning
 * those into "per second" is the client's job, and it lives here rather
 * than in the panel because it is exactly the part worth testing:
 * layout can be eyeballed, arithmetic cannot.
 */
import type { StatsSamplePayload } from '../../../src/devtools/protocol/index.js';

/** One point of a derived series. */
export interface SeriesPoint {
  readonly atMs: number;
  readonly value: number;
}

/** Numeric fields of a sample that can be plotted directly. */
export type LevelField = 'actorCount' | 'mailboxBacklog';

/** Cumulative counters that only make sense as a rate. */
export type CounterField = 'actorsStarted' | 'actorsStopped' | 'actorsRestarted' | 'deadLetters';

/**
 * Ring of the most recent samples.
 *
 * Bounded by count rather than by age: the server's interval is
 * configurable, so a time bound would hold wildly different numbers of
 * points on different systems, and every consumer here cares about
 * "the recent past", not a precise duration.
 */
export class StatsHistory {
  private readonly samples: StatsSamplePayload[] = [];

  constructor(private readonly capacity: number) {}

  /** Append a sample, evicting the oldest once full. */
  push(sample: StatsSamplePayload): void {
    this.samples.push(sample);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  /** Most recent sample, or `null` before the first one arrives. */
  latest(): StatsSamplePayload | null {
    return this.samples.length === 0 ? null : this.samples[this.samples.length - 1]!;
  }

  get size(): number {
    return this.samples.length;
  }

  /** Drop everything — used when a gap forces a re-subscribe. */
  clear(): void {
    this.samples.length = 0;
  }

  /** A directly plottable field, as-is. */
  levels(field: LevelField): ReadonlyArray<SeriesPoint> {
    return this.samples.map((sample) => ({ atMs: sample.atMs, value: sample[field] }));
  }

  /**
   * Per-second rate of a cumulative counter.
   *
   * One point fewer than there are samples — a rate needs two readings.
   * A counter that went backwards means the server restarted and began
   * counting again; that yields 0 rather than a nonsensical negative
   * spike.
   */
  rates(field: CounterField): ReadonlyArray<SeriesPoint> {
    const out: SeriesPoint[] = [];
    for (let i = 1; i < this.samples.length; i++) {
      const previous = this.samples[i - 1]!;
      const current = this.samples[i]!;
      const elapsedSeconds = (current.atMs - previous.atMs) / 1000;
      if (elapsedSeconds <= 0) continue;
      const delta = current[field] - previous[field];
      out.push({ atMs: current.atMs, value: delta < 0 ? 0 : delta / elapsedSeconds });
    }
    return out;
  }

  /** Most recent rate value, or 0 before two samples exist. */
  latestRate(field: CounterField): number {
    const points = this.rates(field);
    return points.length === 0 ? 0 : points[points.length - 1]!.value;
  }
}

/** Largest value in a series, or 0 when empty. */
export function peakOf(points: ReadonlyArray<SeriesPoint>): number {
  let peak = 0;
  for (const point of points) if (point.value > peak) peak = point.value;
  return peak;
}
