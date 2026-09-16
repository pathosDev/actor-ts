/**
 * Tuned values of the parallelism extension that have no option field.
 */

/**
 * The worker hostname the extension uses when `leader = "worker"` and the
 * mesh's hostnames were left at their defaults.  The cluster leader is the
 * lowest-addressed `up` member and addresses compare as strings, so the
 * workers lead exactly when their hostname sorts before the main thread's
 * `main` — `compute` does, and says what the side is for.
 */
export const LEADING_WORKER_HOSTNAME = 'compute';

/**
 * How much longer than its own drain budget a worker gets to acknowledge a
 * terminate before its thread is stopped regardless.  The worker runs the
 * same `system.terminate()` the main thread does, with the same
 * `shutdown-drain-timeout`, so the budget is that plus this: the time for the
 * frame to cross, the teardown to finish and the answer to come back.
 */
export const WORKER_TERMINATE_GRACE_MS = 1_000;
