/**
 * Runtime-neutral Worker abstraction used by `WorkerCluster`.
 *
 * The two surfaces to reconcile:
 *   - **Bun & Deno** expose the Web Worker API — `new Worker(url, { type:
 *     'module' })` with `addEventListener` / `removeEventListener` and a
 *     `close` event.
 *   - **Node.js** exposes `worker_threads.Worker` — accepts a URL since
 *     Node 12.17, but events use EventEmitter (`.on` / `.off`), and the
 *     "exited" event is `exit` with a numeric code (not `close`).
 *
 * `WorkerLike` describes the subset of the Web Worker shape that
 * `WorkerCluster` actually uses.  The Node backend wraps `worker_threads`
 * in a thin adapter that implements the same surface, so the cluster
 * code never branches on runtime once it has a `WorkerLike` in hand.
 */

export type WorkerMessageEvent = {
  readonly data?: unknown;
};

export type WorkerCloseEvent = {
  /** Exit code — 0 for clean exit, non-zero for crash / abnormal termination. */
  readonly code?: number;
};

/**
 * An uncaught throw, an unhandled rejection, or a bootstrap that fails to
 * load, inside the worker.
 *
 * It is a member of {@link WorkerEventMap} rather than an out-of-band concern
 * because leaving it out is what made the documented containment guarantee
 * false: with no name to subscribe, Node re-raises the worker's error on the
 * host via `process.nextTick` and Deno rejects an internal promise — both exit
 * 1, and Node's `exit` event never fires, so the restart path is never even
 * reached (#700).  Only Bun contains the throw on its own.
 *
 * Deliberately not an `Error`: Node hands over a real `Error`, the Web Worker
 * API hands over an `ErrorEvent` whose `error` may be anything or nothing, so
 * the only field a caller can rely on is a (possibly absent) message.
 */
export type WorkerErrorEvent = {
  /** The failure's message, when the runtime supplies one. */
  readonly message?: string;
  /** The thrown value itself, where the runtime hands one over. */
  readonly error?: unknown;
};

export type WorkerEventMap = {
  message: WorkerMessageEvent;
  close: WorkerCloseEvent;
  error: WorkerErrorEvent;
};

export interface WorkerLike {
  postMessage(value: unknown, transfer?: unknown[]): void;
  addEventListener<K extends keyof WorkerEventMap>(
    event: K,
    handler: (ev: WorkerEventMap[K]) => void,
  ): void;
  removeEventListener<K extends keyof WorkerEventMap>(
    event: K,
    handler: (ev: WorkerEventMap[K]) => void,
  ): void;
  /**
   * Kill the thread and resolve once it is actually gone — **best effort, and
   * bounded**.
   *
   * The runtimes do not agree on how they say so, which is why the wait lives
   * behind this method instead of at the call site: Node's `terminate()`
   * resolves after `exit`, Bun's returns `undefined` but does emit `close`
   * within a couple of milliseconds, and Deno's returns `undefined` *and*
   * emits nothing at all afterwards.  So each backend supplies its own
   * completion signal and caps the wait; awaiting the native return value is
   * only a real wait on one of the three (#735).
   */
  terminate(): Promise<void>;
}

export type WorkerSpawnOptions = {
  readonly name?: string;
};

export interface WorkerBackend {
  /**
   * Spawn a worker from a module URL.  Must use module semantics (ES
   * modules with imports) — the equivalent of `{ type: 'module' }` in the
   * Web Worker spec.
   */
  spawn(bootstrap: URL, options?: WorkerSpawnOptions): WorkerLike;
}
