/**
 * The worker-side half of the runtime seam: how code *inside* a worker
 * reaches the thread that spawned it.
 *
 * `WorkerBackend` abstracts the parent's side — `new Worker(url)` on Bun and
 * Deno, `worker_threads.Worker` on Node — and the worker's side was assumed
 * to be the Web Worker globals everywhere: `self.postMessage` out,
 * `self.onmessage` in.  Node has neither.  Inside `worker_threads` there is no
 * `self`, no global `postMessage`, no `onmessage`; the parent is reached
 * through `parentPort`, a *module import* from `node:worker_threads`
 * (measured on Node 26.7: all four globals `undefined`).  So every bootstrap
 * built on `WorkerNode.join()` posted its hello into nothing on Node and sat
 * out the handshake deadline — the mesh's, the testkit's, every example's —
 * while the docs said the same code ran on all three runtimes.  The one
 * Node-capable worker script in the tree, a smoke fixture, bridged
 * `parentPort` by hand precisely because the helper did not (#1569).
 *
 * Two shapes behind one surface, chosen by what the runtime actually exposes
 * rather than by name: a Web Worker scope where the globals are there, the
 * `parentPort` where they are not.
 */

/** What a worker needs from its parent link: a way out, a way in, and a way to stop listening. */
export interface WorkerScope {
  post(value: unknown): void;
  onMessage(handler: (data: unknown) => void): void;
  offMessage(handler: (data: unknown) => void): void;
}

type WebWorkerGlobals = {
  postMessage?: (value: unknown) => void;
  onmessage?: ((event: { data: unknown }) => void) | null;
};

/**
 * The Web Worker scope — Bun, Deno, a browser — or `null` where its globals
 * are absent.  Synchronous, so a caller that finds one can post before the
 * turn ends.
 *
 * One `onmessage` dispatcher fans out to every handler, and `addEventListener`
 * is deliberately not used: Bun delivers a worker's inbound frames to the
 * `onmessage` property reliably and to a listener less so, which is the quirk
 * `WorkerNode.join()` worked around case by case before this seam existed.
 */
export function webWorkerScope(): WorkerScope | null {
  const globalScope = globalThis as unknown as { self?: WebWorkerGlobals } & WebWorkerGlobals;
  const scope = globalScope.self ?? globalScope;
  const post = scope.postMessage ?? globalScope.postMessage;
  if (typeof post !== 'function') return null;
  const handlers = new Set<(data: unknown) => void>();
  return {
    post: (value) => { post.call(scope, value); },
    onMessage: (handler) => {
      if (handlers.size === 0) {
        // No origin check, and none is possible: this is a dedicated worker's
        // `onmessage`, not `window.postMessage`.  The event carries no origin
        // and the port is private to the parent that spawned the thread, so
        // there is nothing to compare against; consumers discriminate on
        // `kind` instead.  CodeQL js/missing-origin-check — dismissed (#1593).
        scope.onmessage = (event) => { for (const h of [...handlers]) h(event?.data); };
      }
      handlers.add(handler);
    },
    offMessage: (handler) => {
      handlers.delete(handler);
      if (handlers.size === 0) scope.onmessage = null;
    },
  };
}

type ParentPort = {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  off(event: 'message', listener: (data: unknown) => void): unknown;
};

/**
 * Node's `parentPort`, or `null` outside a `worker_threads` worker — on the
 * main thread the import succeeds and the port is `null`, which is what tells
 * a caller it is not inside a worker at all.  Async because the module is
 * reached by a dynamic import, like every other Node-only seam here.
 */
export async function nodeWorkerScope(): Promise<WorkerScope | null> {
  let port: ParentPort | null;
  try {
    const moduleName = 'node:worker_threads';
    const workerThreads = (await import(moduleName)) as { parentPort?: ParentPort | null };
    port = workerThreads.parentPort ?? null;
  } catch {
    return null;
  }
  if (port === null) return null;
  const parentPort = port;
  return {
    post: (value) => { parentPort.postMessage(value); },
    onMessage: (handler) => { parentPort.on('message', handler); },
    offMessage: (handler) => { parentPort.off('message', handler); },
  };
}

/**
 * Whichever the runtime offers: the Web Worker globals first, `parentPort`
 * second.  Throws where neither exists, because that is not a worker.
 */
export async function getWorkerScope(): Promise<WorkerScope> {
  const web = webWorkerScope();
  if (web !== null) return web;
  const node = await nodeWorkerScope();
  if (node !== null) return node;
  throw new Error('not inside a Worker: neither the Web Worker globals nor a worker_threads parentPort is present');
}
