/**
 * The overview's charts, kept on the server.
 *
 * A browser that opens the panel should see the last hour, not start
 * filling an empty graph — the interesting minute is usually the one
 * before somebody went looking.  Keeping the series here rather than in
 * the browser also means a reload does not throw it away.
 *
 * Stored in tiers rather than raw.  A day at one-second resolution is
 * eighty-six thousand points per series, which is neither sendable nor
 * useful: nobody reads a day of data one second at a time.  Each tier
 * covers a longer window at a coarser step, and a query is answered from
 * the finest tier that reaches back far enough.
 */
import type { StatsSamplePayload } from '../protocol/index.js';

/** One point of the stored series. */
export interface HistoryPoint {
  /** End of the bucket this point summarises. */
  readonly atMs: number;
  /* Levels — kept as the bucket's MAXIMUM, so a spike survives being
     summarised.  Spotting spikes is the whole reason for the chart. */
  readonly actorCount: number;
  readonly mailboxBacklog: number;
  readonly stashedTotal: number;
  readonly suspendedActors: number;
  /* Cumulative counters — kept as the bucket's LAST value, so the
     client's rate maths (difference over elapsed time) stays correct
     however coarse the bucket is. */
  readonly actorsStarted: number;
  readonly actorsStopped: number;
  readonly actorsRestarted: number;
  readonly deadLetters: number;
  readonly messagesProcessed: number;
  readonly mailboxDrops: number;
}

/** One resolution of the store. */
interface Tier {
  readonly resolutionMs: number;
  readonly capacity: number;
  points: HistoryPoint[];
  /** The bucket still being filled; not yet in `points`. */
  open: HistoryPoint | null;
  openStartMs: number;
}

/**
 * Second-resolution for the recent past, coarsening with age.
 *
 * The windows overlap deliberately: a 30-minute query is answered from
 * the 15-second tier rather than the 2-minute one, because the finer
 * series is still short enough to send.
 */
const TIERS: ReadonlyArray<{ resolutionMs: number; capacity: number }> = [
  { resolutionMs: 1_000, capacity: 900 },      // 15 minutes at 1s
  { resolutionMs: 15_000, capacity: 960 },     // 4 hours at 15s
  { resolutionMs: 120_000, capacity: 720 },    // 24 hours at 2min
];

/** Longest span a client may ask for — the coarsest tier's reach. */
export const HISTORY_MAXIMUM_SPAN_MS =
  TIERS[TIERS.length - 1]!.resolutionMs * TIERS[TIERS.length - 1]!.capacity;

export class StatsHistoryStore {
  private readonly tiers: Tier[] = TIERS.map((tier) => ({
    resolutionMs: tier.resolutionMs,
    capacity: tier.capacity,
    points: [],
    open: null,
    openStartMs: 0,
  }));

  /** Fold one live sample into every tier. */
  record(sample: StatsSamplePayload): void {
    for (const tier of this.tiers) this.recordInto(tier, sample);
  }

  /**
   * The series covering `spanMs`, at the finest resolution that reaches
   * that far back.
   *
   * Answering a 24-hour question from the one-second tier would be both
   * impossible (it does not go back that far) and pointless (eighty-six
   * thousand points on a 600-pixel chart).
   */
  query(spanMs: number, nowMs = Date.now()): {
    readonly resolutionMs: number;
    readonly points: ReadonlyArray<HistoryPoint>;
  } {
    const wanted = Math.min(Math.max(spanMs, 1_000), HISTORY_MAXIMUM_SPAN_MS);
    const tier = this.tiers.find((candidate) =>
      candidate.resolutionMs * candidate.capacity >= wanted) ?? this.tiers[this.tiers.length - 1]!;

    const from = nowMs - wanted;
    const points = tier.points.filter((point) => point.atMs >= from);
    // The bucket still being filled is the most recent thing there is;
    // leaving it out would make the chart look a step behind.
    if (tier.open !== null && tier.open.atMs >= from) points.push(tier.open);
    return { resolutionMs: tier.resolutionMs, points };
  }

  private recordInto(tier: Tier, sample: StatsSamplePayload): void {
    const bucketStart = Math.floor(sample.atMs / tier.resolutionMs) * tier.resolutionMs;
    if (tier.open === null || bucketStart !== tier.openStartMs) {
      if (tier.open !== null) {
        tier.points.push(tier.open);
        if (tier.points.length > tier.capacity) {
          tier.points = tier.points.slice(tier.points.length - tier.capacity);
        }
      }
      tier.openStartMs = bucketStart;
      tier.open = pointOf(sample);
      return;
    }
    tier.open = merge(tier.open, sample);
  }
}

function pointOf(sample: StatsSamplePayload): HistoryPoint {
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

/** Levels take the peak, counters take the latest. */
function merge(open: HistoryPoint, sample: StatsSamplePayload): HistoryPoint {
  return {
    atMs: sample.atMs,
    actorCount: Math.max(open.actorCount, sample.actorCount),
    mailboxBacklog: Math.max(open.mailboxBacklog, sample.mailboxBacklog),
    stashedTotal: Math.max(open.stashedTotal, sample.stashedTotal),
    suspendedActors: Math.max(open.suspendedActors, sample.suspendedActors),
    actorsStarted: sample.actorsStarted,
    actorsStopped: sample.actorsStopped,
    actorsRestarted: sample.actorsRestarted,
    deadLetters: sample.deadLetters,
    messagesProcessed: sample.messagesProcessed,
    mailboxDrops: sample.mailboxDrops,
  };
}
