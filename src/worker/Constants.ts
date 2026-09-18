/**
 * Tuned values of the worker subsystem that have no option field.
 *
 * Anything a caller can set belongs in an `XOptions.ts` instead — see
 * `WorkerMeshOptions.ts` for the relay interval.
 *
 * This module imports nothing, so it can never close an import cycle.
 */

/**
 * The most samples one relayed metrics snapshot may carry before the main
 * thread drops it whole (#1570).
 *
 * A worker's registry is bounded the way the main thread's is — at most
 * `DEFAULT_MAX_SERIES_PER_FAMILY` (10 000) series per family, developer-chosen
 * family names — but a frame off the wire is not the registry: it is whatever
 * the thread on the other end put in it, and the main side holds every
 * accepted snapshot in memory until the next one replaces it.  This is the
 * ceiling on that.
 *
 * Ten times the per-family cap.  A worker running the stock families produces
 * a few hundred samples; a counter family driven to its cap produces 10 000,
 * and a histogram family at the cap produces one row per bucket per series —
 * 150 000 for the default ladder, which is above this line.  That is the
 * intended reading: a snapshot this size is a registry that has already
 * overflowed, and the fix is the label that overflowed it, not a larger cap.
 * The worker keeps counting; the main side reports the drop once and, where
 * an earlier snapshot from that worker was accepted, its
 * `worker_mesh_snapshot_age_seconds` series keeps climbing, so the condition
 * is visible on the same scrape that lacks the series.  That series is
 * minted by the first *accepted* snapshot — a refused frame is never stored
 * — so a worker refused from its very first answer has no age series to
 * climb, and the `warn` line is the only signal.
 */
export const MAX_RELAYED_SAMPLES_PER_SNAPSHOT = 100_000;

/**
 * How many **distinct** snapshot problems the relay reports per worker before
 * it goes quiet about that worker.
 *
 * Every dropped snapshot is a `warn`, once per problem text per worker — a
 * worker whose registry carries one bad name says so once, not once per
 * relay tick.  The problem text quotes the offending name, though, and a
 * worker that mints a fresh bad name per tick would make "once per text" a
 * line per tick again.  Eight is enough to show a pattern and small enough
 * that the set kept per worker to enforce it is not itself a leak.
 */
export const MAX_REPORTED_SNAPSHOT_PROBLEMS_PER_WORKER = 8;

/**
 * How much of an offending metric name or label key a relay report quotes.
 *
 * The report has to name the string so the operator can find it, and it has
 * to `JSON.stringify` it so a newline in the string cannot forge a log line —
 * the same reasoning as `assertValidMetricName`'s message.  What that still
 * leaves open is length: a name chosen to be a megabyte would be echoed in
 * full into whatever sink the log goes to.  Eighty characters shows every
 * stock family name whole and is a fraction of a log line.
 */
export const MAX_QUOTED_PROBLEM_CHARACTERS = 80;
