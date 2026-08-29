import { detectRuntime, type RuntimeKind } from '../Detect.js';
import type { WorkerBackend } from './WorkerBackend.js';

export type {
  WorkerBackend,
  WorkerLike,
  WorkerCloseEvent,
  WorkerErrorEvent,
  WorkerMessageEvent,
  WorkerSpawnOptions,
} from './WorkerBackend.js';
export { WebWorkerBackend } from './WebWorkerBackend.js';
export { NodeWorkerBackend } from './NodeWorkerBackend.js';

let cached: WorkerBackend | null = null;
let cachedFor: RuntimeKind | null = null;

/**
 * Get the appropriate `WorkerBackend` for the current runtime.  Cached
 * across calls so repeated spawns don't re-import.  On Node the
 * `worker_threads` module is lazily preloaded the first time this
 * function is awaited.
 */
export async function getWorkerBackend(): Promise<WorkerBackend> {
  const runtime = detectRuntime();
  if (cached && cachedFor === runtime) return cached;

  if (runtime === 'node') {
    const { NodeWorkerBackend } = await import('./NodeWorkerBackend.js');
    await NodeWorkerBackend.preload();
    cached = new NodeWorkerBackend();
  } else {
    // Bun / Deno — Web Worker API is already globally available.
    const { WebWorkerBackend } = await import('./WebWorkerBackend.js');
    cached = new WebWorkerBackend();
  }
  cachedFor = runtime;
  return cached;
}

/**
 * Drop the memoised backend so the next call re-detects.  Only useful
 * where the runtime answer can change mid-process — i.e. tests that move
 * `setRuntimeOverride` around.  To run against a fake backend, pass it as
 * the `backend` option instead; this function swaps nothing in.
 */
export function resetWorkerBackendCache(): void {
  cached = null;
  cachedFor = null;
}
