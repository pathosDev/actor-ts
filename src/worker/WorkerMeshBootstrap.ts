import { ActorSystem } from '../ActorSystem.js';
import { ActorSystemOptions } from '../ActorSystemOptions.js';
import { Cluster } from '../cluster/Cluster.js';
import { ClusterOptions } from '../cluster/ClusterOptions.js';
import type { NodeAddress } from '../cluster/NodeAddress.js';
import type { ConfigObject } from '../config/HoconParser.js';
import { collectActorExports, isActorClass, type WorkerActorClass } from '../parallelism/ActorModuleRegistry.js';
import { ParallelismOptions } from '../parallelism/ParallelismOptions.js';
import { serveParallelism } from '../parallelism/SpawnProtocol.js';
import type { WorkerNodeContext } from './WorkerNode.js';

export { isActorClass };
export type { WorkerActorClass };

/**
 * What the main thread hands every mesh worker in its init frame (#1562).
 *
 * `config` is the main system's **effective** configuration, `system.config`
 * as a plain document — not the file it came from.  Builder-set values on the
 * main thread never reach a file, so a worker that re-read `application.conf`
 * would run with different cluster timings than the node that spawned it, and
 * the configuration-compatibility check (#844) would either flag the mesh
 * against itself or, worse, not be configured to.
 */
export type WorkerMeshInitData = {
  readonly kind: 'worker-mesh-init';
  readonly config: ConfigObject;
  /** The main thread's address — the one seed every worker dials. */
  readonly seeds: ReadonlyArray<string>;
  readonly roles: ReadonlyArray<string>;
  /** `href`s of the actor modules to import, in order. */
  readonly modules: ReadonlyArray<string>;
};

/** What a mesh worker reports on `ready()`: the actor classes it can spawn, by export name. */
export type WorkerMeshReadyData = {
  readonly kind: 'worker-mesh-ready';
  readonly actors: ReadonlyArray<string>;
};

/**
 * What an actor module's optional `setup` receives, once the worker's node is
 * up.  Spawn here whatever the worker should host from the start; `actors` is
 * the registry the bootstrap built from every module's exports.
 */
export type WorkerMeshSetupContext = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly selfAddress: NodeAddress;
  readonly actors: ReadonlyMap<string, WorkerActorClass>;
};

/**
 * The shape an actor module may have beyond its class exports: a `setup` the
 * bootstrap awaits before it reports ready.  A module with no `setup` is
 * fine — the classes alone are the point for a mesh whose placement is driven
 * from the main thread.
 */
export interface WorkerMeshSetupModule {
  setup?(context: WorkerMeshSetupContext): void | Promise<void>;
}

/** How the bootstrap loads a module — replaceable so a test can hand it modules without a file. */
export type ModuleImporter = (href: string) => Promise<Record<string, unknown>>;

const defaultImporter: ModuleImporter = (href) => import(href) as Promise<Record<string, unknown>>;

/**
 * Everything a mesh worker does after `WorkerNode.join()` — kept apart from
 * the entry file so the in-process tests can run the identical code against a
 * `MessageChannel` with no thread underneath (#1562).
 *
 * Order matters: the system is built from the effective config first, the
 * cluster joins the main thread second, the modules load third — so a module's
 * `setup` sees a live cluster — and only then is `ready()` sent, carrying the
 * registry.  A throw anywhere here propagates out of the bootstrap, which the
 * runtime reports as a worker `error` and `WorkerCluster` turns into a
 * rejected `spawn()` naming the worker (#700).
 */
export async function runWorkerMeshNode(
  context: WorkerNodeContext<WorkerMeshInitData>,
  importModule: ModuleImporter = defaultImporter,
): Promise<{ readonly system: ActorSystem; readonly cluster: Cluster }> {
  const init = context.initData;
  if (init?.kind !== 'worker-mesh-init') {
    throw new Error('worker-mesh bootstrap: the init frame is not a worker-mesh init — was this worker spawned by WorkerMesh?');
  }
  // The effective config carries the main thread's `actor-ts.parallelism.*`
  // — including a `workers` above zero when the mesh was configured from
  // HOCON — and a worker that honoured it would start a mesh of its own
  // inside a mesh, fail for want of a module, and never finish its
  // handshake.  A worker is a leaf: the explicit option outranks the file.
  const systemOptions = ActorSystemOptions.create()
    .withConfig(init.config)
    .withParallelism(ParallelismOptions.create().withWorkers(0));
  const system = ActorSystem.create(context.systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(context.self.host)
    .withPort(context.self.port)
    .withSeeds([...init.seeds])
    .withRoles([...init.roles])
    .withTransport(context.transport);
  const cluster = await Cluster.join(system, clusterOptions);

  const actors = new Map<string, WorkerActorClass>();
  const origins = new Map<string, string>();
  const modules: Array<{ readonly href: string; readonly exports: Record<string, unknown> }> = [];
  for (const href of init.modules) {
    const exports = await importModule(href);
    modules.push({ href, exports });
    try {
      collectActorExports(href, exports, actors, origins);
    } catch (error) {
      throw new Error(`worker-mesh bootstrap: ${(error as Error).message}`, { cause: error });
    }
  }
  // Before any `setup` runs, so a spawn frame that arrives while a slow setup
  // is still awaiting is answered rather than dropped as an unclaimed kind.
  // Only the seed — the main thread — may ask this worker to spawn.
  serveParallelism({ system, cluster, actors, trustedPeers: init.seeds });

  const setupContext: WorkerMeshSetupContext = { system, cluster, selfAddress: context.self, actors };
  for (const module of modules) {
    const setup = (module.exports as WorkerMeshSetupModule).setup;
    if (typeof setup === 'function') await setup.call(module.exports, setupContext);
  }

  const ready: WorkerMeshReadyData = { kind: 'worker-mesh-ready', actors: [...actors.keys()] };
  context.ready(ready);
  return { system, cluster };
}

