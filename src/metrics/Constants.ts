/**
 * Tuned values used by the metrics subsystem.
 *
 * Anything a caller can set belongs in an `XOptions.ts` instead — see
 * `MetricsRegistryOptions.ts` for the registry's cardinality cap.
 *
 * This module imports nothing, so it can never close an import cycle.
 */

/**
 * How often {@link MailboxDepthSampler} walks the actor tree.
 *
 * Sampling rather than eventing: a mailbox's depth changes on every enqueue
 * and dequeue, which is the hottest path in the framework, so an event per
 * change would cost more than the actors being measured.  A depth *at an
 * instant* is also exactly what "which actors are falling behind?" asks.
 *
 * Two seconds is well under a typical 15 s Prometheus scrape, so a scrape
 * never reads a value older than it is, and far above the cost of one tree
 * walk.
 */
export const DEFAULT_MAILBOX_DEPTH_SAMPLE_INTERVAL_MS = 2_000;

/**
 * Queue depth below which no `actor_mailbox_size` series is minted.
 *
 * Not a display filter — a cardinality bound.  The registry mints a child
 * per label tuple and has no per-child eviction (`clear()` wipes the whole
 * thing), and `path` under sharding is `entity-<id>` where the id comes from
 * whoever addressed the shard region (#745).  A gauge over *every* actor
 * would therefore let a remote party mint a permanent series per entity id
 * for free.
 *
 * **This floor is why the gauge keeps its `path` when #658 took it off
 * `actor_mailbox_dropped_total`.**  The rule the removal established is that
 * a stock label's values must be bounded by what the deployment declares,
 * never by traffic or by a remote party — and the two families sit on
 * opposite sides of it.  A bounded mailbox sheds as its *designed* steady
 * state, so a path-labelled drop counter minted a permanent series per actor
 * in a healthy system.  This gauge mints one only for an actor that has let
 * 10 000 messages pile up, so its width counts concurrent incidents, not
 * entities, and on a healthy system it is empty.
 *
 * The label is also constitutive here rather than descriptive: `sample()`
 * walks the tree calling `.set()` once per cell, so collapsing the tuple
 * would leave every actor of a class overwriting its siblings within a
 * single pass and export whichever one the walk reached last.  Dropping
 * `path` would not make this gauge coarser, it would make it wrong — a
 * per-class depth signal has to be a different metric, not this one with a
 * label removed.
 *
 * Set at the high-water mark, so minting a series costs a sustained backlog
 * of that many messages on one actor — the price #745 weighed and rated LOW.
 * `DEFAULT_MAX_SERIES_PER_FAMILY` is the backstop behind it.
 *
 * Kept numerically in step with `internal/Constants.ts`'s
 * `MAILBOX_HIGH_WATER_MARK` rather than importing it: `src/metrics` and
 * `src/internal` are separate top-level subsystems, and a shared constant
 * would have to move to `src/util` and couple them for no gain.  They answer
 * different questions that happen to have the same answer — "when is this
 * worth telling a human" and "when is this worth a metric series".
 */
export const MAILBOX_DEPTH_REPORTING_FLOOR = 10_000;
