import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  getWorkerBackend,
  resetWorkerBackendCache,
  resolveWorkerBackend,
  WebWorkerBackend,
  NodeWorkerBackend,
} from '../../../src/runtime/worker/index.js';
import {
  NodeWorkerAdapter,
  type NodeWorkerThread,
} from '../../../src/runtime/worker/NodeWorkerBackend.js';
import type {
  WorkerBackend,
  WorkerCloseEvent,
  WorkerErrorEvent,
  WorkerLike,
  WorkerMessageEvent,
  WorkerSpawnOptions,
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
/* The containment declaration (#1288): what the shipped backends say, what  */
/* the compiler demands of a custom one, and what the resolver does with a   */
/* `false`.                                                                  */
/* ------------------------------------------------------------------------ */

/** A `WorkerLike` that does nothing — the resolver never spawns, so none of it is reached. */
const inertWorker: WorkerLike = {
  postMessage(): void {},
  addEventListener(): void {},
  removeEventListener(): void {},
  terminate: () => Promise.resolve(),
};

/** A custom backend under a class name the diagnostic can quote. */
class UncontainedBackend implements WorkerBackend {
  readonly containsWorkerErrors = false;
  spawn(_bootstrap: URL, _options?: WorkerSpawnOptions): WorkerLike { return inertWorker; }
}

class ContainedBackend implements WorkerBackend {
  readonly containsWorkerErrors = true;
  spawn(_bootstrap: URL, _options?: WorkerSpawnOptions): WorkerLike { return inertWorker; }
}

describe('runtime/worker — the containment declaration (#1288)', () => {
  test('both shipped backends declare that their error subscription contains the throw', () => {
    // Pins the declarations to the adapters that earn them: Node forwards to
    // `on('error')`, the Web adapter cancels the event for Deno — both tested
    // above.  A backend whose adapter lost that wiring and kept `true` is what
    // the smoke case exists for; this only keeps the two from drifting apart.
    expect(new WebWorkerBackend().containsWorkerErrors).toBe(true);
    expect(new NodeWorkerBackend().containsWorkerErrors).toBe(true);
  });

  test('a backend without the declaration is not a WorkerBackend — a compile-time fact', () => {
    // The directive below is the assertion, and `bun test` cannot see it: bun
    // transpiles without type-checking, so this file passes here whether or
    // not the member is required.  Only `bun run typecheck:dev`, which
    // compiles `tests/`, turns a removed member into TS2578 ("unused
    // '@ts-expect-error' directive") — run it after touching the interface.
    // @ts-expect-error a backend without containsWorkerErrors is not a WorkerBackend
    const undeclared: WorkerBackend = { spawn: (): WorkerLike => inertWorker };
    // Still a real object at runtime — and one the resolver reports as
    // declaring nothing about containment (below), because the compiler gates
    // only the TypeScript caller.
    expect(typeof undeclared.spawn).toBe('function');
  });

  test('resolveWorkerBackend returns the explicit backend and says nothing about a true', async () => {
    const reports: string[] = [];
    const backend = new ContainedBackend();
    expect(await resolveWorkerBackend(backend, (m) => { reports.push(m); })).toBe(backend);
    expect(reports).toEqual([]);
  });

  test('resolveWorkerBackend falls back to the detected backend when none is given', async () => {
    const reports: string[] = [];
    const resolved = await resolveWorkerBackend(undefined, (m) => { reports.push(m); });
    expect(resolved).toBe(await getWorkerBackend());
    expect(reports).toEqual([]);
  });

  test('a false is reported once per backend instance, before anything is spawned, naming the backend', async () => {
    const reports: string[] = [];
    const backend = new UncontainedBackend();
    const report = (m: string): void => { reports.push(m); };

    expect(await resolveWorkerBackend(backend, report)).toBe(backend);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toStartWith('worker backend UncontainedBackend declares containsWorkerErrors=false');
    expect(reports[0]).toContain('will terminate this process');
    expect(reports[0]).toContain('Failure containment');

    // The latch: a second resolution through the same instance — a respawn,
    // a second pool sharing the backend — adds no line.
    expect(await resolveWorkerBackend(backend, report)).toBe(backend);
    expect(reports).toHaveLength(1);

    // Per instance, not per class: another instance of the same backend is a
    // different declaration and gets its own line.
    await resolveWorkerBackend(new UncontainedBackend(), report);
    expect(reports).toHaveLength(2);
  });

  test('an anonymous backend is named as such rather than as Object', async () => {
    const reports: string[] = [];
    const literal: WorkerBackend = { containsWorkerErrors: false, spawn: (): WorkerLike => inertWorker };
    await resolveWorkerBackend(literal, (m) => { reports.push(m); });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toStartWith('an anonymous worker backend declares containsWorkerErrors=false');
    expect(reports[0]).not.toContain('Object');
  });

  // The compiler is the gate for a TypeScript caller, and only for one: the
  // package runs on Node as plain ESM, a cast gets a stub past the check, a
  // shape copied from an older version predates the member.  At runtime each
  // of those is a backend that declares *nothing*, and the verification of
  // #1288 measured that an `=== false` check let every one of them spawn in
  // silence — the exact silence the issue is titled after, for that class of
  // consumer.  So anything that is not `true` is reported, with a wording
  // that says what was found.
  const undeclaredShapes: ReadonlyArray<[string, () => WorkerBackend]> = [
    ['no member at all (a plain-JavaScript backend, or a cast)',
      () => ({ spawn: (): WorkerLike => inertWorker }) as unknown as WorkerBackend],
    ['containsWorkerErrors: undefined',
      () => ({ containsWorkerErrors: undefined, spawn: (): WorkerLike => inertWorker }) as unknown as WorkerBackend],
    ["the string 'false' — an environment variable that never became a boolean",
      () => ({ containsWorkerErrors: 'false', spawn: (): WorkerLike => inertWorker }) as unknown as WorkerBackend],
  ];
  for (const [shape, make] of undeclaredShapes) {
    test(`a backend with ${shape} is reported once as declaring nothing about containment`, async () => {
      const reports: string[] = [];
      const backend = make();
      const report = (m: string): void => { reports.push(m); };
      expect(await resolveWorkerBackend(backend, report)).toBe(backend);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toStartWith('an anonymous worker backend declares nothing about containment');
      expect(reports[0]).toContain('containsWorkerErrors');
      expect(reports[0]).toContain('will terminate this process');
      // Same latch as a `false`: the second resolution through the instance is silent.
      await resolveWorkerBackend(backend, report);
      expect(reports).toHaveLength(1);
    });
  }

  test('a class that forgot the member is named, and the wording is not the false one', async () => {
    class ForgetfulBackend { spawn(): WorkerLike { return inertWorker; } }
    const reports: string[] = [];
    await resolveWorkerBackend(new ForgetfulBackend() as unknown as WorkerBackend, (m) => { reports.push(m); });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toStartWith('worker backend ForgetfulBackend declares nothing about containment');
    expect(reports[0]).not.toContain('containsWorkerErrors=false');
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
      // Lower bound only, and it is the assertion: `terminate()` resolved via
      // its own fallback bound rather than via a confirmation the runtime never
      // sent, and nothing but elapsed time can show that.  The upper bound that
      // used to follow was a different claim — that an eight-worker teardown is
      // not seconds long — and it measured the machine rather than the fallback.
      // That belongs in a benchmark; here it only made the test load-sensitive.
      expect(elapsed).toBeGreaterThanOrEqual(200);
    });
  });
});
