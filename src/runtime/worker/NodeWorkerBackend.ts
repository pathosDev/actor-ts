import { Lazy } from '../../util/Lazy.js';
import type {
  WorkerBackend,
  WorkerCloseEvent,
  WorkerErrorEvent,
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

/** The `worker_threads.Worker` surface the adapter uses — exported alongside {@link NodeWorkerAdapter} so a test can stand one in. */
export interface NodeWorkerThread {
  postMessage(v: unknown, transfer?: unknown[]): void;
  on(event: 'message', listener: (data: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: 'message', listener: (data: unknown) => void): this;
  off(event: 'exit', listener: (code: number) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  terminate(): Promise<number>;
}

/** The three native event names this adapter subscribes, per `WorkerEventMap` key. */
type NativeEventName = 'message' | 'exit' | 'error';

type WorkerThreadConstructor = new (url: URL | string, options?: { name?: string }) => NodeWorkerThread;

// Real ctor installed by `preload()`; the fallback thunk is only
// reached if a caller forgets to preload — the spawn() guard also
// catches that case with a clearer message.
const ctorLazy: Lazy<WorkerThreadConstructor> = Lazy.of<WorkerThreadConstructor>(() => {
  throw new Error(
    'NodeWorkerBackend: call `await NodeWorkerBackend.preload()` before spawning a worker.',
  );
});

/**
 * Exported for the adapter-level test only — `src/runtime/` is not a package
 * export path, so this widens nothing a consumer can see.  It is the one piece
 * of the Node path a unit test can reach: `spawn()` needs a preloaded real
 * `worker_threads.Worker`, and driving it would mean an actual OS thread, which
 * no un-quarantined test does yet (#1186).  Handing the adapter a fake
 * {@link NodeWorkerThread} instead binds the event mapping without one.
 */
export class NodeWorkerAdapter implements WorkerLike {
  // Map user-supplied handler → the function actually subscribed on the
  // underlying EventEmitter, so `removeEventListener` finds the right one.
  private readonly listeners: Map<
    (ev: never) => void,
    { event: NativeEventName; listener: ((...args: unknown[]) => void) }
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
      const listener = (code: number): void => {
        handler({ code } as WorkerCloseEvent as WorkerEventMap[K]);
      };
      this.subscribe('exit', handler, listener as (...a: unknown[]) => void);
      this.native.on('exit', listener);
      return;
    }
    if (event === 'error') {
      const listener = (error: Error): void => {
        handler({ message: error?.message, error } as WorkerErrorEvent as WorkerEventMap[K]);
      };
      this.subscribe('error', handler, listener as (...a: unknown[]) => void);
      this.native.on('error', listener);
      return;
    }
    // Deliberately a throw and not a fall-through to `message`: this branch
    // used to be the unguarded `else`, so `addEventListener('eror', h)` — or
    // any name added to `WorkerEventMap` without a branch here — silently
    // became a `message` subscription that fired on every frame and never on
    // the event asked for (#700).
    if (event !== 'message') {
      throw new Error(
        `NodeWorkerAdapter: unsupported worker event '${String(event)}' — expected 'message', 'close' or 'error'.`,
      );
    }
    const listener = (data: unknown): void => {
      handler({ data } as WorkerMessageEvent as WorkerEventMap[K]);
    };
    this.subscribe('message', handler, listener as (...a: unknown[]) => void);
    this.native.on('message', listener);
  }

  removeEventListener<K extends keyof WorkerEventMap>(
    _event: K,
    handler: (ev: WorkerEventMap[K]) => void,
  ): void {
    const entry = this.listeners.get(handler as (ev: never) => void);
    if (!entry) return;
    this.listeners.delete(handler as (ev: never) => void);
    if (entry.event === 'exit') {
      this.native.off('exit', entry.listener as (code: number) => void);
    } else if (entry.event === 'error') {
      this.native.off('error', entry.listener as (error: Error) => void);
    } else {
      this.native.off('message', entry.listener as (data: unknown) => void);
    }
  }

  /**
   * `terminate()` on `worker_threads` already resolves after the thread's
   * `exit`, so the contract's completion wait costs nothing extra here — the
   * exit code it resolves with is dropped, because a caller who wants it
   * subscribes `close`.
   */
  async terminate(): Promise<void> {
    await this.native.terminate();
  }

  private subscribe<K extends keyof WorkerEventMap>(
    event: NativeEventName,
    handler: (ev: WorkerEventMap[K]) => void,
    listener: (...args: unknown[]) => void,
  ): void {
    this.listeners.set(handler as (ev: never) => void, { event, listener });
  }
}
