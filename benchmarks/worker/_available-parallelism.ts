/**
 * How many threads this machine can actually run at once — the number an
 * `auto` worker count should resolve to.
 *
 * `navigator.hardwareConcurrency` is what `WorkerCluster.resolveWorkerCount`
 * and `worker-count-scaling.ts` read today, and inside a container it reports
 * the *host's* cores rather than the cgroup CPU quota — so `auto` there
 * over-subscribes by however much the quota is below the host.
 * `os.availableParallelism()` (Node ≥ 18.14, Bun, Deno's node compat) is
 * quota-aware on Linux, which is where containers run.  So: that first, the
 * navigator second, and the same conservative 2 the framework falls back to.
 *
 * The framework's own probe, re-exported so the suites keep one import: it
 * moved into `src/runtime/Parallelism.ts` with #1562 as the helper behind
 * `WorkerMesh`'s default worker count and #1440's `DEFAULT_WORKER_COUNT`.
 *
 * Ignored by the benchmark discovery harness — filename starts with "_".
 */
export { availableParallelism } from '../../src/runtime/Parallelism.js';
