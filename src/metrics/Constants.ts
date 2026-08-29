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
 * per label tuple, and `path` under sharding is `entity-<id>` where the id
 * comes from whoever addressed the shard region (#745).  A gauge over
 * *every* actor would therefore let a remote party mint a series per entity
 * id for free.
 *
 * `MetricsRegistry.remove` now takes a drained or terminated actor's series
 * back out again, so the floor bounds how many can be live at once rather
 * than how many can ever have existed — but it is still the floor that does
 * the bounding.  Eviction only reclaims what has stopped; without the floor
 * a remote party could hold an arbitrary number of entity ids above it
 * simultaneously, at one queued message each.
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

/**
 * Bucket boundaries for `actor_mailbox_wait_seconds`, in seconds.
 *
 * **Explicitly not `DEFAULT_HISTOGRAM_BUCKETS`.**  Those are the Prometheus
 * client-library defaults and start at 5 ms, which is a reasonable floor for
 * a request latency and a useless one here: a healthy actor dequeues its
 * mail in well under a millisecond, so the default ladder answers every
 * question with "all of it is in the first bucket" and the metric cannot
 * distinguish a system that is keeping up from one that is 5 ms behind.
 * #998 is open about that floor on the handler histogram; reusing the same
 * array here would reproduce it verbatim in a new family.
 *
 * A 1-2-5 ladder from 1 ms to 10 s.  Every boundary is an exact whole number
 * of milliseconds because the observation is `Date.now()` arithmetic and
 * cannot be finer — a 0.5 ms boundary would sort observations by nothing but
 * which side of a rounding step the clock happened to land on.  1 ms is
 * therefore the honest floor rather than a chosen one: everything below it
 * is reported as a zero-millisecond wait and lands in the first bucket,
 * which reads as "dequeued within a millisecond" and is exactly true.
 *
 * The top boundary is 10 s, matching the handler histogram, so the two can
 * be read on one axis; anything slower is a backlog nobody needs a bucket
 * edge to recognise.
 */
export const MAILBOX_WAIT_BUCKETS_SECONDS: ReadonlyArray<number> = Object.freeze([
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10,
]);

/**
 * Bucket boundaries for `actor_mailbox_depth`, in queued messages.
 *
 * **The histogram and the gauge answer different questions and meet at one
 * number.**  `actor_mailbox_size` reports *which* actor is behind, and pays
 * for that attribution with a `path` label it can only afford above
 * {@link MAILBOX_DEPTH_REPORTING_FLOOR} — below the floor it mints nothing at
 * all, which is the whole 1-9 999 range.  This family covers exactly that
 * range: label-free, so it costs one series per bucket no matter how many
 * actors or entities exist, and observed per delivery, so a spike between two
 * of the gauge's 2 s ticks still lands somewhere.  The price is that it cannot
 * say *whose* mailbox was deep.
 *
 * The top boundary is therefore the gauge's floor rather than a round number,
 * and it is written as that constant so the two cannot drift: everything in
 * the `+Inf` overflow bucket is, by construction, an actor the gauge is
 * already reporting by path.  Read the histogram to find out that a backlog
 * exists and how deep the tail of it goes; read the gauge to find out who.
 *
 * A 1-2-5 ladder from a single message, because the distribution this is meant
 * to reveal is extremely skewed: a healthy system puts nearly every
 * observation in the first bucket, and the question is entirely about the last
 * few. `1` is the honest floor — the observation counts the message being
 * delivered, so a quiet actor reads exactly 1 and never 0, and a `0` boundary
 * would be a bucket nothing can ever fall into.
 */
export const MAILBOX_DEPTH_BUCKETS_MESSAGES: ReadonlyArray<number> = Object.freeze([
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, MAILBOX_DEPTH_REPORTING_FLOOR,
]);

/**
 * Bucket boundaries for `actor_dispatcher_queue_delay_seconds`, in seconds.
 *
 * **This ladder is what a portable saturation signal costs.**  The metric
 * #196 asked for was `dispatcher_saturation_ratio`, a 0-1 busy fraction, and
 * the only primitive that could have produced one is
 * `performance.eventLoopUtilization`: measured on this project's three
 * supported runtimes it is *absent* on Bun, *real* on Node, and a
 * *hard-zero stub* on Deno.  A ratio that reads 0 on a third of the matrix is
 * worse than no ratio, because an alert built on it never fires and nobody
 * finds out.  Scheduling delay needs no runtime primitive — two reads of a
 * clock every runtime has — so it is the same measurement everywhere.
 *
 * A 1-5 ladder from 10 µs to 10 s, six decades in thirteen boundaries.  The
 * floor is set from measurement rather than taste: `performance.now()` resolves
 * to 100 ns on Bun 1.3, Node 26 and Deno 2.6 alike, and an unloaded hand-off
 * takes ~1 µs through `queueMicrotask` and ~3 µs through `setImmediate`.  So
 * 10 µs is a hundred resolution steps above the noise and still below every
 * healthy hop — which makes the first bucket mean "handed off immediately" and
 * the *second* one already mean "something was queued ahead of it".  Starting
 * at 1 ms, as `MAILBOX_WAIT_BUCKETS_SECONDS` does, would have collapsed the
 * entire healthy range plus two decades of early degradation into bucket one:
 * the #998 defect, in a family whose whole purpose is to notice degradation
 * early.
 *
 * Half-decade steps rather than the siblings' 1-2-5, because six decades at
 * 1-2-5 is nineteen boundaries and this family carries a `dispatcher` label —
 * bucket count multiplies by the number of dispatchers here, where the two
 * label-free mailbox families pay it once.  The top boundary is 10 s, matching
 * both siblings, so a turn's whole life — queued for a dispatcher, queued in a
 * mailbox, inside the handler — reads on one axis.
 */
export const DISPATCHER_QUEUE_DELAY_BUCKETS_SECONDS: ReadonlyArray<number> = Object.freeze([
  0.00001, 0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10,
]);
