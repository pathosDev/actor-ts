/**
 * The worker entry module `OffloadPool` spawns every worker with (#1558).
 *
 * Deliberately three lines: find the parent link through the runtime seam —
 * the Web Worker globals on Bun and Deno, `parentPort` on Node (#1569) — and
 * hand it to `serveOffload`, which the in-process tests run against a fake
 * worker with no thread, so what a real worker executes and what CI verifies
 * are the same function.
 *
 * Shipped in `dist/` and resolved by `OffloadPool` with
 * `new URL('./offload-worker.js', import.meta.url)`; a bundler that inlines
 * the package moves it, which is what `withBootstrap` is for.
 */
import { getWorkerScope } from '../runtime/worker/WorkerScope.js';
import { serveOffload } from './OffloadWorkerBootstrap.js';
import type { OffloadReadyMessage } from './OffloadTask.js';

/**
 * The ready frame this entry sends, re-exported so `OffloadPool` can
 * type-import it from *here* — which keeps a module reached only through a
 * `Worker` URL visible to the dependency graph (`lint:knip` treats an
 * unreachable file as dead), the same anchor the mesh bootstrap uses.
 */
export type { OffloadReadyMessage };

async function main(): Promise<void> {
  serveOffload(await getWorkerScope());
}

void main();
