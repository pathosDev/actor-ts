import { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { WorkerBackend } from '../runtime/worker/index.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { RestartPolicy } from './WorkerCluster.js';
import {
  BOOTSTRAP_ALLOWED_HOST,
  BOOTSTRAP_ALLOWED_PROTOCOL,
  parseBootstrapUrl,
  type WorkerPermanentlyDownInfo,
} from './WorkerClusterOptions.js';

/**
 * Hostname component of the main thread's {@link NodeAddress}.  Sorts before
 * {@link DEFAULT_MESH_WORKER_HOSTNAME}, and that is a choice with a
 * consequence: the cluster leader is the lowest-addressed `up` member, so with
 * the defaults the main thread leads and hosts the shard coordinator.  A
 * worker hostname that sorts *before* the main one moves both onto a worker.
 */
export const DEFAULT_MESH_MAIN_HOSTNAME = 'main';
/** Hostname component of every worker's address — see {@link DEFAULT_MESH_MAIN_HOSTNAME}. */
export const DEFAULT_MESH_WORKER_HOSTNAME = 'worker';
/** Port of the main thread's address.  Synthetic — nothing binds it. */
export const DEFAULT_MESH_MAIN_PORT = 1;
/**
 * Port of the first worker; each slot increments.  `2` rather than the
 * worker cluster's `1` so a mesh whose two hostnames were set equal by mistake
 * still fails on the validator's hostname rule and not on an address clash.
 */
export const DEFAULT_MESH_BASE_PORT = 2;
/**
 * `'auto'` here means the machine's available parallelism **minus one**: the
 * main thread is a working member of the mesh — it dispatches, relays every
 * cross-worker frame through the broker, and runs whatever it did not offload
 * — so a pool that also takes its core measures contention rather than
 * parallelism.  Floored at one worker.
 */
export const DEFAULT_MESH_WORKER_COUNT: number | 'auto' = 'auto';
/** Roles the main thread joins with when nothing sets them. */
export const DEFAULT_MESH_MAIN_ROLES: ReadonlyArray<string> = [];
/** Roles every worker joins with when nothing sets them. */
export const DEFAULT_MESH_WORKER_ROLES: ReadonlyArray<string> = [];

/** Plain options-object shape accepted by {@link WorkerMesh.start}. */
export type WorkerMeshOptionsType = {
  /**
   * The module — or modules — every worker imports after it has joined: the
   * actor classes it exports are what the worker can spawn by name, and an
   * exported `setup(context)` runs once the node is up.  Resolved against the
   * caller, as in `new URL('./actors.js', import.meta.url)`; the same `file:`
   * and no-host rules as a worker bootstrap apply, and for the same reason —
   * the worker will *execute* it.
   *
   * Deliberately not a HOCON leaf, like `bootstrap` (#883): a config file is a
   * wider surface than the call site, and a leaf here would let something
   * other than the application's own source decide which code a worker runs.
   */
  readonly module: URL | string | ReadonlyArray<URL | string>;
  /**
   * The worker entry module.  Default: the framework's own
   * `worker-mesh-bootstrap`, resolved next to this package's files — which is
   * what breaks under a bundler that inlines the package, and why this exists
   * as an escape hatch: point it at wherever the build put the bootstrap.
   */
  readonly bootstrap?: URL | string;
  readonly workers?: number | 'auto';
  readonly mainHostname?: string;
  readonly mainPort?: number;
  readonly workerHostname?: string;
  readonly basePort?: number;
  readonly mainRoles?: ReadonlyArray<string>;
  readonly workerRoles?: ReadonlyArray<string>;
  /**
   * How long a worker gets to handshake, and how long the mesh then waits for
   * every member to be `up`.  Default: the worker cluster's `readyTimeoutMs`.
   */
  readonly readyTimeoutMs?: number;
  readonly restartPolicy?: RestartPolicy;
  readonly restartMinBackoffMs?: number;
  readonly restartMaxBackoffMs?: number;
  readonly restartRandomFactor?: number;
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  readonly onWorkerPermanentlyDown?: (info: WorkerPermanentlyDownInfo) => void;
  readonly backend?: WorkerBackend;
};

/**
 * Fluent builder for {@link WorkerMeshOptionsType}:
 *
 *     const meshOptions = WorkerMeshOptions.create()
 *       .withModule(new URL('./actors.js', import.meta.url))
 *       .withWorkers('auto');
 *     const mesh = await WorkerMesh.start(system, meshOptions);
 *
 * `withModule` is mandatory.  The restart knobs are the worker cluster's —
 * unset, they fall through to `actor-ts.worker-cluster.*` and its defaults.
 */
export class WorkerMeshOptionsBuilder extends OptionsBuilder<WorkerMeshOptionsType> {
  /** Start a fresh builder.  Equivalent to `new WorkerMeshOptionsBuilder()`. */
  static create(): WorkerMeshOptionsBuilder {
    return new WorkerMeshOptionsBuilder();
  }

  /** The actor module(s) every worker imports — see {@link WorkerMeshOptionsType.module}.  Required. */
  withModule(module: URL | string | ReadonlyArray<URL | string>): this {
    return this.set('module', module);
  }

  /** The worker entry module, for builds that moved the shipped bootstrap.  Default: the shipped one. */
  withBootstrap(bootstrap: URL | string): this {
    return this.set('bootstrap', bootstrap);
  }

  /** Worker count, or `'auto'` — available parallelism minus the main thread.  Default: `'auto'`. */
  withWorkers(workers: number | 'auto'): this {
    return this.set('workers', workers);
  }

  /** Hostname of the main thread's address.  Default: `'main'`. */
  withMainHostname(mainHostname: string): this {
    return this.set('mainHostname', mainHostname);
  }

  /** Port of the main thread's address.  Default: 1. */
  withMainPort(mainPort: number): this {
    return this.set('mainPort', mainPort);
  }

  /** Hostname of every worker's address.  Default: `'worker'`. */
  withWorkerHostname(workerHostname: string): this {
    return this.set('workerHostname', workerHostname);
  }

  /** Port of the first worker; each slot increments.  Default: 2. */
  withBasePort(basePort: number): this {
    return this.set('basePort', basePort);
  }

  /** Roles the main thread joins with.  Default: none. */
  withMainRoles(mainRoles: ReadonlyArray<string>): this {
    return this.set('mainRoles', mainRoles);
  }

  /** Roles every worker joins with — what role-restricted singletons, shards and routers select on.  Default: none. */
  withWorkerRoles(workerRoles: ReadonlyArray<string>): this {
    return this.set('workerRoles', workerRoles);
  }

  /** Handshake deadline per worker, and the membership deadline for the whole mesh.  Default: 10000ms. */
  withReadyTimeoutMs(readyTimeoutMs: number): this {
    return this.set('readyTimeoutMs', readyTimeoutMs);
  }

  /** Restart policy for crashed / exited workers.  Default: `'on-failure'`. */
  withRestartPolicy(restartPolicy: RestartPolicy): this {
    return this.set('restartPolicy', restartPolicy);
  }

  /** Delay before the first respawn of a crashed slot.  Default: 200ms. */
  withRestartMinBackoffMs(restartMinBackoffMs: number): this {
    return this.set('restartMinBackoffMs', restartMinBackoffMs);
  }

  /** Ceiling for the respawn delay.  Default: 10000ms. */
  withRestartMaxBackoffMs(restartMaxBackoffMs: number): this {
    return this.set('restartMaxBackoffMs', restartMaxBackoffMs);
  }

  /** ± jitter fraction on each respawn delay.  Default: 0.2. */
  withRestartRandomFactor(restartRandomFactor: number): this {
    return this.set('restartRandomFactor', restartRandomFactor);
  }

  /** Restarts granted per slot inside the window; `-1` = forever.  Default: 10. */
  withMaxRestarts(maxRestarts: number): this {
    return this.set('maxRestarts', maxRestarts);
  }

  /** Sliding window the restart budget counts over.  Default: 60000ms. */
  withRestartWindowMs(restartWindowMs: number): this {
    return this.set('restartWindowMs', restartWindowMs);
  }

  /** Called once per slot whose restart budget is spent.  Default: a log line. */
  withOnWorkerPermanentlyDown(
    onWorkerPermanentlyDown: (info: WorkerPermanentlyDownInfo) => void,
  ): this {
    return this.set('onWorkerPermanentlyDown', onWorkerPermanentlyDown);
  }

  /** Spawn through this backend instead of the detected one — a fake in a test.  Default: detected. */
  withBackend(backend: WorkerBackend): this {
    return this.set('backend', backend);
  }
}

/** Validates resolved {@link WorkerMeshOptionsType} settings. */
export class WorkerMeshOptionsValidator extends OptionsValidator<WorkerMeshOptionsType> {
  constructor() {
    super('WorkerMeshOptions');
  }

  protected rules(s: Partial<WorkerMeshOptionsType>): void {
    if (s.module === undefined) {
      this.fail('module', 'is required — the workers have nothing to import without it');
    }
    const modules = Array.isArray(s.module) ? s.module : [s.module];
    for (const module of modules as ReadonlyArray<URL | string>) this.moduleUrl('module', module);
    if (s.bootstrap !== undefined) this.moduleUrl('bootstrap', s.bootstrap);
    // `workers` is `number | 'auto'`, so the field-name helpers cannot address it.
    if (s.workers !== undefined && s.workers !== 'auto' && (!Number.isInteger(s.workers) || s.workers < 1)) {
      this.fail('workers', "must be a positive integer or 'auto'", s.workers);
    }
    this.nonEmptyString('mainHostname');
    this.nonEmptyString('workerHostname');
    this.port('mainPort');
    this.port('basePort');
    // The two sides are told apart by hostname alone — a worker's port may
    // equal the main port — so equal hostnames would make the main address
    // collide with a worker slot, and the broker refuses the second register.
    if (s.mainHostname !== undefined && s.workerHostname !== undefined && s.mainHostname === s.workerHostname) {
      this.fail(
        'workerHostname',
        `must differ from mainHostname ('${s.mainHostname}') — the two sides of the mesh are told apart by hostname`,
        s.workerHostname,
      );
    }
    this.positiveNumber('readyTimeoutMs');
    this.oneOf('restartPolicy', ['always', 'on-failure', 'never']);
    this.nonNegativeNumber('restartMinBackoffMs');
    this.nonNegativeNumber('restartMaxBackoffMs');
    this.numberInRange('restartRandomFactor', 0, 1);
    this.nonNegativeNumber('restartWindowMs');
    if (s.maxRestarts !== undefined && (!Number.isInteger(s.maxRestarts) || s.maxRestarts < -1)) {
      this.fail('maxRestarts', 'must be an integer >= -1 (-1 = unlimited)', s.maxRestarts);
    }
    if (s.restartMinBackoffMs !== undefined && s.restartMaxBackoffMs !== undefined
      && s.restartMaxBackoffMs < s.restartMinBackoffMs) {
      this.fail(
        'restartMaxBackoffMs',
        `must be >= restartMinBackoffMs (${s.restartMinBackoffMs})`,
        s.restartMaxBackoffMs,
      );
    }
  }

  /**
   * The same allow-list a worker bootstrap is held to (#776): an absolute,
   * host-less `file:` URL.  A module is code the worker will run, and the
   * scheme decides where that code comes from.
   */
  private moduleUrl(field: 'module' | 'bootstrap', value: URL | string): void {
    const url = parseBootstrapUrl(value);
    if (url === undefined) {
      this.fail(
        field,
        'must be an absolute URL — resolve a relative specifier against the caller first, '
        + "as in new URL('./actors.js', import.meta.url)",
        value,
      );
    }
    if (url.protocol !== BOOTSTRAP_ALLOWED_PROTOCOL) {
      this.fail(
        field,
        `must use the ${BOOTSTRAP_ALLOWED_PROTOCOL} scheme — a data:, blob: or remote `
        + 'specifier hands the worker code from outside the deployment',
        url.href,
      );
    }
    if (url.host !== BOOTSTRAP_ALLOWED_HOST) {
      this.fail(
        field,
        'must be a host-less file: URL — a host makes it a UNC path, so the module is fetched off that server',
        url.href,
      );
    }
  }
}

/**
 * The slice of mesh settings HOCON can supply.  `module` and `bootstrap` stay
 * out for the reason {@link WorkerMeshOptionsType.module} gives; the restart
 * knobs are read by the worker cluster from `actor-ts.worker-cluster.*` and
 * are not repeated here.
 */
export type WorkerMeshConfigDefaults = Pick<
  WorkerMeshOptionsType,
  'workers' | 'mainHostname' | 'mainPort' | 'workerHostname' | 'basePort' | 'mainRoles' | 'workerRoles'
>;

/**
 * Read `actor-ts.worker-mesh.*`.  Loads the config itself by default for the
 * same reason `readWorkerClusterOptionsFromConfig` does — but `WorkerMesh.start`
 * has a system in scope and passes `system.config`, so the effective config is
 * what gets read there.
 */
export function readWorkerMeshOptionsFromConfig(
  config: Config = Config.load(),
): WorkerMeshConfigDefaults {
  const keys = ConfigKeys.workerMesh;
  const out: { -readonly [K in keyof WorkerMeshConfigDefaults]: WorkerMeshConfigDefaults[K] } = {};
  if (config.hasPath(keys.workers)) {
    const raw = config.getString(keys.workers);
    out.workers = raw === 'auto' ? 'auto' : config.getInt(keys.workers);
  }
  if (config.hasPath(keys.mainHostname)) {
    out.mainHostname = config.getString(keys.mainHostname);
  }
  if (config.hasPath(keys.mainPort)) {
    out.mainPort = config.getInt(keys.mainPort);
  }
  if (config.hasPath(keys.workerHostname)) {
    out.workerHostname = config.getString(keys.workerHostname);
  }
  if (config.hasPath(keys.basePort)) {
    out.basePort = config.getInt(keys.basePort);
  }
  if (config.hasPath(keys.mainRoles)) {
    out.mainRoles = config.getStringList(keys.mainRoles);
  }
  if (config.hasPath(keys.workerRoles)) {
    out.workerRoles = config.getStringList(keys.workerRoles);
  }
  return out;
}

/** Layer explicit options over the HOCON block: explicit > HOCON > built-in defaults. */
export function withWorkerMeshConfigDefaults(
  options: WorkerMeshOptionsType,
  config?: Config,
): WorkerMeshOptionsType {
  return mergeOptions<WorkerMeshOptionsType>(
    {},
    readWorkerMeshOptionsFromConfig(config),
    options,
  );
}

/**
 * Accepted input for {@link WorkerMesh.start}: the fluent
 * {@link WorkerMeshOptionsBuilder} OR a plain {@link WorkerMeshOptionsType}.
 */
export type WorkerMeshOptions = WorkerMeshOptionsBuilder | Partial<WorkerMeshOptionsType>;
/** Value alias so `WorkerMeshOptions.create()` / `new WorkerMeshOptions()` resolve to the builder. */
export const WorkerMeshOptions = WorkerMeshOptionsBuilder;
