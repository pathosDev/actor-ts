/**
 * Smoke case: an uncaught throw inside a `ParallelMultiNodeSpec` worker does
 * not take the host down.
 *
 * `tests/smoke/cases/29-worker-crash-containment.mjs` proves this for
 * `WorkerCluster`, which subscribes the worker's `error` event.  The testkit's
 * own multi-node harness did not, and the containment #700 added does not reach
 * it: the Web-Worker adapter cancels the event from *inside* the listener
 * `addEventListener('error', …)` installs, and the Node adapter registers
 * `on('error')` only when something subscribes.  With no subscriber there is
 * nothing to cancel and nothing registered, so Node re-raises on the host and
 * Deno rejects an internal promise — both exit 1, and the framework's own
 * parallel multi-node suites died with the process.
 *
 * This is the only check in the tree that can prove it.  Both failure modes are
 * runtime-specific and invisible from `bun test`, which spawns no OS thread
 * (#1186); Bun contains the throw on its own, so a green Bun run says nothing
 * about the two runtimes the defect actually kills.
 *
 * The assertion is the case reaching its own last line at all: if containment
 * regresses, the process is gone before then and the harness reports a crash
 * rather than a failure.  `start()` resolving is the secondary check — it
 * proves the worker really joined, so the throw lands *after* the handshake and
 * is a live-worker crash rather than a bootstrap failure.
 *
 * On handles: the fixture completes the handshake, so the harness holds a
 * registered node and `spec.stop()` terminates the thread on every path,
 * including the throwing one.  `stop()` is in a `finally` for that reason — a
 * worker abandoned here would keep Deno's event loop alive and hang the run
 * after its last green line instead of exiting, which is the AGENTS.md rule
 * this case is subject to rather than an exception to.
 */
export const name = 'parallel multi-node worker crash containment';
export const description = 'a joined ParallelMultiNodeSpec worker that throws leaves the host alive';

/** Long enough for the fixture's 50 ms timer to fire and the event to arrive. */
const SETTLE_MS = 600;

export async function run({ loadEntry }) {
  const { ParallelMultiNodeSpec } = await loadEntry('testkit');

  const spec = new ParallelMultiNodeSpec({
    roles: ['solo'],
    bootstrapModule: new URL(
      '../fixtures/parallel-mns-worker-throws-after-ready.mjs',
      import.meta.url,
    ),
  });

  let started = false;
  try {
    await spec.start();
    started = true;
    // A fixed wait, deliberately: the claim is an *absence* — that no runtime
    // tore this process down while the worker was dying — and there is no state
    // to poll for, because the only observable outcome of a regression is that
    // the lines below never run.
    await new Promise((resolve) => { setTimeout(resolve, SETTLE_MS); });
  } finally {
    await spec.stop();
  }

  if (!started) {
    throw new Error('spec.start() did not resolve — the worker never joined');
  }
}
