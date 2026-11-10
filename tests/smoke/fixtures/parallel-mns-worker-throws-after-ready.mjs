/**
 * A `ParallelMultiNodeSpec` worker that joins cleanly and *then* dies.
 *
 * The existing `worker-throws-at-load.mjs` cannot be reused here: a bootstrap
 * that throws before the handshake leaves the harness with no `nodes` entry, so
 * `stop()` has nothing to terminate and the thread is leaked — which on Deno
 * keeps the event loop alive and hangs the whole smoke run rather than failing
 * it.  Completing the hello/init/ready handshake first means `start()` resolves,
 * the node is registered, and `stop()` owns the teardown on every path.
 *
 * Deliberately imports nothing from actor-ts.  A bootstrap that pulled in the
 * framework would need the src/dist switch the runner does for itself, and
 * would open handles of its own; this one speaks the three frames of the
 * handshake by hand and owns exactly one timer, which fires and is gone.
 *
 * The two messaging shapes are both needed: Bun and Deno run this as a Web
 * Worker (`self.postMessage` / `self.onmessage`), Node runs it under
 * `worker_threads`, where the parent port is a module import and not a global.
 */

const DELAY_BEFORE_THROWING_MS = 50;

/** Throw out of a timer, so nothing on the stack can catch it. */
function dieUncaught() {
  setTimeout(() => {
    throw new Error('parallel-mns worker died after joining');
  }, DELAY_BEFORE_THROWING_MS);
}

function onInit(post) {
  post({ kind: 'worker-ready' });
  dieUncaught();
}

const workerScope = globalThis.self ?? globalThis;

if (typeof workerScope.postMessage === 'function') {
  // Bun / Deno — Web Worker.  `onmessage` rather than addEventListener for the
  // same reason `WorkerNode.join()` uses it: Bun dispatches worker-side frames
  // to the DOM property reliably and to a listener less so.
  const post = (message) => workerScope.postMessage(message);
  // No origin check: dedicated Worker message handler (not window.postMessage);
  // the only sender is the parent that spawned this smoke-test worker (CodeQL
  // js/missing-origin-check — false positive).
  workerScope.onmessage = (event) => {
    if (event?.data?.kind === 'worker-init') onInit(post);
  };
  post({ kind: 'worker-hello' });
} else {
  const { parentPort } = await import('node:worker_threads');
  const post = (message) => parentPort.postMessage(message);
  parentPort.on('message', (data) => {
    if (data?.kind === 'worker-init') onInit(post);
  });
  post({ kind: 'worker-hello' });
}
