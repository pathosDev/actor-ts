import { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { WorkerBackend } from '../runtime/worker/index.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { RestartPolicy } from './WorkerCluster.js';

/** Plain options-object shape accepted by {@link WorkerCluster.spawn}. */
export type WorkerClusterOptionsType = {
  readonly bootstrap: URL | string;
  readonly workers?: number | 'auto';
  readonly systemName?: string;
  readonly hostname?: string;
  readonly basePort?: number;
  readonly initData?: unknown;
  readonly restartPolicy?: RestartPolicy;
  readonly readyTimeoutMs?: number;
  readonly backend?: WorkerBackend;
};

/**
 * Fluent builder for {@link WorkerClusterOptionsType}:
 *
 *     WorkerCluster.spawn(
 *       WorkerClusterOptions.create()
 *         .withBootstrap(new URL('./worker.js', import.meta.url))
 *         .withWorkers(4),
 *     )
 *
 * `withBootstrap` is mandatory — there is no worker entrypoint to spawn
 * without it.  Every other field falls back to its built-in default
 * inside the constructor.
 */
export class WorkerClusterOptionsBuilder extends OptionsBuilder<WorkerClusterOptionsType> {
  /** Start a fresh builder.  Equivalent to `new WorkerClusterOptionsBuilder()`. */
  static create(): WorkerClusterOptionsBuilder {
    return new WorkerClusterOptionsBuilder();
  }

  /** Module URL (or string) of the worker entrypoint each worker runs. */
  withBootstrap(bootstrap: URL | string): this {
    return this.set('bootstrap', bootstrap);
  }

  /** Number of workers to spawn, or `'auto'` (hardware concurrency).  Default: `'auto'` heuristic. */
  withWorkers(workers: number | 'auto'): this {
    return this.set('workers', workers);
  }

  /** ActorSystem name each worker hosts.  Default: `'worker-cluster'`. */
  withSystemName(systemName: string): this {
    return this.set('systemName', systemName);
  }

  /** Hostname component of each worker's {@link NodeAddress}.  Default: `'worker'`. */
  withHostname(hostname: string): this {
    return this.set('hostname', hostname);
  }

  /** Port assigned to the first worker; subsequent workers increment.  Default: 1. */
  withBasePort(basePort: number): this {
    return this.set('basePort', basePort);
  }

  /** Arbitrary payload delivered to each worker in its init message.  Default: `null`. */
  withInitData(initData: unknown): this {
    return this.set('initData', initData);
  }

  /** Restart policy for crashed / exited workers.  Default: `'on-failure'`. */
  withRestartPolicy(restartPolicy: RestartPolicy): this {
    return this.set('restartPolicy', restartPolicy);
  }

  /** How long to wait for a worker's ready handshake before failing.  Default: 10000ms. */
  withReadyTimeoutMs(readyTimeoutMs: number): this {
    return this.set('readyTimeoutMs', readyTimeoutMs);
  }

  /**
   * Spawn workers through this backend instead of the one
   * `getWorkerBackend()` picks for the current runtime.  Two uses: a
   * runtime the auto-detection does not know, and an in-memory fake in
   * a test.  Without it there is no way past `getWorkerBackend()`, which
   * is what pushed the tests into mocking the module globally — and a
   * module mock in Bun outlives the file that installs it (#520).
   * Default: the detected backend.
   */
  withBackend(backend: WorkerBackend): this {
    return this.set('backend', backend);
  }
}

/** Validates resolved {@link WorkerClusterOptionsType} settings. */
export class WorkerClusterOptionsValidator extends OptionsValidator<WorkerClusterOptionsType> {
  constructor() {
    super('WorkerClusterOptions');
  }
  protected rules(s: Partial<WorkerClusterOptionsType>): void {
    // workers is `number | 'auto'`, so the field-name helpers can't address it.
    if (s.workers !== undefined && s.workers !== 'auto' && (!Number.isInteger(s.workers) || s.workers < 1)) {
      this.fail('workers', "must be a positive integer or 'auto'", s.workers);
    }
    this.port('basePort');
    this.positiveNumber('readyTimeoutMs');
    // Worth checking now that a config file can supply it: an unknown policy
    // used to fall through the `match` in WorkerCluster and silently mean
    // "never restart".
    this.oneOf('restartPolicy', ['always', 'on-failure', 'never']);
  }
}

/**
 * The slice of worker-cluster settings HOCON can supply.  Everything else
 * is either per-call identity (`bootstrap`, `initData`) or an object a
 * config file cannot express (`backend`).
 */
export type WorkerClusterConfigDefaults = Pick<
  WorkerClusterOptionsType,
  'workers' | 'restartPolicy'
>;

/**
 * Read `actor-ts.worker-cluster.*`.  Unlike the rest of the framework's
 * config readers this one loads the config itself: {@link WorkerCluster.spawn}
 * is a static with no `ActorSystem` in scope — the workers each build their
 * own system *after* spawning — so there is no `system.config` to read.
 * {@link Config.load} is the same chain `ActorSystem.create` uses, honouring
 * `ACTOR_TS_CONFIG` and `./application.conf`.
 */
export function readWorkerClusterOptionsFromConfig(
  config: Config = Config.load(),
): WorkerClusterConfigDefaults {
  const keys = ConfigKeys.workerCluster;
  const out: { -readonly [K in keyof WorkerClusterConfigDefaults]: WorkerClusterConfigDefaults[K] } = {};
  if (config.hasPath(keys.workers)) {
    // `"auto"` and a plain count share one leaf, so the raw value decides
    // which reader applies rather than the key.
    const raw = config.getString(keys.workers);
    out.workers = raw === 'auto' ? 'auto' : config.getInt(keys.workers);
  }
  if (config.hasPath(keys.restartPolicy)) {
    out.restartPolicy = config.getString(keys.restartPolicy) as RestartPolicy;
  }
  return out;
}

/**
 * Layer the config block under the caller's options — **explicit options >
 * HOCON > built-in defaults**, as everywhere else.  The result is what
 * {@link WorkerClusterOptionsValidator} sees, so a bad `restart-policy` in a
 * config file is rejected exactly like a bad one in code.
 */
export function withWorkerClusterConfigDefaults(
  options: WorkerClusterOptionsType,
  config?: Config,
): WorkerClusterOptionsType {
  return mergeOptions<WorkerClusterOptionsType>(
    {},
    readWorkerClusterOptionsFromConfig(config),
    options,
  );
}

/**
 * Accepted input for {@link WorkerCluster.spawn}: the fluent
 * {@link WorkerClusterOptionsBuilder} OR a plain
 * {@link WorkerClusterOptionsType} object.
 */
export type WorkerClusterOptions = WorkerClusterOptionsBuilder | Partial<WorkerClusterOptionsType>;
/** Value alias so `WorkerClusterOptions.create()` / `new WorkerClusterOptions()` resolve to the builder. */
export const WorkerClusterOptions = WorkerClusterOptionsBuilder;
