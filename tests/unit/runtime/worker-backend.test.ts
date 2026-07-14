import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  getWorkerBackend,
  resetWorkerBackendCache,
  WebWorkerBackend,
  NodeWorkerBackend,
} from '../../../src/runtime/worker/index.js';
import { setRuntimeOverride } from '../../../src/runtime/detect.js';

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
