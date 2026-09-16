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
 * Benchmark-local for now.  #1562 lifts this into `src/util/` as the helper
 * behind `WorkerMesh`'s default worker count and #1440's
 * `DEFAULT_WORKER_COUNT`; when it lands, this file goes and both suites
 * import it from there.
 *
 * Ignored by the benchmark discovery harness — filename starts with "_".
 */
export async function availableParallelism(): Promise<number> {
  try {
    const moduleName = 'node:os';
    const os = (await import(moduleName)) as { availableParallelism?: () => number };
    const fromOs = os.availableParallelism?.();
    if (typeof fromOs === 'number' && fromOs > 0) return fromOs;
  } catch {
    /* no node:os on this runtime — fall through to the navigator */
  }
  const nav = (globalThis as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator;
  if (nav && typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0) {
    return nav.hardwareConcurrency;
  }
  return 2;
}
