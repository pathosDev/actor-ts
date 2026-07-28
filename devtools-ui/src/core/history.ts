/**
 * A bounded window of dashboard samples, and the rate maths over it.
 *
 * The server sends cumulative counters, never deltas, so a client that
 * reconnects or misses a tick cannot corrupt its figures.  Turning
 * those into "per second" is the client's job, and it lives here rather
 * than in the panel because it is exactly the part worth testing:
 * layout can be eyeballed, arithmetic cannot.
 */
import type {
  StatsHistoryPoint,
  StatsSamplePayload,
} from '../../../src/devtools/protocol/index.js';

/** One point of a derived series. */
export interface SeriesPoint {
  readonly atMs: number;
  readonly value: number;
}

/** Numeric fields of a sample that can be plotted directly. */
export type LevelField =
  | 'actorCount'
  | 'mailboxBacklog'
  | 'stashedTotal'
  | 'suspendedActors';

/** Cumulative counters that only make sense as a rate. */
export type CounterField =
  | 'actorsStarted'
  | 'actorsStopped'
  | 'actorsRestarted'
  | 'deadLetters'
  | 'messagesProcessed'
  | 'mailboxDrops';

/**
 * The charted window: the server's recorded series, extended live.
 *
 * Bounded by *time* rather than by count, because the two sources have
 * different resolutions — a seeded day arrives in two-minute buckets
 * while live samples land every second — and only a time bound means
 * "the last hour" regardless of the mix.
 */
export class StatsHistory {
  /** The plotted series — seeded from the server, extended live. */
  private points: StatsHistoryPoint[] = [];
  /** The newest full sample, which the tiles read.  Not a series. */
  private newest: StatsSamplePayload | null = null;
  /** How far back the charts are asked to reach. */
  private spanMs: number;

  constructor(private readonly capacity: number, spanMs: number) {
    this.spanMs = spanMs;
  }

  /**
   * Replace the series with the server's, keeping the newest sample.
   *
   * The server has been recording since it attached, so a panel opened
   * ten minutes in gets those ten minutes rather than an empty chart
   * that fills as you watch.
   */
  seed(points: ReadonlyArray<StatsHistoryPoint>, spanMs: number): void {
    this.spanMs = spanMs;
    this.points = [...points];
    this.trim();
  }

  /** Append a live sample, evicting what has aged out of the span. */
  push(sample: StatsSamplePayload): void {
    this.newest = sample;
    this.points.push(pointOf(sample));
    this.trim();
  }

  /** Most recent sample, or `null` before the first one arrives. */
  latest(): StatsSamplePayload | null {
    return this.newest;
  }

  get size(): number {
    return this.points.length;
  }

  /** Drop everything — used when a gap forces a re-subscribe. */
  clear(): void {
    this.points.length = 0;
    this.newest = null;
  }

  /**
   * Bounded by time first, count second.
   *
   * Seeded points are coarse and live ones are per-second, so a count
   * alone would mean wildly different windows depending on how long the
   * panel has been open.  The count is only a backstop against a very
   * long session on a very short span.
   */
  private trim(): void {
    const oldest = (this.points[this.points.length - 1]?.atMs ?? 0) - this.spanMs;
    let from = 0;
    while (from < this.points.length && this.points[from]!.atMs < oldest) from++;
    if (from > 0) this.points = this.points.slice(from);
    if (this.points.length > this.capacity) {
      this.points = this.points.slice(this.points.length - this.capacity);
    }
  }

  /** A directly plottable field, as-is. */
  levels(field: LevelField): ReadonlyArray<SeriesPoint> {
    return this.points.map((point) => ({ atMs: point.atMs, value: point[field] }));
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
    for (let i = 1; i < this.points.length; i++) {
      const previous = this.points[i - 1]!;
      const current = this.points[i]!;
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

/** The charted fields of a live sample. */
function pointOf(sample: StatsSamplePayload): StatsHistoryPoint {
  return {
    atMs: sample.atMs,
    actorCount: sample.actorCount,
    mailboxBacklog: sample.mailboxBacklog,
    stashedTotal: sample.stashedTotal,
    suspendedActors: sample.suspendedActors,
    actorsStarted: sample.actorsStarted,
    actorsStopped: sample.actorsStopped,
    actorsRestarted: sample.actorsRestarted,
    deadLetters: sample.deadLetters,
    messagesProcessed: sample.messagesProcessed,
    mailboxDrops: sample.mailboxDrops,
  };
}

/** Largest value in a series, or 0 when empty. */
export function peakOf(points: ReadonlyArray<SeriesPoint>): number {
  let peak = 0;
  for (const point of points) if (point.value > peak) peak = point.value;
  return peak;
}
