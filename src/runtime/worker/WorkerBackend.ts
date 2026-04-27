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

export interface WorkerMessageEvent {
  readonly data?: unknown;
}

export interface WorkerCloseEvent {
  /** Exit code — 0 for clean exit, non-zero for crash / abnormal termination. */
  readonly code?: number;
}

export type WorkerEventMap = {
  message: WorkerMessageEvent;
  close: WorkerCloseEvent;
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
  terminate(): void | Promise<number>;
}

export interface WorkerSpawnOptions {
  readonly name?: string;
}

export interface WorkerBackend {
  /**
   * Spawn a worker from a module URL.  Must use module semantics (ES
   * modules with imports) — the equivalent of `{ type: 'module' }` in the
   * Web Worker spec.
   */
  spawn(bootstrap: URL, options?: WorkerSpawnOptions): WorkerLike;
}
