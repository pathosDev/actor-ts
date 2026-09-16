import { Actor } from '../Actor.js';
import { ActorSystem } from '../ActorSystem.js';
import { ActorSystemOptions } from '../ActorSystemOptions.js';
import { Cluster } from '../cluster/Cluster.js';
import { ClusterOptions } from '../cluster/ClusterOptions.js';
import type { NodeAddress } from '../cluster/NodeAddress.js';
import type { ConfigObject } from '../config/HoconParser.js';
import type { WorkerNodeContext } from './WorkerNode.js';

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

/** The subset of `Actor` a registry entry is checked against: constructible with no arguments. */
export type WorkerActorClass = new () => Actor<unknown>;

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
  const systemOptions = ActorSystemOptions.create().withConfig(init.config);
  const system = ActorSystem.create(context.systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(context.self.host)
    .withPort(context.self.port)
    .withSeeds([...init.seeds])
    .withRoles([...init.roles])
    .withTransport(context.transport);
  const cluster = await Cluster.join(system, clusterOptions);

  const actors = new Map<string, WorkerActorClass>();
  const origin = new Map<string, string>();
  const modules: Array<{ readonly href: string; readonly exports: Record<string, unknown> }> = [];
  for (const href of init.modules) {
    const exports = await importModule(href);
    modules.push({ href, exports });
    for (const [exportName, value] of Object.entries(exports)) {
      if (!isActorClass(value)) continue;
      const previous = actors.get(exportName);
      if (previous !== undefined && previous !== value) {
        throw new Error(
          `worker-mesh bootstrap: two actor modules export '${exportName}' — `
          + `${origin.get(exportName)} and ${href}; an export name is the actor class's `
          + 'identity across the thread boundary, so it has to be unique',
        );
      }
      actors.set(exportName, value);
      origin.set(exportName, href);
    }
  }

  const setupContext: WorkerMeshSetupContext = { system, cluster, selfAddress: context.self, actors };
  for (const module of modules) {
    const setup = (module.exports as WorkerMeshSetupModule).setup;
    if (typeof setup === 'function') await setup.call(module.exports, setupContext);
  }

  const ready: WorkerMeshReadyData = { kind: 'worker-mesh-ready', actors: [...actors.keys()] };
  context.ready(ready);
  return { system, cluster };
}

/**
 * An exported value the worker can `spawn`: a class whose prototype chain
 * reaches `Actor`.  The check is structural on purpose — a module bundled
 * separately may carry its own copy of `Actor`, and `instanceof` across two
 * copies is false — so it walks the prototype chain looking for the
 * `onReceive` contract every actor implements.
 */
export function isActorClass(value: unknown): value is WorkerActorClass {
  if (typeof value !== 'function') return false;
  if (value.prototype instanceof Actor) return true;
  let prototype: unknown = value.prototype;
  while (prototype !== null && typeof prototype === 'object') {
    if (Object.prototype.hasOwnProperty.call(prototype, 'onReceive')
      && typeof (prototype as { onReceive?: unknown }).onReceive === 'function'
      && prototype !== Object.prototype) {
      return true;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}
