/**
 * In-memory stand-ins for the runtime-level `WorkerLike` /
 * `WorkerBackend` surface plus a `PortLike` shim.  The real
 * implementations spin up actual OS threads (`worker_threads` on Node,
 * Web Worker API on Bun/Deno) — these fakes let us unit-test the
 * orchestration layer (WorkerBroker / WorkerCluster / WorkerNode)
 * without paying the spawn cost or relying on bootstrap module URLs.
 *
 * The wiring matches the real EventEmitter-style API: handlers
 * registered via `addEventListener('message', fn)` receive
 * `{ data }` objects, and `terminate()` synthesises a `close` event
 * the same way a real worker exit does.
 */
import type {
  WorkerBackend,
  WorkerCloseEvent,
  WorkerEventMap,
  WorkerLike,
  WorkerMessageEvent,
  WorkerSpawnOptions,
} from '../../../../src/runtime/worker/WorkerBackend.js';
import type { PortLike } from '../../../../src/cluster/transports/MessageChannelTransport.js';

/* ------------------------------- FakeWorker ----------------------------- */

export class FakeWorker implements WorkerLike {
  /** Messages this worker posted via `postMessage()`, in order. */
  readonly posted: unknown[] = [];
  /** Pending message-listeners (registered via addEventListener). */
  private readonly messageListeners = new Set<(e: WorkerMessageEvent) => void>();
  /** Pending close-listeners. */
  private readonly closeListeners = new Set<(e: WorkerCloseEvent) => void>();
  /** Whether `terminate()` has been called. */
  terminated = false;
  /** Label for diagnostics. */
  readonly name: string;

  constructor(name: string) { this.name = name; }

  postMessage(value: unknown): void { this.posted.push(value); }

  addEventListener<K extends keyof WorkerEventMap>(
    event: K,
    handler: (ev: WorkerEventMap[K]) => void,
  ): void {
    if (event === 'message') {
      this.messageListeners.add(handler as (e: WorkerMessageEvent) => void);
    } else if (event === 'close') {
      this.closeListeners.add(handler as (e: WorkerCloseEvent) => void);
    }
  }

  removeEventListener<K extends keyof WorkerEventMap>(
    event: K,
    handler: (ev: WorkerEventMap[K]) => void,
  ): void {
    if (event === 'message') {
      this.messageListeners.delete(handler as (e: WorkerMessageEvent) => void);
    } else if (event === 'close') {
      this.closeListeners.delete(handler as (e: WorkerCloseEvent) => void);
    }
  }

  terminate(): void {
    this.terminated = true;
    // Synthesise a clean exit so any restartHandler attached via
    // WorkerCluster.attachRestartHandler sees `code === 0`.
    for (const h of this.closeListeners) h({ code: 0 });
  }

  /* -------------------- Test helpers (not on WorkerLike) -------------- */

  /** Simulate a message arriving at this worker from the broker side. */
  deliverMessage(data: unknown): void {
    for (const h of this.messageListeners) h({ data });
  }

  /** Simulate an abnormal exit — like a crash with non-zero code. */
  simulateCrash(code = 1): void {
    for (const h of this.closeListeners) h({ code });
  }

  /** Drain `posted` and return it. */
  drainPosted(): unknown[] {
    const out = [...this.posted];
    this.posted.length = 0;
    return out;
  }
}

/* ----------------------------- FakeBackend ----------------------------- */

export interface FakeBackendHooks {
  /** Optional: called when a worker is spawned, before the handshake. */
  onSpawn?: (worker: FakeWorker, url: URL, opts: WorkerSpawnOptions | undefined) => void;
}

export class FakeWorkerBackend implements WorkerBackend {
  readonly spawned: FakeWorker[] = [];

  constructor(private readonly hooks: FakeBackendHooks = {}) {}

  spawn(url: URL, options?: WorkerSpawnOptions): WorkerLike {
    const worker = new FakeWorker(options?.name ?? `fake-${this.spawned.length}`);
    this.spawned.push(worker);
    this.hooks.onSpawn?.(worker, url, options);
    return worker;
  }

  /** The MOST RECENTLY spawned worker, for tests that only want the latest. */
  latest(): FakeWorker {
    if (this.spawned.length === 0) throw new Error('FakeWorkerBackend: no workers spawned yet');
    return this.spawned[this.spawned.length - 1]!;
  }
}

/* ------------------------- Auto-handshake helper ------------------------ */

/**
 * Wire a FakeWorker so it automatically completes the WorkerCluster
 * handshake protocol.  The protocol is:
 *
 *   1. parent installs a `'message'` listener on the worker
 *   2. worker posts `worker-hello`
 *   3. parent receives hello → posts `worker-init`
 *   4. worker receives init → posts `worker-ready`
 *   5. parent receives ready → resolves the handshake
 *
 * We patch the FakeWorker so that (a) when the parent installs its
 * message listener, we synchronously deliver a `worker-hello`, and
 * (b) when the parent posts a `worker-init`, we deliver a
 * `worker-ready` back.  This lets tests `await
 * WorkerCluster.spawn(...)` without driving the handshake by hand.
 *
 * Returns a teardown function that restores the originals.
 */
export function autoHandshake(worker: FakeWorker): () => void {
  const origPost = worker.postMessage.bind(worker);
  const origAdd = worker.addEventListener.bind(worker);

  // Patch postMessage — when the PARENT posts worker-init, reply
  // with worker-ready (which the parent's listener awaits).
  worker.postMessage = (v: unknown): void => {
    origPost(v);
    const k = (v as { kind?: string } | null)?.kind;
    if (k === 'worker-init') {
      const init = v as { self: unknown };
      worker.deliverMessage({ kind: 'worker-ready', self: init.self });
    }
  };

  // Patch addEventListener — when the parent attaches its 'message'
  // listener (the one driving the handshake), deliver worker-hello
  // to it.  Then it posts worker-init, our patched postMessage
  // catches it, and the cycle completes.
  let helloFired = false;
  worker.addEventListener = (event, handler): void => {
    origAdd(event, handler);
    if (event === 'message' && !helloFired) {
      helloFired = true;
      // Defer one microtask so the caller has finished registering
      // before we deliver — mirrors real async event-loop ordering.
      queueMicrotask(() => worker.deliverMessage({ kind: 'worker-hello' }));
    }
  };

  return () => {
    worker.postMessage = origPost;
    worker.addEventListener = origAdd;
  };
}

/* ------------------------------- FakePort ------------------------------ */

/**
 * `PortLike` shim — useful for testing WorkerBroker without going
 * through the WorkerCluster facade.  Tracks postMessage calls and
 * exposes an `inject()` that fires the registered `onmessage` handler.
 */
export class FakePort implements PortLike {
  readonly posted: unknown[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  started = false;

  postMessage(value: unknown): void {
    if (this.closed) return;
    this.posted.push(value);
  }

  close(): void { this.closed = true; this.onmessage = null; }
  start(): void { this.started = true; }

  inject(data: unknown): void { this.onmessage?.({ data }); }
}
