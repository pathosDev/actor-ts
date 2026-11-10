/**
 * The worker entry module `WorkerMesh` spawns every worker with (#1562).
 *
 * Deliberately five lines: `WorkerNode.join()` for the handshake, then
 * everything else in `runWorkerMeshNode`, which the in-process tests run
 * against a `MessageChannel` with no thread — so what a real worker executes
 * and what CI verifies are the same function.
 *
 * `main()` is a named async function and not a top-level `await` for the
 * reason `WorkerNode`'s JSDoc gives: under Bun a top-level await in a worker
 * suspends the module loader in a way that keeps the init frame from ever
 * dispatching, and the handshake hangs.
 *
 * Shipped in `dist/` and resolved by `WorkerMesh` with
 * `new URL('./worker-mesh-bootstrap.js', import.meta.url)`; a bundler that
 * inlines the package moves it, which is what `withBootstrap` is for.
 */
import { runWorkerMeshNode, type WorkerMeshInitData } from './WorkerMeshBootstrap.js';
import { WorkerNode } from './WorkerNode.js';

/**
 * The init frame this entry expects, re-exported so `WorkerMesh` can
 * type-import it from *here* — which is what keeps a module reached only
 * through a `Worker` URL visible to the dependency graph (`lint:knip` treats
 * an unreachable file as dead), and honest: the entry is the owner of that
 * contract.  Same shape as the testkit's bootstrap.
 */
export type { WorkerMeshInitData };

async function main(): Promise<void> {
  const context = await WorkerNode.join<WorkerMeshInitData>();
  await runWorkerMeshNode(context);
}

void main();
