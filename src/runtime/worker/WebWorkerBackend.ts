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
 * Bun / Deno / browser worker backend.  All three expose the standard Web
 * Worker API verbatim — spawn with `new Worker(url, { type: 'module' })`
 * and dispatch events via `addEventListener` / `removeEventListener`.
 * This backend is a thin identity wrapper that keeps the event shape
 * (`{ data }` / `{ code }`) consistent with the Node adapter.
 */
export class WebWorkerBackend implements WorkerBackend {
  spawn(bootstrap: URL, options: WorkerSpawnOptions = {}): WorkerLike {
    const Constructor = (globalThis as { Worker?: typeof Worker }).Worker;
    if (!Constructor) {
      throw new Error('WebWorkerBackend requires a `Worker` global (Bun / Deno / browser).');
    }
    const worker = new Constructor(bootstrap, { type: 'module', name: options.name });
    return new WebWorkerAdapter(worker);
  }
}

/* ----------------------------- internals --------------------------------- */

/**
 * How long `terminate()` waits for the runtime to confirm the thread is gone.
 *
 * Deliberately short, because one of the two runtimes behind this backend
 * never confirms: Deno emits no `close`, `error`, `messageerror` or `exit`
 * after `terminate()` (measured over a 4 s window), so this bound is reached
 * on *every* Deno shutdown.  The testkit's own 3 s bound would therefore turn
 * an eight-worker Deno teardown into three flat seconds of waiting for an
 * event that is never coming.  Bun answers in ~2 ms, and Node does not use
 * this backend at all.
 */
const TERMINATE_CONFIRM_TIMEOUT_MS = 250;

/**
 * The union of native event shapes this adapter forwards: `message` carries
 * `data`, `close` carries `code`, and an `ErrorEvent` carries `message` /
 * `error` plus the `preventDefault` the Deno path depends on.
 */
type NativeWorkerEvent = {
  data?: unknown;
  code?: number;
  message?: string;
  error?: unknown;
  preventDefault?: () => void;
};

/**
 * Intentionally an intersection rather than `interface … extends Worker`:
 * these listener signatures are deliberately narrower than the DOM ones, and
 * an intersection adds them as overloads where `extends` would reject them as
 * incompatible (TS2430).
 */
type NativeWorker = Worker & {
  addEventListener(type: string, listener: (e: NativeWorkerEvent) => void): void;
  removeEventListener(type: string, listener: (e: NativeWorkerEvent) => void): void;
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
    (e: NativeWorkerEvent) => void
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
    const forwarder = (e: NativeWorkerEvent): void => {
      if (event === 'error') {
        // Mandatory, not defensive: on Deno a bare `error` listener does not
        // stop the host dying — the runtime re-raises the worker's error as an
        // unhandled rejection unless the handler cancels the event, and the
        // process still exits 1.  Cancelling is a no-op on Bun, where the
        // throw was already contained (#700).
        e.preventDefault?.();
        handler({ message: e.message, error: e.error } as WorkerErrorEvent as WorkerEventMap[K]);
        return;
      }
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

  /**
   * The native `terminate()` here is `void` on both Bun and Deno, so the
   * completion signal has to come from the `close` event instead — registered
   * **before** the call, because Bun can dispatch it in the same turn and a
   * listener attached afterwards would miss it and sit out the whole bound.
   * Deno never dispatches it, hence the cap.
   */
  async terminate(): Promise<void> {
    const confirmed = new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.removeEventListener('close', finish);
        resolve();
      };
      this.addEventListener('close', finish);
      timer = setTimeout(finish, TERMINATE_CONFIRM_TIMEOUT_MS);
    });
    // The thread is going away regardless of what the call reports.
    try { this.native.terminate(); } catch { /* ignore */ }
    await confirmed;
  }
}
