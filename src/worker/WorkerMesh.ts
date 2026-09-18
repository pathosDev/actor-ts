import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { Cluster } from '../cluster/Cluster.js';
import { ClusterOptions } from '../cluster/ClusterOptions.js';
import { NodeAddress } from '../cluster/NodeAddress.js';
import { RemoteActorRef } from '../cluster/RemoteActorRef.js';
import {
  MessageChannelTransport,
  type PortLike,
} from '../cluster/transports/MessageChannelTransport.js';
import { CoordinatedShutdownId, Phases } from '../CoordinatedShutdown.js';
import { availableParallelism } from '../runtime/Parallelism.js';
import { OptionsError } from '../util/OptionsValidator.js';
import { WorkerBroker } from './WorkerBroker.js';
import { WorkerCluster } from './WorkerCluster.js';
import { WorkerClusterOptions } from './WorkerClusterOptions.js';
import { DEFAULT_WORKER_READY_TIMEOUT_MS } from './WorkerClusterOptions.js';
import type { WorkerMeshInitData } from './worker-mesh-bootstrap.js';
import type { WorkerMeshReadyData } from './WorkerMeshBootstrap.js';
import {
  DEFAULT_MESH_BASE_PORT,
  DEFAULT_MESH_MAIN_HOSTNAME,
  DEFAULT_MESH_MAIN_PORT,
  DEFAULT_MESH_MAIN_ROLES,
  DEFAULT_MESH_WORKER_COUNT,
  DEFAULT_MESH_WORKER_HOSTNAME,
  DEFAULT_MESH_WORKER_ROLES,
  WorkerMeshOptionsValidator,
  withWorkerMeshConfigDefaults,
} from './WorkerMeshOptions.js';
import type { WorkerMeshOptions, WorkerMeshOptionsType } from './WorkerMeshOptions.js';

const MESH_SHUTDOWN_TASK_NAME = 'worker-mesh-terminate';

/** One worker of the mesh: where it is, and which actor classes it can spawn by name. */
export type WorkerMeshWorker = {
  readonly address: NodeAddress;
  readonly actors: ReadonlyArray<string>;
};

/**
 * The main thread as a member of its own worker mesh (#1562).
 *
 * `WorkerCluster` spawns N threads that each host an `ActorSystem` + `Cluster`
 * and routes their traffic through the main-thread `WorkerBroker` — and
 * leaves the main thread a relay and nothing more: it never joins, so it
 * cannot address a worker actor, `ask` has nowhere to deliver a reply, and
 * the shard coordinator lands on the lowest-addressed *worker*.  This joins
 * it.  One `MessageChannel`: one end registered with the broker under the main
 * thread's own address, the other end a `MessageChannelTransport` the main
 * system's `Cluster` runs on — so from the workers' point of view the main
 * thread is just another node, and from the main thread's a worker actor is
 * reachable through an ordinary `ActorRef`.
 *
 * Every worker runs the framework's own bootstrap rather than a script the
 * application writes: it joins the main thread, builds its system from the
 * main system's **effective** config, imports the actor module(s) the
 * options name, runs their optional `setup`, and reports which actor classes
 * it exports.  `refFor` is the entire placement API this layer offers; what
 * places actors *automatically* from config is the parallelism extension
 * built on top (#1563).
 */
export class WorkerMesh {
  readonly cluster: Cluster;
  readonly selfAddress: NodeAddress;
  readonly broker: WorkerBroker;
  private readonly workerCluster: WorkerCluster;
  private readonly system: ActorSystem;
  private closed = false;

  private constructor(
    system: ActorSystem,
    cluster: Cluster,
    broker: WorkerBroker,
    workerCluster: WorkerCluster,
  ) {
    this.system = system;
    this.cluster = cluster;
    this.selfAddress = cluster.selfAddress;
    this.broker = broker;
    this.workerCluster = workerCluster;
  }

  /**
   * Join `system` to a fresh mesh and spawn its workers.  Resolves once every
   * worker has handshaken **and** every member — the main thread included —
   * is `up`, so a returned mesh is one whose refs deliver.
   */
  static async start(system: ActorSystem, options: WorkerMeshOptions): Promise<WorkerMesh> {
    const resolved = withWorkerMeshConfigDefaults(options as WorkerMeshOptionsType, system.config);
    new WorkerMeshOptionsValidator().validate(resolved);
    if (system.cluster.isSome()) {
      throw new OptionsError(
        `WorkerMeshOptions: system '${system.name}' has already joined a cluster — a system is a member `
        + 'of one cluster, so start the mesh before joining anything else, or run the mesh as that cluster',
        'WorkerMeshOptions',
        'system',
        system.name,
      );
    }

    const workers = await resolveMeshWorkerCount(resolved.workers ?? DEFAULT_MESH_WORKER_COUNT);
    const mainAddress = new NodeAddress(
      system.name,
      resolved.mainHostname ?? DEFAULT_MESH_MAIN_HOSTNAME,
      resolved.mainPort ?? DEFAULT_MESH_MAIN_PORT,
    );
    const readyTimeoutMs = resolved.readyTimeoutMs ?? DEFAULT_WORKER_READY_TIMEOUT_MS;

    // The main thread's own port goes on the broker *before* any worker
    // exists, which is why the broker is built here and handed in rather than
    // left to `WorkerCluster`: a worker's first gossip to its seed has to find
    // the seed registered.
    const broker = new WorkerBroker();
    const channel = new MessageChannel();
    broker.register(mainAddress, channel.port1 as unknown as PortLike);
    const transport = new MessageChannelTransport(mainAddress, channel.port2 as unknown as PortLike);
    const clusterOptions = ClusterOptions.create()
      .withHost(mainAddress.host)
      .withPort(mainAddress.port)
      .withRoles([...(resolved.mainRoles ?? DEFAULT_MESH_MAIN_ROLES)])
      .withTransport(transport);
    const cluster = await Cluster.join(system, clusterOptions);

    const modules = (Array.isArray(resolved.module) ? resolved.module : [resolved.module]) as ReadonlyArray<URL | string>;
    const initData: WorkerMeshInitData = {
      kind: 'worker-mesh-init',
      // The effective config, not the file: builder-set values on this side
      // never reach a file, and a worker that re-read `application.conf`
      // would run with different timings than the node that spawned it.
      config: system.config.toJSON(),
      seeds: [mainAddress.toString()],
      roles: [...(resolved.workerRoles ?? DEFAULT_MESH_WORKER_ROLES)],
      modules: modules.map((module) => (module instanceof URL ? module.href : module)),
    };
    const workerClusterOptions = WorkerClusterOptions.create()
      .withBootstrap(resolved.bootstrap ?? defaultBootstrapUrl())
      .withWorkers(workers)
      .withSystemName(system.name)
      .withHostname(resolved.workerHostname ?? DEFAULT_MESH_WORKER_HOSTNAME)
      .withBasePort(resolved.basePort ?? DEFAULT_MESH_BASE_PORT)
      .withInitData(initData)
      .withReadyTimeoutMs(readyTimeoutMs)
      .withBroker(broker)
      .withLogger(system.log);
    if (resolved.restartPolicy !== undefined) workerClusterOptions.withRestartPolicy(resolved.restartPolicy);
    if (resolved.restartMinBackoffMs !== undefined) workerClusterOptions.withRestartMinBackoffMs(resolved.restartMinBackoffMs);
    if (resolved.restartMaxBackoffMs !== undefined) workerClusterOptions.withRestartMaxBackoffMs(resolved.restartMaxBackoffMs);
    if (resolved.restartRandomFactor !== undefined) workerClusterOptions.withRestartRandomFactor(resolved.restartRandomFactor);
    if (resolved.maxRestarts !== undefined) workerClusterOptions.withMaxRestarts(resolved.maxRestarts);
    if (resolved.restartWindowMs !== undefined) workerClusterOptions.withRestartWindowMs(resolved.restartWindowMs);
    if (resolved.onWorkerPermanentlyDown !== undefined) workerClusterOptions.withOnWorkerPermanentlyDown(resolved.onWorkerPermanentlyDown);
    if (resolved.backend !== undefined) workerClusterOptions.withBackend(resolved.backend);

    let workerCluster: WorkerCluster;
    try {
      workerCluster = await WorkerCluster.spawn(workerClusterOptions);
      await cluster.awaitReady({ minimumMembers: workers + 1, timeoutMs: readyTimeoutMs });
    } catch (error) {
      // A half-built mesh is worse than none: the main system would stay a
      // one-node cluster on a channel nobody else is on.
      await cluster.leave();
      throw error;
    }

    const mesh = new WorkerMesh(system, cluster, broker, workerCluster);
    // The threads must not outlive the system that owns them.  Registered in
    // the same phase as the cluster's own leave and ahead of it by name order
    // — the workers go first, then the main thread leaves what is by then a
    // cluster of one.
    system.extension(CoordinatedShutdownId).addFrameworkTask(
      Phases.ClusterLeave,
      MESH_SHUTDOWN_TASK_NAME,
      () => mesh.terminateWorkers(),
    );
    return mesh;
  }

  /** The workers' addresses, in slot order. */
  get addresses(): NodeAddress[] { return this.workerCluster.addresses; }

  get size(): number { return this.workerCluster.size; }

  /** Every live worker with the actor classes it reported on `ready()`. */
  get workers(): ReadonlyArray<WorkerMeshWorker> {
    return this.workerCluster.workers.map((handle) => ({
      address: handle.address,
      actors: actorsReportedBy(handle.readyData),
    }));
  }

  /**
   * An ordinary `ActorRef` to an actor on one of the workers — `tell`, `ask`,
   * `watch` all work through it.  `path` may be the bare `/user/name` form or
   * the full `actor-ts://…` one; the constructor accepts both and resolves the
   * bare form against the worker's system name, which is this mesh's (#1568).
   */
  refFor<TMessage>(address: NodeAddress, path: string): ActorRef<TMessage> {
    return new RemoteActorRef<TMessage>(address, path, this.cluster);
  }

  /**
   * Take the mesh down: the workers first, then the main thread leaves.  The
   * owning system is not terminated — that is the caller's, and a system that
   * terminates on its own takes the mesh with it through coordinated shutdown.
   */
  async terminate(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.system.extension(CoordinatedShutdownId).removeTask(Phases.ClusterLeave, MESH_SHUTDOWN_TASK_NAME);
    await this.workerCluster.terminate();
    await this.cluster.leave();
  }

  private async terminateWorkers(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.workerCluster.terminate();
  }
}

/**
 * The shipped bootstrap, next to this module in `dist/` — which is what a
 * bundler that inlines the package breaks, and why `withBootstrap` exists.
 */
function defaultBootstrapUrl(): URL {
  return new URL('./worker-mesh-bootstrap.js', import.meta.url);
}

/**
 * `'auto'` for a mesh: the `ACTOR_TS_WORKERS` override when set, otherwise
 * the machine's available parallelism **minus one** — the main thread is a
 * working member — floored at a single worker.
 */
async function resolveMeshWorkerCount(value: number | 'auto'): Promise<number> {
  if (typeof value === 'number' && value > 0) return value;
  if (typeof process !== 'undefined' && process.env?.ACTOR_TS_WORKERS) {
    const workerCount = parseInt(process.env.ACTOR_TS_WORKERS, 10);
    if (Number.isFinite(workerCount) && workerCount > 0) return workerCount;
  }
  return Math.max(1, (await availableParallelism()) - 1);
}

function actorsReportedBy(readyData: unknown): ReadonlyArray<string> {
  const data = readyData as Partial<WorkerMeshReadyData> | null | undefined;
  if (!data || data.kind !== 'worker-mesh-ready' || !Array.isArray(data.actors)) return [];
  return data.actors.filter((name): name is string => typeof name === 'string');
}
