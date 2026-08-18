/**
 * Smoke case: an uncaught throw inside a worker does not take the host down
 * (#700), and the worker that failed does not outlive the failure (#735).
 *
 * This is the only check in the tree that can prove either claim, because both
 * are runtime-specific and neither is observable from `bun test`, which spawns
 * no OS thread anywhere (#1186).  Measured before the fix: Node re-raises the
 * worker's error on the host via `process.nextTick` and exits 1 without ever
 * firing `exit`; Deno rejects an internal promise and exits 1 unless the
 * parent's handler *cancels* the event, which a bare listener does not do; only
 * Bun contained the throw on its own.  So a green Bun run says nothing about
 * the two runtimes the defect actually killed, and that is precisely the shape
 * of gap this harness exists for.
 *
 * The assertion is the case reaching its own last line at all: if containment
 * regresses, the process is gone before then and the harness reports the case
 * as a crash rather than a failure.  `spawn()` rejecting is the secondary
 * check — it proves the error reached the handshake instead of being swallowed
 * while the timeout ran its course.
 *
 * On handles: the bootstrap imports nothing and opens nothing, and the only
 * thread involved is the one `WorkerCluster` terminates on the handshake's
 * failure path.  A regression there would keep Deno's event loop alive and hang
 * this run instead of failing it — which is the AGENTS.md rule this case is
 * subject to, not an exception to it.
 */
export const name = 'worker crash containment';
export const description = 'a throwing worker bootstrap fails spawn() and leaves the host alive';

export async function run({ loadEntry }) {
  const { WorkerCluster, WorkerClusterOptions } = await loadEntry('worker');

  const workerOptions = WorkerClusterOptions.create()
    .withBootstrap(new URL('../fixtures/worker-throws-at-load.mjs', import.meta.url))
    .withWorkers(1)
    // Short, because the point is that the error arrives instead of the
    // timeout.  A run that takes this long has failed even if it reports
    // otherwise.
    .withReadyTimeoutMs(4_000)
    .withRestartPolicy('never');

  const startedAt = Date.now();
  let rejection;
  try {
    const cluster = await WorkerCluster.spawn(workerOptions);
    await cluster.terminate();
  } catch (error) {
    rejection = error;
  }

  if (rejection === undefined) {
    throw new Error('spawn() resolved for a bootstrap that throws at module load');
  }
  const elapsed = Date.now() - startedAt;
  if (elapsed >= 4_000) {
    throw new Error(
      `spawn() waited out readyTimeoutMs (${elapsed}ms) instead of failing on the worker's error`,
    );
  }
  if (!/failed during startup/.test(rejection.message)) {
    throw new Error(`unexpected rejection: ${rejection.message}`);
  }
}
