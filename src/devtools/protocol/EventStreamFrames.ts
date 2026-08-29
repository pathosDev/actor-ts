/**
 * The `events` stream and the `pubsub.topics` pull (#553) — what is
 * flowing through the system's two buses.
 *
 * A stream here, unlike the dead-letter panel: the event stream has no
 * ring to pull from, the question is "what is happening *now*", and
 * every event is gone the moment it is delivered.  It is therefore
 * batched on a tick and capped, like spans — the bus carries an event on
 * every actor start, stop and restart, so a busy system publishes far
 * faster than a table can be read.
 */

/** One published event, flattened for the wire. */
export type BusEvent = {
  /**
   * Monotonic per-session counter.
   *
   * The panel needs to tell "the bus went quiet" from "my batches stopped
   * arriving", and a gap in this sequence is the only thing that
   * distinguishes them — timestamps cannot, because silence has no
   * timestamp.
   */
  readonly sequenceNumber: number;
  readonly atMs: number;
  /** Constructor name of the event, or `typeof` for a primitive. */
  readonly eventType: string;
  /** The event, sanitised to something `JSON.stringify` accepts. */
  readonly payload: unknown;
  /** True when the payload was cut to fit the wire limits. */
  readonly truncated: boolean;
};

/** A tick's worth of events. */
export type BusEventBatchPayload = {
  readonly kind: 'bus-event-batch';
  readonly atMs: number;
  readonly events: ReadonlyArray<BusEvent>;
  /**
   * How many were dropped by the cap since the last batch.
   *
   * Reported rather than hidden: a tail that silently skips is worse than
   * one that admits it, because the reader draws conclusions from what is
   * *not* there.
   */
  readonly dropped: number;
};

/** Everything the `events` stream carries. */
export type BusEventStreamPayload = BusEventBatchPayload;

/**
 * What `pubsub.topics` answers.
 *
 * Names only, because names are all the mediator offers: `CurrentTopics`
 * carries no subscriber counts, and inventing a richer query would change
 * a cluster wire type for one column in one panel.
 */
export type PubSubTopicsResult = {
  /**
   * False when `DistributedPubSub` was never started on this node — a
   * cluster-only extension, so a single-node system has no topics rather
   * than zero topics, and the panel says which.
   */
  readonly started: boolean;
  /** Topic names, sorted, as the mediator reports them. */
  readonly topics: ReadonlyArray<string>;
};

/** Events the tap buffers between flushes before it starts dropping. */
export const BUS_EVENT_BUFFER_DEFAULT = 500;

/** Rows the panel keeps in its tail.  Older ones scroll out of existence. */
export const BUS_EVENT_TAIL_ROWS = 500;

/** @internal */
export function busEventBatchPayload(
  atMs: number,
  events: ReadonlyArray<BusEvent>,
  dropped: number,
): BusEventBatchPayload {
  return { kind: 'bus-event-batch', atMs, events, dropped };
}
