import type { WorkerMeshSetupContext } from '../../../../src/worker/WorkerMeshBootstrap.js';

export { Where } from './actors.js';

/**
 * A worker that never answers a spawn: the `setup` re-registers the
 * `parallelism-spawn` wire kind with a handler that drops the frame, which
 * replaces the bootstrap's.  Exists so the spawn deadline can be exercised
 * without a worker that is genuinely hung.
 */
export function setup(context: WorkerMeshSetupContext): void {
  context.cluster._onWire('parallelism-spawn', () => { /* swallowed */ });
}
