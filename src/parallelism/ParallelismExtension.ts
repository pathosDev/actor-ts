import type { ActorClassOrFactory } from '../Actor.js';
import type { ActorOptions } from '../ActorOptions.js';
import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { NodeAddress } from '../cluster/NodeAddress.js';
import type { WireMessage } from '../cluster/Protocol.js';
import { assertUserAssignableName } from '../ActorPath.js';
import { remoteActorPath } from '../cluster/RemoteActorRef.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { extensionId, type Extension } from '../Extension.js';
import { isClassForm } from '../internal/ActorBlueprint.js';
import { USER_GUARDIAN_NAME } from '../internal/Guardian.js';
import type { Cancellable } from '../Scheduler.js';
import {
  conventionalActorModule,
  conventionalActorModuleCandidates,
  entryModuleUrl,
} from '../runtime/entry/EntryModule.js';
import { OptionsError } from '../util/OptionsValidator.js';
import { randomId } from '../util/RandomString.js';
import type { WorkerMesh } from '../worker/WorkerMesh.js';
import {
  DEFAULT_MESH_MAIN_HOSTNAME,
  DEFAULT_MESH_WORKER_HOSTNAME,
  readWorkerMeshOptionsFromConfig,
  type WorkerMeshOptionsType,
} from '../worker/WorkerMeshOptions.js';
import { collectActorExports, type WorkerActorClass } from './ActorModuleRegistry.js';
import { LEADING_WORKER_HOSTNAME, WORKER_TERMINATE_GRACE_MS } from './Constants.js';
import { compilePathPattern, type PathPattern } from './PathPattern.js';
import {
  DEFAULT_PARALLELISM_BUFFER_SIZE,
  DEFAULT_PARALLELISM_LEADER,
  DEFAULT_PARALLELISM_OFFLOAD,
  DEFAULT_PARALLELISM_PLACEMENT,
  DEFAULT_PARALLELISM_SPAWN_TIMEOUT_MS,
  DEFAULT_PARALLELISM_WORKERS,
  ParallelismOptionsValidator,
  withParallelismConfigDefaults,
  type MeshLeader,
  type ParallelismOptionsType,
  type PlacementStrategy,
} from './ParallelismOptions.js';
import { PendingRemoteActorRef, type PendingBufferAccount } from './PendingRemoteActorRef.js';
import type {
  ParallelismSpawnFailedMessage,
  ParallelismSpawnMessage,
  ParallelismSpawnedMessage,
  ParallelismTerminateMessage,
  ParallelismTerminatedMessage,
} from './SpawnProtocol.js';

const REQUEST_ID_LENGTH = 16;

/** A spawn the extension has accepted: issued to a worker, or waiting for the mesh to come up. */
type PendingSpawn = {
  readonly requestId: string;
  readonly ref: PendingRemoteActorRef<unknown>;
  readonly actor: WorkerActorClass;
  readonly name: string;
  readonly nameSource: 'caller' | 'generated';
  readonly options: Record<string, unknown> | undefined;
  deadline: Cancellable | null;
};

/**
 * Actors on worker threads from configuration alone (#1563).
 *
 * `actor-ts.parallelism.workers` above zero makes `ActorSystem.create` start a
 * `WorkerMesh` in the background and turns `system.spawn` into a placement
 * decision: an actor whose path matches `offload` is created on a worker,
 * every other one where it always was.  The application does not change —
 * the same `spawn(MyActor, 'x')` returns an `ActorRef` that `tell`s, `ask`s
 * and `watch`es across the thread, and `ref.path` is the path it would have
 * had at home — and `workers = 0`, the default, is the untouched code path:
 * no mesh, no import, one null check.
 *
 * What cannot be hidden is said loudly instead of silently: the factory form
 * of `spawn` is a closure and cannot cross a thread; a class has to be
 * exported from the actor module for both sides to name it; and `/system` is
 * never a placement target (see `ParallelismOptionsValidator`).  Children
 * stay with their parent, so the unit of offload is the subtree.
 */
export class ParallelismExtension implements Extension {
  /** `false` when `workers = 0`: the extension exists, and does nothing. */
  readonly enabled: boolean;
  private readonly options: ParallelismOptionsType;
  private readonly modules: ReadonlyArray<URL>;
  private readonly hostnames: { readonly mainHostname: string; readonly workerHostname: string } | null;
  private readonly patterns: ReadonlyArray<PathPattern>;
  private readonly placement: PlacementStrategy;
  private readonly spawnTimeoutMs: number;
  private readonly bufferSize: number;
  private mesh: WorkerMesh | null = null;
  /** `class → export name`, built from the main thread's own import of the actor modules. */
  private registry: Map<unknown, string> | null = null;
  private startup: Promise<void> | null = null;
  private startupError: Error | null = null;
  private readonly waiting: PendingSpawn[] = [];
  private readonly issued = new Map<string, PendingSpawn>();
  private buffered = 0;
  private roundRobin = 0;
  private unsubscribeWire: Array<() => void> = [];
  private terminatedAcks: Map<string, () => void> = new Map();

  constructor(
    private readonly system: ActorSystem,
    explicitOptions: ParallelismOptionsType | undefined,
  ) {
    const resolved = withParallelismConfigDefaults(explicitOptions, system.config);
    new ParallelismOptionsValidator().validate(resolved);
    this.options = resolved;
    const workers = resolved.workers ?? DEFAULT_PARALLELISM_WORKERS;
    this.enabled = workers !== 0;
    this.patterns = (resolved.offload ?? DEFAULT_PARALLELISM_OFFLOAD).map(compilePathPattern);
    this.placement = resolved.placement ?? DEFAULT_PARALLELISM_PLACEMENT;
    this.spawnTimeoutMs = resolved.spawnTimeoutMs ?? DEFAULT_PARALLELISM_SPAWN_TIMEOUT_MS;
    this.bufferSize = resolved.bufferSize ?? DEFAULT_PARALLELISM_BUFFER_SIZE;
    // Both resolved now, synchronously, so a missing module or a leader the
    // hostnames contradict fails `ActorSystem.create` on the caller's stack
    // rather than the mesh's background start.
    this.modules = this.enabled ? resolveActorModules(resolved) : [];
    this.hostnames = this.enabled
      ? hostnamesFor(resolved.leader ?? DEFAULT_PARALLELISM_LEADER, readWorkerMeshOptionsFromConfig(system.config))
      : null;
  }

  /**
   * @internal Start the mesh in the background.  Called by the `ActorSystem`
   * constructor once the guardians exist — the mesh joins a cluster, which
   * spawns under `/system`.
   */
  _start(): void {
    if (!this.enabled || this.startup !== null) return;
    this.startup = this.startMesh();
    this.startup.catch((error: unknown) => this.onStartupFailed(error));
    this.system._beforeTerminate(() => this.shutdown());
  }

  /** Resolves once the mesh is up and the actor modules are registered; rejects with what stopped it. */
  whenReady(): Promise<void> {
    return this.startup ?? Promise.resolve();
  }

  /** The mesh, once it is up. */
  get workerMesh(): WorkerMesh | null { return this.mesh; }

  /** The export names the main thread will offload, once the modules are loaded. */
  get exportedActors(): ReadonlyArray<string> {
    return this.registry === null ? [] : [...this.registry.values()];
  }

  /**
   * @internal The placement decision behind `system.spawn`.  `null` means
   * "not this one — spawn it locally"; a ref means the actor is being created
   * on a worker.  Throws where a placement cannot be carried out, naming what
   * would make it work.
   */
  _place<T>(
    actor: ActorClassOrFactory<T>,
    name: string,
    options: ActorOptions<T> | undefined,
    nameSource: 'caller' | 'generated',
  ): ActorRef<T> | null {
    const path = `/${USER_GUARDIAN_NAME}/${name}`;
    if (!this.patterns.some((pattern) => pattern.matches(path))) return null;
    // The same two checks the local path runs in `_createChild`, on the
    // caller's stack: a bad name is the caller's mistake, not the worker's.
    // `remoteActorPath` wants the full URI — handed the bare form it yields
    // the root (#1568).
    const actorPath = remoteActorPath(`actor-ts://${this.system.name}${path}`, this.system.name);
    if (nameSource === 'caller') assertUserAssignableName(name, actorPath.parent!);
    if (this.startupError !== null) {
      throw new Error(
        `cannot offload ${path}: the worker mesh failed to start — ${this.startupError.message}`,
        { cause: this.startupError },
      );
    }
    if (!isClassForm(actor)) {
      throw new Error(
        `cannot offload ${path}: spawn() got a factory, and a factory is a closure that cannot cross a thread. `
        + 'Pass the actor class itself — spawn(MyActor, name) — with MyActor exported from the actor module, '
        + `or keep this actor on the main thread by excluding its path from ${ConfigKeys.parallelism.offload}`,
      );
    }
    const actorClass = actor as unknown as WorkerActorClass;
    if (this.registry !== null && !this.registry.has(actorClass)) {
      throw new Error(this.describeUnexportedClass(actorClass, path));
    }
    const cloned = cloneableActorOptions(options, path);
    const ref = new PendingRemoteActorRef<T>(actorPath, this.system, this.account);
    const pending: PendingSpawn = {
      requestId: randomId(REQUEST_ID_LENGTH),
      ref: ref as PendingRemoteActorRef<unknown>,
      actor: actorClass,
      name,
      nameSource,
      options: cloned,
      deadline: null,
    };
    if (this.mesh === null) this.waiting.push(pending);
    else this.issue(pending);
    return ref;
  }

  private readonly account: PendingBufferAccount = {
    reserve: () => {
      if (this.buffered >= this.bufferSize) {
        this.warnBufferFull();
        return false;
      }
      this.buffered++;
      return true;
    },
    release: (count) => { this.buffered -= count; },
  };

  private warnedBufferFull = false;

  private warnBufferFull(): void {
    if (this.warnedBufferFull) return;
    this.warnedBufferFull = true;
    this.system.log.warn(
      `[parallelism] the spawn buffer is full (${this.bufferSize} messages across every pending spawn) — `
      + 'dropping to dead letters until the workers acknowledge.  Raise the cap with '
      + `\`${ConfigKeys.parallelism.bufferSize}\` if the mesh is slow to come up, or check why a worker is not answering`,
    );
  }

  private async startMesh(): Promise<void> {
    const { WorkerMesh } = await import('../worker/WorkerMesh.js');
    const registry = await this.loadRegistry();
    const meshOptions = this.meshOptions();
    const mesh = await WorkerMesh.start(this.system, meshOptions);
    if (this.system._isTerminating()) {
      // The system went down while the threads were coming up.
      await mesh.terminate();
      throw new Error('the actor system terminated before the worker mesh was up');
    }
    this.registry = registry;
    this.mesh = mesh;
    this.unsubscribeWire = [
      mesh.cluster._onWire('parallelism-spawned', (message, from) =>
        this.onSpawned(message as unknown as ParallelismSpawnedMessage, from)),
      mesh.cluster._onWire('parallelism-spawn-failed', (message, from) =>
        this.onSpawnFailed(message as unknown as ParallelismSpawnFailedMessage, from)),
      mesh.cluster._onWire('parallelism-terminated', (message, from) =>
        this.onWorkerTerminated(message as unknown as ParallelismTerminatedMessage, from)),
    ];
    const waiting = this.waiting.splice(0);
    for (const pending of waiting) this.issue(pending);
  }

  /** The main thread's half of the registry: which export name each class is known by. */
  private async loadRegistry(): Promise<Map<unknown, string>> {
    const byName = new Map<string, WorkerActorClass>();
    const origins = new Map<string, string>();
    for (const module of this.modules) {
      const exports = (await import(module.href)) as Record<string, unknown>;
      collectActorExports(module.href, exports, byName, origins);
    }
    const byClass = new Map<unknown, string>();
    for (const [name, actorClass] of byName) byClass.set(actorClass, name);
    return byClass;
  }

  private meshOptions(): WorkerMeshOptionsType {
    const meshOptions: { -readonly [K in keyof WorkerMeshOptionsType]: WorkerMeshOptionsType[K] } = {
      module: this.modules,
      workers: this.options.workers ?? DEFAULT_PARALLELISM_WORKERS,
      ...this.hostnames!,
    };
    if (this.options.bootstrap !== undefined) meshOptions.bootstrap = this.options.bootstrap;
    if (this.options.backend !== undefined) meshOptions.backend = this.options.backend;
    return meshOptions;
  }

  private onStartupFailed(error: unknown): void {
    this.startupError = error instanceof Error ? error : new Error(String(error));
    // A start abandoned because the system is going down is the shutdown
    // doing its job, not a failure to report as one.
    if (this.system._isTerminating()) {
      this.system.log.debug(`[parallelism] the worker mesh start was abandoned: ${this.startupError.message}`);
    } else {
      this.system.log.error(
        '[parallelism] the worker mesh failed to start; every offloaded spawn fails from here on',
        this.startupError,
      );
    }
    for (const pending of this.waiting.splice(0)) pending.ref._fail();
  }

  private issue(pending: PendingSpawn): void {
    const mesh = this.mesh!;
    const exportName = this.registry!.get(pending.actor);
    if (exportName === undefined) {
      // Only reachable for a spawn accepted before the modules were loaded;
      // afterwards `_place` throws on the caller's stack instead.
      this.system.log.error(this.describeUnexportedClass(pending.actor, pending.ref.path.toString()));
      pending.ref._fail();
      return;
    }
    const workers = mesh.addresses;
    if (workers.length === 0) {
      this.system.log.error(`[parallelism] no worker is up to host ${pending.ref.path}`);
      pending.ref._fail();
      return;
    }
    const worker = workers[this.pick(pending.name, workers.length)]!;
    this.issued.set(pending.requestId, pending);
    pending.deadline = this.system.scheduler.scheduleOnceFunction(
      this.spawnTimeoutMs,
      () => this.onSpawnTimedOut(pending.requestId, worker),
    );
    const frame: ParallelismSpawnMessage = {
      kind: 'parallelism-spawn',
      requestId: pending.requestId,
      name: pending.name,
      nameSource: pending.nameSource,
      actorClass: exportName,
      ...(pending.options === undefined ? {} : { options: pending.options }),
    };
    mesh.cluster._sendWire(worker, frame as unknown as WireMessage);
  }

  /** Which worker, by slot index. */
  private pick(name: string, workerCount: number): number {
    if (this.placement === 'round-robin') {
      const index = this.roundRobin % workerCount;
      this.roundRobin = (this.roundRobin + 1) % workerCount;
      return index;
    }
    return fnv1a(name) % workerCount;
  }

  private onSpawned(message: ParallelismSpawnedMessage, from: NodeAddress): void {
    const pending = this.settle(message.requestId);
    if (pending === undefined) return;
    pending.ref._resolve(this.mesh!.refFor(from, message.path));
  }

  private onSpawnFailed(message: ParallelismSpawnFailedMessage, from: NodeAddress): void {
    const pending = this.settle(message.requestId);
    if (pending === undefined) return;
    this.system.log.error(`[parallelism] worker ${from} refused to spawn ${pending.ref.path}: ${message.reason}`);
    pending.ref._fail();
  }

  private onSpawnTimedOut(requestId: string, worker: NodeAddress): void {
    const pending = this.settle(requestId);
    if (pending === undefined) return;
    this.system.log.error(
      `[parallelism] worker ${worker} did not acknowledge the spawn of ${pending.ref.path} within `
      + `${this.spawnTimeoutMs} ms (\`${ConfigKeys.parallelism.spawnTimeout}\`)`,
    );
    pending.ref._fail();
  }

  private settle(requestId: string): PendingSpawn | undefined {
    const pending = this.issued.get(requestId);
    if (pending === undefined) return undefined;
    this.issued.delete(requestId);
    pending.deadline?.cancel();
    pending.deadline = null;
    return pending;
  }

  private onWorkerTerminated(_message: ParallelismTerminatedMessage, from: NodeAddress): void {
    const resolve = this.terminatedAcks.get(from.toString());
    if (resolve === undefined) return;
    this.terminatedAcks.delete(from.toString());
    resolve();
  }

  /**
   * The system is terminating: give every worker's system its own orderly
   * `terminate()` — so an offloaded actor gets its `postStop` like a local
   * one — then stop the threads and leave.  Bounded, because a worker that
   * never answers must not hold the main thread's shutdown open.
   */
  private async shutdown(): Promise<void> {
    if (this.startup !== null) {
      try { await this.startup; } catch { /* reported by onStartupFailed */ }
    }
    for (const pending of this.waiting.splice(0)) pending.ref._fail();
    for (const requestId of [...this.issued.keys()]) this.settle(requestId)?.ref._fail();
    const mesh = this.mesh;
    if (mesh === null) return;
    this.mesh = null;
    const acks = mesh.addresses.map((worker) => new Promise<void>((resolve) => {
      this.terminatedAcks.set(worker.toString(), resolve);
      const frame: ParallelismTerminateMessage = { kind: 'parallelism-terminate' };
      mesh.cluster._sendWire(worker, frame as unknown as WireMessage);
    }));
    // Wall clock on purpose, not `system.scheduler`: this is the safety net
    // for a worker that never answers, and under a virtual scheduler a test
    // that does not advance time would otherwise hang its own teardown.
    const budgetMs = this.system._shutdownDrainTimeoutMs + WORKER_TERMINATE_GRACE_MS;
    let budget: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(acks),
      new Promise<void>((resolve) => { budget = setTimeout(resolve, budgetMs); }),
    ]);
    if (budget !== undefined) clearTimeout(budget);
    this.terminatedAcks.clear();
    for (const unsubscribe of this.unsubscribeWire) unsubscribe();
    this.unsubscribeWire = [];
    await mesh.terminate();
  }

  private describeUnexportedClass(actorClass: WorkerActorClass, path: string): string {
    const className = (actorClass as { name?: string }).name || '(anonymous class)';
    return `cannot offload ${path}: ${className} is not exported from the actor module `
      + `(${this.modules.map((module) => module.href).join(', ')}) — the worker can only spawn a class it can `
      + 'import by export name.  Export it there, name another module with ParallelismOptions.withModule(...), '
      + `or keep this actor on the main thread by excluding its path from ${ConfigKeys.parallelism.offload}`;
  }
}

export const ParallelismExtensionId = extensionId<ParallelismExtension>(
  'parallelism',
  (system) => new ParallelismExtension(system, system._explicitParallelismOptions),
);

/**
 * The actor modules: the ones named explicitly, or the conventional
 * `actors.js` next to the entry module.  Neither → `OptionsError` naming the
 * candidates that were looked for and the option that names one.
 */
function resolveActorModules(options: ParallelismOptionsType): URL[] {
  if (options.module !== undefined) {
    const modules = Array.isArray(options.module) ? options.module : [options.module];
    return (modules as ReadonlyArray<URL | string>).map((module) => (module instanceof URL ? module : new URL(module)));
  }
  const entry = entryModuleUrl();
  const conventional = entry === null ? null : conventionalActorModule(entry);
  if (conventional !== null) return [conventional];
  const looked = entry === null
    ? 'the entry module could not be determined, so there was nowhere to look for one'
    : `looked for ${conventionalActorModuleCandidates(entry).map((candidate) => candidate.href).join(', ')}`;
  throw new OptionsError(
    `ParallelismOptions: ${ConfigKeys.parallelism.workers} is set but there is no actor module — ${looked}. `
    + 'Put an actors.js (or .ts) next to the entry module that exports every actor class to offload, '
    + 'or name one in code with ParallelismOptions.withModule(new URL(\'./actors.js\', import.meta.url))',
    'ParallelismOptions',
    'module',
    undefined,
  );
}

/**
 * The hostname pair for the requested leader.  Addresses compare as strings
 * and the lowest `up` one leads, so the side whose hostname sorts first hosts
 * the coordinator.  Hostnames left at the mesh defaults are chosen here; ones
 * an operator set are kept, and refused when they contradict `leader` —
 * silently rewriting a hostname someone typed would be worse than the error.
 */
function hostnamesFor(
  leader: MeshLeader,
  meshConfig: { readonly mainHostname?: string; readonly workerHostname?: string },
): { mainHostname: string; workerHostname: string } {
  const configuredMain = meshConfig.mainHostname ?? DEFAULT_MESH_MAIN_HOSTNAME;
  const configuredWorker = meshConfig.workerHostname ?? DEFAULT_MESH_WORKER_HOSTNAME;
  const atDefaults = configuredMain === DEFAULT_MESH_MAIN_HOSTNAME && configuredWorker === DEFAULT_MESH_WORKER_HOSTNAME;
  if (atDefaults) {
    return leader === 'main'
      ? { mainHostname: DEFAULT_MESH_MAIN_HOSTNAME, workerHostname: DEFAULT_MESH_WORKER_HOSTNAME }
      : { mainHostname: DEFAULT_MESH_MAIN_HOSTNAME, workerHostname: LEADING_WORKER_HOSTNAME };
  }
  const mainLeads = configuredMain < configuredWorker;
  if (mainLeads !== (leader === 'main')) {
    throw new OptionsError(
      `ParallelismOptions: ${ConfigKeys.parallelism.leader} = "${leader}" but the mesh hostnames put the `
      + `${mainLeads ? 'main thread' : 'workers'} first — the lowest address leads, and `
      + `'${configuredMain}' sorts ${mainLeads ? 'before' : 'after'} '${configuredWorker}'. Change `
      + `${ConfigKeys.workerMesh.mainHostname} / ${ConfigKeys.workerMesh.workerHostname} or the leader`,
      'ParallelismOptions',
      'leader',
      leader,
    );
  }
  return { mainHostname: configuredMain, workerHostname: configuredWorker };
}

/**
 * The caller's `ActorOptions`, as the plain data a worker can receive.  A
 * builder is a bag of own properties, so the spread reads both forms alike;
 * `structuredClone` is the same check the channel will apply, so a function-
 * valued field — a supervisor strategy, a dispatcher, a mailbox factory — is
 * refused here, on the caller's stack, rather than at the port.
 */
function cloneableActorOptions(
  options: ActorOptions<unknown> | undefined,
  path: string,
): Record<string, unknown> | undefined {
  if (options === undefined) return undefined;
  const plain = { ...(options as Record<string, unknown>) };
  if (Object.keys(plain).length === 0) return undefined;
  try {
    return structuredClone(plain);
  } catch (error) {
    throw new Error(
      `cannot offload ${path}: its ActorOptions carry a value that cannot cross a thread `
      + `(${Object.keys(plain).join(', ')}) — a supervisor strategy, a dispatcher or a mailbox factory is code, `
      + 'and only data crosses.  Configure those on the worker side, in the actor module\'s setup(), '
      + `or keep this actor on the main thread by excluding its path from ${ConfigKeys.parallelism.offload}`,
      { cause: error },
    );
  }
}

/** FNV-1a, 32 bit: cheap, stable across runs, and spread enough for a slot index. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
