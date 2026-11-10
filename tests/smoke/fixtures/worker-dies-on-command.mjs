/**
 * A `WorkerCluster` worker that joins cleanly and dies on command.
 *
 * `tests/smoke/cases/40-worker-respawn-from-error.mjs` needs a worker that
 * completes the hello/init/ready handshake, is registered as a live handle, and
 * then dies from an uncaught throw exactly once, when told to.  Neither fixture
 * already here can serve.  `worker-throws-at-load.mjs` never completes the
 * handshake, so the only thing it can prove is that `spawn()` rejects.
 * `parallel-mns-worker-throws-after-ready.mjs` throws 50 ms after *every*
 * ready, which turns a case about the restart *trigger* into a crash loop that
 * only the restart budget ends — #1254's semantics, not #1186's.  Killing the
 * first life and only it is deterministic, and it leaves exactly one live
 * replacement for the case's `terminate()` to own.
 *
 * `life` is a per-instance token, minted at module load and carried on the
 * ready frame.  `WorkerHandle.readyData` is the one channel through which the
 * main thread can tell a replacement from the worker it replaced — the slot,
 * the address and the `id` are all reused by design, and the `WorkerLike`
 * identity alone cannot say whether a handshake actually ran.
 *
 * Deliberately imports nothing from actor-ts.  A bootstrap that pulled in the
 * framework would need the src/dist switch the smoke runner does for itself,
 * and would open handles of its own; this one speaks the three frames of the
 * handshake by hand and owns exactly one timer, armed only on `die`, which
 * fires and is gone with the thread.
 *
 * The two messaging shapes are both needed: Bun and Deno run this as a Web
 * Worker (`self.postMessage` / `self.onmessage`), Node runs it under
 * `worker_threads`, where the parent port is a module import and not a global.
 */

/**
 * Long enough that the throw lands in a fresh turn, short enough that the
 * case's own budget never notices it.
 */
const DELAY_BEFORE_THROWING_MS = 10;

/** Distinguishes this life of the slot from the one before and the one after. */
const life = crypto.randomUUID();

/** Throw out of a timer, so nothing on the stack can catch it. */
function dieUncaught() {
  setTimeout(() => {
    throw new Error(`worker life ${life} died on command`);
  }, DELAY_BEFORE_THROWING_MS);
}

/**
 * The `self` echo is fidelity to `WorkerNode.join()`'s ready frame rather than
 * a requirement — `WorkerCluster.handshake` reads only `data`.
 */
function onInit(post, init) {
  post({ kind: 'worker-ready', self: init.self, data: { life } });
}

function onCommand(post, frame) {
  if (frame?.kind === 'worker-init') onInit(post, frame);
  else if (frame?.kind === 'die') dieUncaught();
  // Anything else — transport frames, a second init — is ignored, as a real
  // bootstrap ignores what it does not understand.
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
  workerScope.onmessage = (event) => onCommand(post, event?.data);
  post({ kind: 'worker-hello' });
} else {
  const { parentPort } = await import('node:worker_threads');
  const post = (message) => parentPort.postMessage(message);
  parentPort.on('message', (data) => onCommand(post, data));
  post({ kind: 'worker-hello' });
}
