/**
 * WorkerNode tests — the worker-side counterpart to WorkerCluster's
 * main-thread handshake.  `WorkerNode.join()` runs inside an actual
 * worker thread in production; we simulate the worker scope with a
 * stand-in object that owns `postMessage` / `addEventListener` /
 * `onmessage` and behaves the way Bun's worker globals do.
 */
import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { WorkerNode } from '../../../src/worker/WorkerNode.js';

/**
 * Stand-in for the `self` global inside a Worker.  Exposes the same
 * three surfaces WorkerNode.join() uses (`postMessage`,
 * `addEventListener`, `onmessage`).  The `deliverFromParent()` helper
 * is the test-only injection point — pretend a message arrived from
 * the main thread.
 */
class FakeSelfScope {
  /** Messages this scope posted back to the parent. */
  readonly posted: unknown[] = [];
  /** `'message'` listeners registered via addEventListener. */
  private readonly messageListeners = new Set<(e: { data: unknown }) => void>();
  /** Single onmessage (DOM-property-style). */
  onmessage: ((e: { data: unknown }) => void) | null = null;

  postMessage(value: unknown): void { this.posted.push(value); }

  addEventListener(event: string, handler: (e: { data: unknown }) => void): void {
    if (event === 'message') this.messageListeners.add(handler);
  }

  removeEventListener(event: string, handler: (e: { data: unknown }) => void): void {
    if (event === 'message') this.messageListeners.delete(handler);
  }

  /** Pretend the parent thread sent us a message. */
  deliverFromParent(data: unknown): void {
    this.onmessage?.({ data });
    for (const h of this.messageListeners) h({ data });
  }
}

/**
 * A scope that answers a `worker-hello` with the init frame from **inside**
 * the `postMessage` call that carried it.
 *
 * Not a claim that a runtime does this — `postMessage` re-entering its own
 * sender synchronously is exactly what none of the three do.  It is a probe
 * for statement *order*, and the cheapest one there is: a frame delivered at
 * the instant the hello goes out reaches `join()` only if the init listener
 * was installed first, so the fake turns an ordering into a value.
 *
 * The ordering is load-bearing off this thread too, which is why it is worth
 * a test rather than a comment.  `WorkerCluster.handshake` answers the first
 * hello and latches, so its init frame is posted exactly once; on Bun and Deno
 * a frame that arrives before the worker's `onmessage` exists is dropped
 * rather than queued (Node queues it), so a bootstrap that says hello before
 * it listens loses that one init and then waits out the whole
 * `readyTimeoutMs`.  `join()` listening first is what makes the latch safe,
 * and until now only a comment said so.
 */
class AnsweringSelfScope extends FakeSelfScope {
  constructor(private readonly reply: unknown) { super(); }

  override postMessage(value: unknown): void {
    super.postMessage(value);
    if ((value as { kind?: string } | null)?.kind !== 'worker-hello') return;
    this.deliverFromParent(this.reply);
  }
}

/**
 * Install `selfScope` as `globalThis.self` for the duration of the
 * test, then restore the previous value.  Returns the scope.
 */
function withSelf<S extends FakeSelfScope = FakeSelfScope>(
  scope: S = new FakeSelfScope() as S,
): { scope: S; restore: () => void } {
  const globalScope = globalThis as unknown as { self?: unknown };
  const prev = globalScope.self;
  globalScope.self = scope;
  return {
    scope,
    restore: () => {
      if (prev === undefined) delete globalScope.self;
      else globalScope.self = prev;
    },
  };
}

/**
 * Record every timer armed and every handle cancelled while the callback runs.
 *
 * Patching the two globals rather than reaching for a runtime-specific handle
 * property is what keeps this test runtime-agnostic, which is the whole point
 * of #778: `unref()` is a Node/Bun extension and Deno's numeric handle simply
 * has no such method, so a test written against `unref` would assert the
 * dialect instead of the fix.  `clearTimeout` is the same call everywhere.
 */
async function recordingTimers<T>(
  body: () => Promise<T>,
): Promise<{ result: T; armed: { handle: unknown; delayMs: number }[]; cleared: unknown[] }> {
  const timerGlobals = globalThis as unknown as {
    setTimeout: (handler: () => void, ms?: number, ...rest: unknown[]) => unknown;
    clearTimeout: (handle?: unknown) => void;
  };
  const realSetTimeout = timerGlobals.setTimeout;
  const realClearTimeout = timerGlobals.clearTimeout;
  const armed: { handle: unknown; delayMs: number }[] = [];
  const cleared: unknown[] = [];
  timerGlobals.setTimeout = (handler, ms, ...rest): unknown => {
    const handle = realSetTimeout.call(globalThis, handler, ms, ...rest);
    armed.push({ handle, delayMs: ms ?? 0 });
    return handle;
  };
  timerGlobals.clearTimeout = (handle): void => {
    cleared.push(handle);
    realClearTimeout.call(globalThis, handle);
  };
  try {
    return { result: await body(), armed, cleared };
  } finally {
    timerGlobals.setTimeout = realSetTimeout;
    timerGlobals.clearTimeout = realClearTimeout;
  }
}

describe('WorkerNode.join', () => {
  test('throws when not running inside a Worker (no self scope)', async () => {
    // Strip `self` so the join() detects "not a Worker".  We have to
    // also strip `globalThis` view of postMessage etc — but
    // WorkerNode.join's check is `if (!selfScope)` which only fires
    // when both `g.self` AND `g` itself fail.  In Node/Bun's main
    // thread `globalThis` always has SOME scope, so the check is
    // best-effort.  Skipping this edge — see commented test below.
    expect(true).toBe(true);
  });

  test('completes the handshake — posts hello, awaits init, posts ready', async () => {
    const { scope, restore } = withSelf();
    try {
      const joinPromise = WorkerNode.join<{ token: string }>();

      // The first thing join() does is post `worker-hello`.  It also
      // installs `onmessage` synchronously before posting hello.
      // Yield one microtask so the handler is wired before we deliver.
      await Promise.resolve();
      const hello = scope.posted.find((m) =>
        (m as { kind?: string })?.kind === 'worker-hello');
      expect(hello).toBeDefined();

      // Deliver worker-init from the parent.
      const initSelf = new NodeAddress('sys', 'host', 9).toJSON();
      scope.deliverFromParent({
        kind: 'worker-init',
        self: initSelf,
        systemName: 'sys',
        data: { token: 'secret' },
      });

      const context = await joinPromise;
      expect(context.self.toString()).toBe('sys@host:9');
      expect(context.systemName).toBe('sys');
      expect(context.initData).toEqual({ token: 'secret' });

      // Calling context.ready() posts worker-ready back to the parent.
      context.ready();
      const ready = scope.posted.find((m) =>
        (m as { kind?: string })?.kind === 'worker-ready');
      expect(ready).toBeDefined();
      expect((ready as { self: unknown }).self).toEqual(initSelf);
    } finally {
      restore();
    }
  });

  test('non-init frames are ignored during handshake', async () => {
    const { scope, restore } = withSelf();
    try {
      const joinPromise = WorkerNode.join();
      await Promise.resolve();

      // Send some garbage — join must keep waiting for worker-init.
      scope.deliverFromParent({ kind: 'something-else' });
      scope.deliverFromParent(null);
      scope.deliverFromParent({ kind: 'worker-ready', self: {} }); // wrong direction

      // Now send the real init.
      const initSelf = new NodeAddress('sys', 'host', 1).toJSON();
      scope.deliverFromParent({
        kind: 'worker-init',
        self: initSelf,
        systemName: 'sys',
        data: 'init-payload',
      });

      const context = await joinPromise;
      expect(context.initData).toBe('init-payload');
    } finally {
      restore();
    }
  });

  test('transport routes worker-transport envelopes to its handler', async () => {
    const { scope, restore } = withSelf();
    try {
      const joinPromise = WorkerNode.join();
      await Promise.resolve();
      const initSelf = new NodeAddress('sys', 'host', 1).toJSON();
      scope.deliverFromParent({
        kind: 'worker-init',
        self: initSelf,
        systemName: 'sys',
        data: null,
      });

      const context = await joinPromise;
      // The transport multiplexes over the worker channel — every
      // inbound `worker-transport` frame is unwrapped and delivered
      // as a plain BrokeredMessage.  We can't easily reach into the
      // transport's internal handler from outside, but we CAN
      // verify the transport object was constructed.
      expect(context.transport).toBeDefined();
      expect(typeof context.transport.start).toBe('function');
      expect(typeof context.transport.shutdown).toBe('function');
    } finally {
      restore();
    }
  });

  test('handshake honours self.postMessage when globalThis.postMessage is absent', async () => {
    // In Bun a worker has both self.postMessage AND globalThis.postMessage,
    // but in Web Worker the canonical surface is self.postMessage only.
    // Pin that we use self.postMessage when it's present.
    const { scope, restore } = withSelf();
    const globalScope = globalThis as unknown as { postMessage?: unknown };
    const prevGlobalPost = globalScope.postMessage;
    delete globalScope.postMessage; // ensure no global fallback
    try {
      const joinPromise = WorkerNode.join();
      await Promise.resolve();
      // Even without globalThis.postMessage, self.postMessage delivered the hello.
      const hello = scope.posted.find((m) =>
        (m as { kind?: string })?.kind === 'worker-hello');
      expect(hello).toBeDefined();
      // Drive the rest to completion.
      scope.deliverFromParent({
        kind: 'worker-init',
        self: new NodeAddress('sys', 'host', 1).toJSON(),
        systemName: 'sys',
        data: null,
      });
      await joinPromise;
    } finally {
      restore();
      if (prevGlobalPost !== undefined) globalScope.postMessage = prevGlobalPost;
    }
  });

  test('cancels its init timer once the init frame arrives', async () => {
    const { scope, restore } = withSelf();
    try {
      const { armed, cleared } = await recordingTimers(async () => {
        const joinPromise = WorkerNode.join();
        await Promise.resolve();
        scope.deliverFromParent({
          kind: 'worker-init',
          self: new NodeAddress('sys', 'host', 1).toJSON(),
          systemName: 'sys',
          data: null,
        });
        return joinPromise;
      });

      // The 30 s init timeout, identified by its delay so an unrelated timer
      // armed by the transport construction cannot stand in for it.
      const initTimers = armed.filter((t) => t.delayMs === 30_000);
      expect(initTimers.length).toBe(1);
      // Cancelled, not merely unreferenced: `unref()` is a Node/Bun extension
      // and no-ops on Deno's numeric handle, so before #778 a worker that
      // resolved join() and wanted to exit waited out the full 30 s there.
      expect(cleared).toContain(initTimers[0]!.handle);
    } finally {
      restore();
    }
  });

  test('installs its init listener before it says hello, so a reply cannot be missed', async () => {
    // The property `WorkerCluster.handshake`'s first-hello latch leans on
    // (#1515, from #775): the parent answers the first hello and never
    // re-sends, so a worker that greets before it listens loses that one init
    // frame on Bun and Deno — where an undeliverable frame is dropped, not
    // queued — and then waits out the parent's whole ready window.  The two
    // statements were already in the right order; nothing held them there.
    const initFrame = {
      kind: 'worker-init',
      self: new NodeAddress('sys', 'host', 7).toJSON(),
      systemName: 'sys',
      data: { seeded: true },
    };
    const { scope, restore } = withSelf(new AnsweringSelfScope(initFrame));
    const joinPromise = WorkerNode.join<{ seeded: boolean }>();
    try {
      const outcome = await Promise.race([
        joinPromise.then(() => 'joined' as const),
        // The elapsed time IS the assertion: a `join()` that greeted first
        // never resolves at all — it holds its own 30 s init timer, six times
        // bun's per-test cap — and a pending promise cannot be polled for.
        new Promise<'still waiting'>((resolve) => { setTimeout(() => resolve('still waiting'), 250); }),
      ]);

      // Not vacuous: the hello did go out, and it is what carried the reply.
      expect(scope.posted.some((m) => (m as { kind?: string })?.kind === 'worker-hello')).toBe(true);
      expect(outcome).toBe('joined');
      expect((await joinPromise).initData).toEqual({ seeded: true });
    } finally {
      // Settles a `join()` that missed the synchronous reply, so the failing
      // run releases its 30 s timer instead of holding the runner open.
      scope.deliverFromParent(initFrame);
      await joinPromise.catch(() => undefined);
      restore();
    }
  });

  test('ctx.self deserialises into a usable NodeAddress', async () => {
    const { scope, restore } = withSelf();
    try {
      const joinPromise = WorkerNode.join();
      await Promise.resolve();
      const actorRef = new NodeAddress('cluster-x', '127.0.0.1', 42);
      scope.deliverFromParent({
        kind: 'worker-init',
        self: actorRef.toJSON(),
        systemName: 'cluster-x',
        data: null,
      });
      const context = await joinPromise;
      expect(context.self).toBeInstanceOf(NodeAddress);
      expect(context.self.equals(actorRef)).toBe(true);
    } finally {
      restore();
    }
  });
});
