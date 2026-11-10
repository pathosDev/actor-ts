/**
 * Smoke case: `WorkerMesh` on this runtime's real worker threads (#1562).
 *
 * The unit and multi-node suites prove the protocol and prove it on Bun; this
 * is the only gate that runs the shipped `worker-mesh-bootstrap` as a worker
 * entry on **Node** (`worker_threads`, from `dist/`) and **Deno** (Web Worker,
 * from `dist/`) — three `Worker` implementations, three `import.meta.url`
 * resolutions of the bootstrap next to the package's own files, which is
 * exactly the runtime-sensitive surface this harness exists for.
 *
 * One mesh, two workers, one `ask` per worker; every handle released on every
 * path — the mesh's threads and the main system — so a Deno event loop with a
 * leftover worker does not hang the run after its last green line (#1196).
 */
export const name = 'worker mesh';
export const description = 'the main thread joins two real worker threads and asks an actor on each';

export async function run({ actorTs, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { WorkerMesh, WorkerMeshOptions } = await loadEntry('worker');

  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { cluster: { 'gossip-interval': '40ms' } } });
  const system = ActorSystem.create('smoke-mesh', systemOptions);
  const meshOptions = WorkerMeshOptions.create()
    .withModule(new URL('../fixtures/worker-mesh-actors.mjs', import.meta.url))
    .withWorkers(2)
    .withReadyTimeoutMs(20_000);

  let mesh = null;
  try {
    mesh = await WorkerMesh.start(system, meshOptions);
    if (mesh.size !== 2) throw new Error(`expected 2 workers, got ${mesh.size}`);
    if (mesh.cluster.upMembers().length !== 3) {
      throw new Error(`expected 3 up members, got ${mesh.cluster.upMembers().length}`);
    }
    for (const worker of mesh.workers) {
      if (!worker.actors.includes('Where')) {
        throw new Error(`${worker.address} reported actors ${JSON.stringify(worker.actors)}, no Where`);
      }
    }
    const answers = await Promise.all(
      mesh.addresses.map((address) => mesh.refFor(address, '/user/where').ask({ kind: 'where' }, 10_000)),
    );
    const expected = mesh.addresses.map((address) => address.toString()).sort();
    if (JSON.stringify([...answers].sort()) !== JSON.stringify(expected)) {
      throw new Error(`asks answered ${JSON.stringify(answers)}, expected ${JSON.stringify(expected)}`);
    }
  } finally {
    if (mesh !== null) await mesh.terminate();
    await system.terminate();
  }
}
