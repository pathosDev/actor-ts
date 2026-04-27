import { detectRuntime, type RuntimeKind } from '../detect.js';
import type { WorkerBackend } from './WorkerBackend.js';

export type { WorkerBackend, WorkerLike, WorkerCloseEvent, WorkerMessageEvent, WorkerSpawnOptions } from './WorkerBackend.js';
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

/** Test hook: reset the cached backend so tests can swap in a fake. */
export function resetWorkerBackendCache(): void {
  cached = null;
  cachedFor = null;
}
