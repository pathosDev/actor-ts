import type {
  WorkerBackend,
  WorkerCloseEvent,
  WorkerEventMap,
  WorkerLike,
  WorkerMessageEvent,
  WorkerSpawnOptions,
} from './WorkerBackend.js';

/**
 * Bun / Deno / browser worker backend.  All three expose the standard Web
 * Worker API verbatim — spawn with `new Worker(url, { type: 'module' })`
 * and dispatch events via `addEventListener` / `removeEventListener`.
 * This backend is a thin identity wrapper that keeps the event shape
 * (`{ data }` / `{ code }`) consistent with the Node adapter.
 */
export class WebWorkerBackend implements WorkerBackend {
  spawn(bootstrap: URL, options: WorkerSpawnOptions = {}): WorkerLike {
    const Ctor = (globalThis as { Worker?: typeof Worker }).Worker;
    if (!Ctor) {
      throw new Error('WebWorkerBackend requires a `Worker` global (Bun / Deno / browser).');
    }
    const worker = new Ctor(bootstrap, { type: 'module', name: options.name });
    return new WebWorkerAdapter(worker);
  }
}

/* ----------------------------- internals --------------------------------- */

type NativeWorker = Worker & {
  addEventListener(type: string, listener: (e: { data?: unknown; code?: number }) => void): void;
  removeEventListener(type: string, listener: (e: { data?: unknown; code?: number }) => void): void;
  terminate(): void;
};

/**
 * We wrap the native Worker behind a tiny adapter that funnels every
 * `addEventListener`/`removeEventListener` pair through a mapping table.
 * The wrapping lets us *also* implement `NodeWorkerBackend` with the
 * identical outward shape without the calling code knowing which runtime
 * it's on.
 */
class WebWorkerAdapter implements WorkerLike {
  private readonly listeners: Map<
    (ev: never) => void,
    (e: { data?: unknown; code?: number }) => void
  > = new Map();

  constructor(private readonly native: NativeWorker) {}

  postMessage(value: unknown, transfer?: unknown[]): void {
    const anyWorker = this.native as unknown as {
      postMessage(v: unknown, t?: unknown[]): void;
    };
    anyWorker.postMessage(value, transfer);
  }

  addEventListener<K extends keyof WorkerEventMap>(
    event: K,
    handler: (ev: WorkerEventMap[K]) => void,
  ): void {
    const forwarder = (e: { data?: unknown; code?: number }): void => {
      handler(
        event === 'close'
          ? ({ code: e.code } as WorkerCloseEvent as WorkerEventMap[K])
          : ({ data: e.data } as WorkerMessageEvent as WorkerEventMap[K]),
      );
    };
    this.listeners.set(handler as (ev: never) => void, forwarder);
    this.native.addEventListener(event, forwarder);
  }

  removeEventListener<K extends keyof WorkerEventMap>(
    event: K,
    handler: (ev: WorkerEventMap[K]) => void,
  ): void {
    const forwarder = this.listeners.get(handler as (ev: never) => void);
    if (!forwarder) return;
    this.listeners.delete(handler as (ev: never) => void);
    this.native.removeEventListener(event, forwarder);
  }

  terminate(): void | Promise<number> {
    return this.native.terminate();
  }
}
