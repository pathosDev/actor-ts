import { detectRuntime, type RuntimeKind } from '../Detect.js';
import type { WorkerBackend } from './WorkerBackend.js';

export type {
  WorkerBackend,
  WorkerLike,
  WorkerCloseEvent,
  WorkerErrorEvent,
  WorkerEventMap,
  WorkerMessageEvent,
  WorkerSpawnOptions,
} from './WorkerBackend.js';
export { WebWorkerBackend } from './WebWorkerBackend.js';
export { NodeWorkerBackend } from './NodeWorkerBackend.js';
export { getWorkerScope, nodeWorkerScope, webWorkerScope } from './WorkerScope.js';
export type { WorkerScope } from './WorkerScope.js';

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

/**
 * Backend instances whose `containsWorkerErrors: false` has been reported.
 *
 * Per *instance*, not per class or per consumer: the declaration is a fact
 * about the object that spawns, a pool that respawns through the same one
 * for the process lifetime has nothing new to say on the second spawn, and
 * two consumers sharing one backend still learn about it once each — the
 * report goes through the consumer's own sink, so the first of them to
 * resolve is the one that carries it.  Weak, so a test's throwaway fake
 * needs no reset here.
 */
const reportedUncontained = new WeakSet<WorkerBackend>();

/**
 * The one place a consumer turns its `backend` option into the backend it
 * spawns through — `WorkerCluster`, `OffloadPool` and `ParallelMultiNodeSpec`
 * all resolve here, so the containment diagnostic exists once and not three
 * times.
 *
 * Returns `explicit` when given, the detected backend otherwise.  When the
 * result declares `containsWorkerErrors: false` the consumer's `report` is
 * called once per backend instance, **before** the first spawn, and the
 * spawn proceeds: the framework will still subscribe `error`, and the
 * declaration says that on this backend the subscription is not a
 * containment — so the one thing left to do is to say so where the pool's
 * other reports go, so a host that later dies of a worker's throw has a line
 * in its log naming why (#1288).  Refusing instead would make `false` a
 * declaration that can never run and would take the diagnostic away from
 * the test that wants to observe it.
 *
 * The check is deliberately not inside {@link getWorkerBackend}: a custom
 * backend never passes through it.  And `report` is a callback rather than
 * a `Logger`, because nothing under `src/runtime/` imports `../Logger.js`
 * and that stays — the runtime layer sits below the actor layer.
 */
export async function resolveWorkerBackend(
  explicit: WorkerBackend | undefined,
  report: (message: string) => void,
): Promise<WorkerBackend> {
  const backend = explicit ?? await getWorkerBackend();
  if (backend.containsWorkerErrors === false && !reportedUncontained.has(backend)) {
    reportedUncontained.add(backend);
    report(describeUncontainedBackend(backend));
  }
  return backend;
}

/**
 * The consequence and the fix, in one line, naming the backend by its class.
 * "The framework's error handler" rather than any one consumer's reaction —
 * a restart policy, a budgeted replacement, a console line — because the
 * message is the same for all three and the consumer's prefix says which.
 */
function describeUncontainedBackend(backend: WorkerBackend): string {
  const name = backend.constructor?.name;
  // An object literal's constructor is `Object`, which names nothing.
  const subject = typeof name === 'string' && name !== '' && name !== 'Object'
    ? `worker backend ${name}`
    : 'an anonymous worker backend';
  return `${subject} declares containsWorkerErrors=false — an uncaught throw inside a worker `
    + "will terminate this process instead of reaching the framework's error handler; wire error containment "
    + 'into its WorkerLike adapter (see cluster/worker-mesh, Failure containment)';
}
