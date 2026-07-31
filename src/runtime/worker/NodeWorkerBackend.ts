import { Lazy } from '../../util/Lazy.js';
import type {
  WorkerBackend,
  WorkerCloseEvent,
  WorkerEventMap,
  WorkerLike,
  WorkerMessageEvent,
  WorkerSpawnOptions,
} from './WorkerBackend.js';

/**
 * Node.js worker backend.  Node's `worker_threads.Worker` accepts a URL
 * since Node 12.17, but its event plumbing is EventEmitter-based (`.on` /
 * `.off`) with different event names (`exit` instead of `close`, carrying
 * the exit code as a number argument rather than a `CloseEvent`).  The
 * adapter here hides those differences so `WorkerCluster` always sees the
 * same `{ data }` / `{ code }` shape regardless of runtime.
 *
 * Dynamically imports `node:worker_threads` so the module can be loaded
 * under Bun and Deno too without blowing up at import time — only the
 * `spawn(...)` call does the import.
 */
export class NodeWorkerBackend implements WorkerBackend {
  spawn(bootstrap: URL, options: WorkerSpawnOptions = {}): WorkerLike {
    // Returning a thenable would break the WorkerBackend contract, which
    // is intentionally sync (mirrors the Web Worker constructor).  We
    // therefore require the caller to pre-load the module once via
    // `preload()` — in practice WorkerCluster calls that on first use.
    if (!ctorLazy.isEvaluated) {
      throw new Error(
        'NodeWorkerBackend: worker_threads is not loaded yet — call `await NodeWorkerBackend.preload()` before spawning.',
      );
    }
    const worker = new (ctorLazy.get())(bootstrap, { name: options.name });
    return new NodeWorkerAdapter(worker);
  }

  /** Load `node:worker_threads` once so subsequent `spawn()` calls are sync. */
  static async preload(): Promise<void> {
    if (ctorLazy.isEvaluated) return;
    const moduleName = 'node:worker_threads';
    const mod = (await import(moduleName)) as {
      Worker: WorkerThreadConstructor;
    };
    ctorLazy.setOverride(mod.Worker);
  }
}

/* ----------------------------- internals --------------------------------- */

interface NodeWorkerThread {
  postMessage(v: unknown, transfer?: unknown[]): void;
  on(event: 'message', listener: (data: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  off(event: 'message', listener: (data: unknown) => void): this;
  off(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

type WorkerThreadConstructor = new (url: URL | string, options?: { name?: string }) => NodeWorkerThread;

// Real ctor installed by `preload()`; the fallback thunk is only
// reached if a caller forgets to preload — the spawn() guard also
// catches that case with a clearer message.
const ctorLazy: Lazy<WorkerThreadConstructor> = Lazy.of<WorkerThreadConstructor>(() => {
  throw new Error(
    'NodeWorkerBackend: call `await NodeWorkerBackend.preload()` before spawning a worker.',
  );
});

class NodeWorkerAdapter implements WorkerLike {
  // Map user-supplied handler → the function actually subscribed on the
  // underlying EventEmitter, so `removeEventListener` finds the right one.
  private readonly listeners: Map<
    (ev: never) => void,
    { event: 'message' | 'exit'; fn: ((...args: unknown[]) => void) }
  > = new Map();

  constructor(private readonly native: NodeWorkerThread) {}

  postMessage(value: unknown, transfer?: unknown[]): void {
    this.native.postMessage(value, transfer);
  }

  addEventListener<K extends keyof WorkerEventMap>(
    event: K,
    handler: (ev: WorkerEventMap[K]) => void,
  ): void {
    if (event === 'close') {
      const fn = (code: number): void => {
        handler({ code } as WorkerCloseEvent as WorkerEventMap[K]);
      };
      this.listeners.set(handler as (ev: never) => void, { event: 'exit', fn: fn as (...a: unknown[]) => void });
      this.native.on('exit', fn);
      return;
    }
    // message
    const fn = (data: unknown): void => {
      handler({ data } as WorkerMessageEvent as WorkerEventMap[K]);
    };
    this.listeners.set(handler as (ev: never) => void, { event: 'message', fn: fn as (...a: unknown[]) => void });
    this.native.on('message', fn);
  }

  removeEventListener<K extends keyof WorkerEventMap>(
    _event: K,
    handler: (ev: WorkerEventMap[K]) => void,
  ): void {
    const entry = this.listeners.get(handler as (ev: never) => void);
    if (!entry) return;
    this.listeners.delete(handler as (ev: never) => void);
    if (entry.event === 'exit') {
      this.native.off('exit', entry.fn as (code: number) => void);
    } else {
      this.native.off('message', entry.fn as (data: unknown) => void);
    }
  }

  terminate(): Promise<number> {
    return this.native.terminate();
  }
}
