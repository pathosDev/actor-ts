import { describe, expect, test } from 'bun:test';
import { getWorkerScope, nodeWorkerScope, webWorkerScope } from '../../../src/runtime/worker/WorkerScope.js';

/**
 * The worker-side runtime seam (#1569).  The Web Worker shape is driven with
 * a stand-in `self`; the `parentPort` shape can only be entered from inside a
 * real `worker_threads` worker, which is what the mesh smoke case does on
 * Node — here the main thread proves the negative: no port, no scope.
 */

type FakeSelf = {
  posted: unknown[];
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(value: unknown): void;
};

function withFakeSelf(): { self: FakeSelf; restore: () => void } {
  const self: FakeSelf = {
    posted: [],
    onmessage: null,
    postMessage(value) { this.posted.push(value); },
  };
  const globalScope = globalThis as { self?: unknown };
  const previous = globalScope.self;
  globalScope.self = self;
  return {
    self,
    restore: () => {
      if (previous === undefined) delete globalScope.self;
      else globalScope.self = previous;
    },
  };
}

describe('webWorkerScope', () => {
  test('posts through self.postMessage and fans one onmessage out to every handler', () => {
    const { self, restore } = withFakeSelf();
    try {
      const scope = webWorkerScope();
      expect(scope).not.toBeNull();
      scope!.post({ kind: 'hello' });
      expect(self.posted).toEqual([{ kind: 'hello' }]);

      const seen: unknown[][] = [[], []];
      const first = (data: unknown): void => { seen[0]!.push(data); };
      const second = (data: unknown): void => { seen[1]!.push(data); };
      scope!.onMessage(first);
      scope!.onMessage(second);
      self.onmessage!({ data: 'a' });
      expect(seen).toEqual([['a'], ['a']]);

      // Removing one keeps the dispatcher; removing the last clears it, so a
      // scope with nobody listening leaves no handler behind on the global.
      scope!.offMessage(first);
      self.onmessage!({ data: 'b' });
      expect(seen).toEqual([['a'], ['a', 'b']]);
      scope!.offMessage(second);
      expect(self.onmessage).toBeNull();
    } finally {
      restore();
    }
  });

  test('is null where the globals are absent', () => {
    const globalScope = globalThis as { self?: unknown; postMessage?: unknown };
    const previousSelf = globalScope.self;
    const previousPost = globalScope.postMessage;
    delete globalScope.self;
    delete globalScope.postMessage;
    try {
      expect(webWorkerScope()).toBeNull();
    } finally {
      if (previousSelf !== undefined) globalScope.self = previousSelf;
      if (previousPost !== undefined) globalScope.postMessage = previousPost;
    }
  });
});

describe('nodeWorkerScope / getWorkerScope on the main thread', () => {
  test('parentPort is null outside a worker, so the node scope is null', async () => {
    expect(await nodeWorkerScope()).toBeNull();
  });

  test('getWorkerScope refuses the main thread and names both shapes it looked for', async () => {
    const globalScope = globalThis as { self?: unknown; postMessage?: unknown };
    const previousSelf = globalScope.self;
    const previousPost = globalScope.postMessage;
    delete globalScope.self;
    delete globalScope.postMessage;
    try {
      await expect(getWorkerScope()).rejects.toThrow(/not inside a Worker.*parentPort/);
    } finally {
      if (previousSelf !== undefined) globalScope.self = previousSelf;
      if (previousPost !== undefined) globalScope.postMessage = previousPost;
    }
  });

  test('getWorkerScope prefers the Web Worker globals when they exist', async () => {
    const { restore } = withFakeSelf();
    try {
      const scope = await getWorkerScope();
      expect(typeof scope.post).toBe('function');
    } finally {
      restore();
    }
  });
});
