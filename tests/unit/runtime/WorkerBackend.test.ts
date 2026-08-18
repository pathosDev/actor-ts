import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  getWorkerBackend,
  resetWorkerBackendCache,
  WebWorkerBackend,
  NodeWorkerBackend,
} from '../../../src/runtime/worker/index.js';
import {
  NodeWorkerAdapter,
  type NodeWorkerThread,
} from '../../../src/runtime/worker/NodeWorkerBackend.js';
import type {
  WorkerCloseEvent,
  WorkerErrorEvent,
  WorkerLike,
  WorkerMessageEvent,
} from '../../../src/runtime/worker/WorkerBackend.js';
import { setRuntimeOverride } from '../../../src/runtime/Detect.js';

beforeEach(() => resetWorkerBackendCache());
afterEach(() => {
  resetWorkerBackendCache();
  setRuntimeOverride(null);
});

describe('runtime/worker/getWorkerBackend', () => {
  test('returns a WebWorkerBackend under Bun', async () => {
    // Detection is real here — bun:test runs on Bun.
    const backend = await getWorkerBackend();
    expect(backend).toBeInstanceOf(WebWorkerBackend);
  });

  test('returns a WebWorkerBackend under Deno', async () => {
    setRuntimeOverride('deno');
    // Spawning requires a real `globalThis.Worker`; here we only construct
    // the backend — no spawn yet — which is safe under Bun.
    const backend = await getWorkerBackend();
    expect(backend).toBeInstanceOf(WebWorkerBackend);
  });

  test('returns a NodeWorkerBackend under Node (and preloads worker_threads)', async () => {
    setRuntimeOverride('node');
    const backend = await getWorkerBackend();
    // Under Bun the `node:worker_threads` import succeeds because Bun
    // ships a Node-compat polyfill — we can assert the class shape
    // without actually spawning a worker.
    expect(backend).toBeInstanceOf(NodeWorkerBackend);
  });

  test('caches the backend across calls in the same runtime', async () => {
    const first = await getWorkerBackend();
    const second = await getWorkerBackend();
    expect(first).toBe(second);
  });

  test('switching the runtime override invalidates the cache', async () => {
    const webBackend = await getWorkerBackend();
    setRuntimeOverride('node');
    resetWorkerBackendCache();
    const nodeBackend = await getWorkerBackend();
    expect(nodeBackend).not.toBe(webBackend);
  });
});

/* ------------------------------------------------------------------------ */
/* The event mapping each adapter performs (#700) and its termination        */
/* contract (#735).  Both are driven against a stand-in for the native       */
/* worker, so no OS thread is spawned — that gap is #1186.                   */
/* ------------------------------------------------------------------------ */

/** A `worker_threads.Worker` stand-in that records what was subscribed. */
class StubNodeWorkerThread implements NodeWorkerThread {
  readonly subscribed: string[] = [];
  readonly unsubscribed: string[] = [];
  terminateCalls = 0;
  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();

  postMessage(): void { /* not exercised here */ }

  on(event: 'message' | 'exit' | 'error', listener: (...args: never[]) => void): this {
    this.subscribed.push(event);
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: 'message' | 'exit' | 'error', listener: (...args: never[]) => void): this {
    this.unsubscribed.push(event);
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    return 0;
  }

  /** Fire one native event, as the EventEmitter would. */
  emit(event: 'message' | 'exit' | 'error', argument: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (value: unknown) => void)(argument);
    }
  }
}

describe('runtime/worker/NodeWorkerAdapter event mapping', () => {
  test("subscribing 'error' reaches the native 'error' event, not 'message'", () => {
    const native = new StubNodeWorkerThread();
    const adapter: WorkerLike = new NodeWorkerAdapter(native as unknown as NodeWorkerThread);

    const seen: WorkerErrorEvent[] = [];
    adapter.addEventListener('error', (e) => { seen.push(e); });
    // The whole defect: this branch used to fall through to `native.on('message')`.
    expect(native.subscribed).toEqual(['error']);

    native.emit('error', new Error('worker boom'));
    expect(seen.length).toBe(1);
    expect(seen[0]!.message).toBe('worker boom');
    expect(seen[0]!.error).toBeInstanceOf(Error);
  });

  test("'close' still maps onto the native 'exit' and 'message' onto 'message'", () => {
    const native = new StubNodeWorkerThread();
    const adapter: WorkerLike = new NodeWorkerAdapter(native as unknown as NodeWorkerThread);

    const closes: WorkerCloseEvent[] = [];
    const messages: WorkerMessageEvent[] = [];
    adapter.addEventListener('close', (e) => { closes.push(e); });
    adapter.addEventListener('message', (e) => { messages.push(e); });
    expect(native.subscribed).toEqual(['exit', 'message']);

    native.emit('exit', 3);
    native.emit('message', { kind: 'ping' });
    expect(closes).toEqual([{ code: 3 }]);
    expect(messages).toEqual([{ data: { kind: 'ping' } }]);
  });

  test('an unsupported event name throws instead of aliasing to message', () => {
    const native = new StubNodeWorkerThread();
    const adapter = new NodeWorkerAdapter(native as unknown as NodeWorkerThread);

    // Only reachable from JS or through a cast — which is exactly how a new
    // `WorkerEventMap` member would arrive without a branch here.
    expect(() => (adapter as unknown as {
      addEventListener(event: string, handler: () => void): void;
    }).addEventListener('messageerror', () => {})).toThrow(/unsupported worker event/);
    expect(native.subscribed).toEqual([]);
  });

  test('removeEventListener unsubscribes the native event the handler was mapped to', () => {
    const native = new StubNodeWorkerThread();
    const adapter: WorkerLike = new NodeWorkerAdapter(native as unknown as NodeWorkerThread);

    const seen: WorkerErrorEvent[] = [];
    const handler = (e: WorkerErrorEvent): void => { seen.push(e); };
    adapter.addEventListener('error', handler);
    adapter.removeEventListener('error', handler);
    expect(native.unsubscribed).toEqual(['error']);

    native.emit('error', new Error('after removal'));
    expect(seen).toEqual([]);
  });

  test('terminate() resolves through the native promise', async () => {
    const native = new StubNodeWorkerThread();
    const adapter: WorkerLike = new NodeWorkerAdapter(native as unknown as NodeWorkerThread);
    await adapter.terminate();
    expect(native.terminateCalls).toBe(1);
  });
});

/** A Web `Worker` stand-in installed as `globalThis.Worker` for the duration of a test. */
class StubNativeWorker {
  static latest: StubNativeWorker | undefined;
  readonly subscribed: string[] = [];
  terminateCalls = 0;
  private readonly listeners = new Map<string, Set<(e: unknown) => void>>();

  constructor(readonly url: URL | string, readonly options?: unknown) {
    StubNativeWorker.latest = this;
  }

  addEventListener(event: string, listener: (e: unknown) => void): void {
    this.subscribed.push(event);
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }

  removeEventListener(event: string, listener: (e: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  postMessage(): void { /* not exercised here */ }
  terminate(): void { this.terminateCalls += 1; }

  dispatch(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

/** Run `body` with `globalThis.Worker` replaced by the stub, then restore it. */
async function withStubWorker(body: (native: StubNativeWorker, worker: WorkerLike) => Promise<void>): Promise<void> {
  const holder = globalThis as { Worker?: unknown };
  const real = holder.Worker;
  holder.Worker = StubNativeWorker;
  try {
    const worker = new WebWorkerBackend().spawn(new URL('file:///stub-bootstrap.js'), { name: 'stub' });
    await body(StubNativeWorker.latest!, worker);
  } finally {
    holder.Worker = real;
  }
}

describe('runtime/worker/WebWorkerAdapter event mapping', () => {
  test('an error event is forwarded AND cancelled — Deno kills the host otherwise', async () => {
    await withStubWorker(async (native, worker) => {
      const seen: WorkerErrorEvent[] = [];
      worker.addEventListener('error', (e) => { seen.push(e); });
      expect(native.subscribed).toContain('error');

      let preventDefaultCalls = 0;
      native.dispatch('error', {
        message: 'worker boom',
        error: new Error('worker boom'),
        preventDefault: () => { preventDefaultCalls += 1; },
      });

      // A bare listener is not enough on Deno: without the cancel the runtime
      // still re-raises and the process exits 1.
      expect(preventDefaultCalls).toBe(1);
      expect(seen.length).toBe(1);
      expect(seen[0]!.message).toBe('worker boom');
    });
  });

  test('close and message keep their existing shapes', async () => {
    await withStubWorker(async (native, worker) => {
      const closes: WorkerCloseEvent[] = [];
      const messages: WorkerMessageEvent[] = [];
      worker.addEventListener('close', (e) => { closes.push(e); });
      worker.addEventListener('message', (e) => { messages.push(e); });

      native.dispatch('close', { code: 7 });
      native.dispatch('message', { data: { kind: 'ping' } });
      expect(closes).toEqual([{ code: 7 }]);
      expect(messages).toEqual([{ data: { kind: 'ping' } }]);
    });
  });

  test('terminate() resolves on the close event, whose listener is in place first', async () => {
    await withStubWorker(async (native, worker) => {
      // Registering after the native call would miss a close dispatched in the
      // same turn, which is what Bun does — and the wait would then sit out its
      // whole bound.
      const originalTerminate = native.terminate.bind(native);
      native.terminate = (): void => {
        originalTerminate();
        native.dispatch('close', { code: 0 });
      };

      const startedAt = performance.now();
      await worker.terminate();
      expect(native.terminateCalls).toBe(1);
      // Nowhere near the 250ms bound — the event answered.
      expect(performance.now() - startedAt).toBeLessThan(150);
      // And the wait cleaned up after itself.
      expect(native.listenerCount).toBe(0);
    });
  });

  test('terminate() still resolves when the runtime never confirms — the Deno path', async () => {
    await withStubWorker(async (native, worker) => {
      const startedAt = performance.now();
      // Deno emits no close, error, messageerror or exit after terminate().
      await worker.terminate();
      const elapsed = performance.now() - startedAt;
      expect(native.terminateCalls).toBe(1);
      // The elapsed time IS the assertion: it resolves via the bound, and the
      // bound is short enough that an eight-worker teardown is not seconds long.
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(1_500);
    });
  });
});
