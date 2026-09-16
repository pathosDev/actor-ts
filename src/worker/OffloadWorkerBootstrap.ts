import type { WorkerScope } from '../runtime/worker/WorkerScope.js';
import type {
  OffloadErrorMessage,
  OffloadReadyMessage,
  OffloadResultMessage,
  OffloadRunMessage,
} from './OffloadTask.js';

/** How the worker loads a task's module — replaceable so a test can hand it modules without a file. */
export type OffloadModuleImporter = (href: string) => Promise<Record<string, unknown>>;

const defaultImporter: OffloadModuleImporter = (href) => import(href) as Promise<Record<string, unknown>>;

/**
 * Everything an offload worker does, kept apart from the entry file so the
 * in-process tests can run the identical code against a fake worker with no
 * thread underneath (#1558).
 *
 * One frame in, one frame out.  A run names a module and an export; the
 * module is imported once per worker and kept, the export is called with
 * the cloned arguments, a returned promise is awaited, and the value — or
 * the error, flattened to its name, message and stack, since an `Error`
 * does not cross a port as itself — goes back under the run's id.  The
 * worker is deliberately synchronous CPU work by design: that is what it is
 * *for*, and why it is not an actor.
 *
 * Returns the unsubscribe, so an in-process host can take the worker down.
 */
export function serveOffload(scope: WorkerScope, importModule: OffloadModuleImporter = defaultImporter): () => void {
  const modules = new Map<string, Promise<Record<string, unknown>>>();

  const load = (href: string): Promise<Record<string, unknown>> => {
    let loading = modules.get(href);
    if (loading === undefined) {
      loading = importModule(href);
      modules.set(href, loading);
      // A module that fails to import is not cached as failed: the next run
      // tries again, which is what a transient failure wants and what a
      // permanent one can afford — it fails the same way each time.
      loading.catch(() => { modules.delete(href); });
    }
    return loading;
  };

  const onMessage = (data: unknown): void => {
    const frame = data as Partial<OffloadRunMessage> | null;
    if (frame === null || typeof frame !== 'object' || frame.kind !== 'offload-run') return;
    if (typeof frame.id !== 'number' || typeof frame.module !== 'string' || typeof frame.exportName !== 'string') return;
    void run(frame as OffloadRunMessage);
  };

  const run = async (frame: OffloadRunMessage): Promise<void> => {
    try {
      const exports = await load(frame.module);
      const task = exports[frame.exportName];
      if (typeof task !== 'function') {
        throw new TypeError(`${frame.module} has no function export named '${frame.exportName}'`);
      }
      const result: unknown = await (task as (...args: unknown[]) => unknown)(...frame.args);
      const reply: OffloadResultMessage = { kind: 'offload-result', id: frame.id, result };
      scope.post(reply);
    } catch (error) {
      const reply: OffloadErrorMessage = error instanceof Error
        ? { kind: 'offload-error', id: frame.id, name: error.name, message: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) }
        : { kind: 'offload-error', id: frame.id, name: 'Error', message: String(error) };
      scope.post(reply);
    }
  };

  scope.onMessage(onMessage);
  const ready: OffloadReadyMessage = { kind: 'offload-ready' };
  scope.post(ready);
  return () => { scope.offMessage(onMessage); };
}
