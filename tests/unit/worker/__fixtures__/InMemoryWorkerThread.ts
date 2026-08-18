/**
 * In-memory stand-ins for the runtime-level `WorkerLike` /
 * `WorkerBackend` surface plus a `PortLike` shim.  The real
 * implementations spin up actual OS threads (`worker_threads` on Node,
 * Web Worker API on Bun/Deno) — these fakes let us unit-test the
 * orchestration layer (WorkerBroker / WorkerCluster / WorkerNode)
 * without paying the spawn cost or relying on bootstrap module URLs.
 *
 * The wiring matches the real EventEmitter-style API: handlers
 * registered via `addEventListener('message', listener)` receive
 * `{ data }` objects, and `terminate()` synthesises a `close` event
 * the same way a real worker exit does.
 */
import type {
  WorkerBackend,
  WorkerCloseEvent,
  WorkerErrorEvent,
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
  /**
   * Pending error-listeners.  Before `WorkerEventMap` had an `error` member,
   * `addEventListener` here ended in an `else if` with no `else`, so an
   * `'error'` subscription was silently dropped and no test could have observed
   * one (#700).
   */
  private readonly errorListeners = new Set<(e: WorkerErrorEvent) => void>();
  /**
   * Whether the thread is actually gone — set when `terminate()`'s promise
   * resolves, not when it is called.
   *
   * That distinction is the point: a synchronous flag cannot tell an awaited
   * `terminate()` from a fire-and-forget one, which is exactly what #735 is
   * about.  A caller that drops the promise sees `false` here.
   */
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
    } else if (event === 'error') {
      this.errorListeners.add(handler as (e: WorkerErrorEvent) => void);
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
    } else if (event === 'error') {
      this.errorListeners.delete(handler as (e: WorkerErrorEvent) => void);
    }
  }

  /**
   * Resolve on a macrotask, and only then report the thread as gone — the real
   * adapters wait for a runtime signal (Node's `exit`, Bun's `close`) or a
   * bounded timeout, so a fake that settled synchronously would let a
   * fire-and-forget teardown pass.
   */
  terminate(): Promise<void> {
    // The macrotask hop IS the assertion this fixture exists to make: a caller
    // that drops the promise is observably distinguishable from one that awaits
    // it only if the flag is set across a turn boundary.  Zero delay, so it
    // costs a turn and not a wait.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        this.terminated = true;
        // Synthesise a clean exit so any handler attached via
        // WorkerCluster.attachFailureHandlers sees `code === 0`.
        for (const h of this.closeListeners) h({ code: 0 });
        resolve();
      }, 0);
    });
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

  /**
   * Simulate an uncaught throw inside the worker.  Fires only the `error`
   * listeners; {@link simulateUncaughtThrow} covers the runtimes that follow it
   * with a `close`.
   */
  simulateError(message = 'worker boom'): void {
    for (const h of this.errorListeners) h({ message, error: new Error(message) });
  }

  /**
   * The full Node/Bun sequence for one uncaught throw: `error` and *then* an
   * abnormal `close`.  Exactly one respawn must come out of it.
   */
  simulateUncaughtThrow(message = 'worker boom', code = 1): void {
    this.simulateError(message);
    this.simulateCrash(code);
  }

  /** Drain `posted` and return it. */
  drainPosted(): unknown[] {
    const out = [...this.posted];
    this.posted.length = 0;
    return out;
  }
}

/* ----------------------------- FakeBackend ----------------------------- */

export type FakeBackendHooks = {
  /** Optional: called when a worker is spawned, before the handshake. */
  onSpawn?: (worker: FakeWorker, url: URL, options: WorkerSpawnOptions | undefined) => void;
};

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
    const kind = (v as { kind?: string } | null)?.kind;
    if (kind === 'worker-init') {
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
