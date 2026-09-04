import type { NodeAddress } from '../cluster/NodeAddress.js';
import { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { WorkerBackend } from '../runtime/worker/index.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { RestartPolicy } from './WorkerCluster.js';

/** `ActorSystem` name each worker hosts when nothing overrides it. */
export const DEFAULT_WORKER_SYSTEM_NAME = 'worker-cluster';
/** Hostname component of each worker's {@link NodeAddress}. */
export const DEFAULT_WORKER_HOSTNAME = 'worker';
/** Port of the first worker; each subsequent slot increments from here. */
export const DEFAULT_WORKER_BASE_PORT = 1;
/** How long a worker gets to complete its hello/init/ready handshake. */
export const DEFAULT_WORKER_READY_TIMEOUT_MS = 10_000;
/** Restart crashed workers, leave clean exits alone. */
export const DEFAULT_WORKER_RESTART_POLICY: RestartPolicy = 'on-failure';

/** First respawn delay; doubles per attempt up to {@link DEFAULT_RESTART_MAX_BACKOFF_MS}. */
export const DEFAULT_RESTART_MIN_BACKOFF_MS = 200;
/** Ceiling for the respawn delay. */
export const DEFAULT_RESTART_MAX_BACKOFF_MS = 10_000;
/** ± jitter fraction on each respawn delay, so sibling slots do not synchronise. */
export const DEFAULT_RESTART_RANDOM_FACTOR = 0.2;
/**
 * Restarts granted per slot inside {@link DEFAULT_RESTART_WINDOW_MS} before it
 * is retired.  Mirrors `defaultStrategy`'s ten-per-minute allowance in
 * `src/Supervision.ts` — a worker slot and a supervised child fail the same
 * way, so there is no reason for the two budgets to disagree.
 */
export const DEFAULT_MAX_RESTARTS = 10;
/** Sliding window the restart budget counts over. */
export const DEFAULT_RESTART_WINDOW_MS = 60_000;

/**
 * What a retired slot reports through
 * {@link WorkerClusterOptionsType.onWorkerPermanentlyDown}.
 *
 * `src/worker/` has no logger of any kind, so before this existed a crash loop
 * was completely silent from the framework's side and its end was invisible
 * (#734).  This callback is the only diagnostic the mesh can offer.
 */
export type WorkerPermanentlyDownInfo = {
  /** Slot index — stable across restarts, and what fixes the worker's port. */
  readonly index: number;
  /** Address the slot occupied; no worker answers on it any more. */
  readonly address: NodeAddress;
  /** Restarts that were granted before the budget refused one. */
  readonly restarts: number;
  /** The failure that spent the last of the budget, where the runtime gave one. */
  readonly error?: unknown;
};

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
  readonly restartMinBackoffMs?: number;
  readonly restartMaxBackoffMs?: number;
  readonly restartRandomFactor?: number;
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  readonly onWorkerPermanentlyDown?: (info: WorkerPermanentlyDownInfo) => void;
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

  /** Delay before the first respawn of a crashed slot.  Default: 200ms. */
  withRestartMinBackoffMs(restartMinBackoffMs: number): this {
    return this.set('restartMinBackoffMs', restartMinBackoffMs);
  }

  /** Ceiling for the respawn delay, which doubles per attempt.  Default: 10000ms. */
  withRestartMaxBackoffMs(restartMaxBackoffMs: number): this {
    return this.set('restartMaxBackoffMs', restartMaxBackoffMs);
  }

  /** ± jitter fraction applied to each respawn delay, in `[0, 1]`.  Default: 0.2. */
  withRestartRandomFactor(restartRandomFactor: number): this {
    return this.set('restartRandomFactor', restartRandomFactor);
  }

  /**
   * Restarts granted per slot within {@link withRestartWindowMs} before the
   * slot is retired for good.  `-1` restores the pre-budget behaviour of
   * restarting forever.  Default: 10.
   */
  withMaxRestarts(maxRestarts: number): this {
    return this.set('maxRestarts', maxRestarts);
  }

  /**
   * Sliding window the restart budget counts over; `0` means the counts are
   * never reset, so a slot gets {@link withMaxRestarts} restarts for the whole
   * process lifetime.  Default: 60000ms.
   */
  withRestartWindowMs(restartWindowMs: number): this {
    return this.set('restartWindowMs', restartWindowMs);
  }

  /**
   * Called once per slot when its restart budget is spent and no further
   * worker will be started for it.  Not expressible in a config file, for the
   * same reason as `backend`.  Default: a `console.error` line.
   */
  withOnWorkerPermanentlyDown(
    onWorkerPermanentlyDown: (info: WorkerPermanentlyDownInfo) => void,
  ): this {
    return this.set('onWorkerPermanentlyDown', onWorkerPermanentlyDown);
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
    // Only code could set these until they got config leaves (#883); an empty
    // string from a config file would otherwise reach `NodeAddress` and give
    // every worker an address with no host or no system name.
    this.nonEmptyString('systemName');
    this.nonEmptyString('hostname');
    this.port('basePort');
    this.positiveNumber('readyTimeoutMs');
    // Worth checking now that a config file can supply it: an unknown policy
    // used to fall through the `match` in WorkerCluster and silently mean
    // "never restart".
    this.oneOf('restartPolicy', ['always', 'on-failure', 'never']);
    // A zero floor is legitimate — it means "respawn on the next turn" — so
    // these are non-negative rather than positive.
    this.nonNegativeNumber('restartMinBackoffMs');
    this.nonNegativeNumber('restartMaxBackoffMs');
    this.numberInRange('restartRandomFactor', 0, 1);
    this.nonNegativeNumber('restartWindowMs');
    // `-1` is the documented "restart forever" escape hatch, which is what
    // `RestartBudget` reads a negative allowance as; anything below that is a
    // typo, and a fraction would silently never be reached.
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
}

/**
 * The slice of worker-cluster settings HOCON can supply — every field but the
 * four a config file has no way to carry: `bootstrap` and `initData` are
 * per-call identity, and `backend` / `onWorkerPermanentlyDown` are live
 * objects rather than values (#883).
 *
 * The four duration leaves drop the `Ms` suffix their fields carry and take a
 * HOCON duration literal instead — `actor-ts.logger.close-timeout` reads into
 * `closeTimeoutMs` and `…delivery.flush-interval` into `flushIntervalMs`, so
 * this is the house spelling rather than an exception to the `withX` ⇔ `x` ⇔
 * leaf lockstep.  A `…-ms` leaf would be the first in `reference.conf`, and
 * would make `10s` unwritable where every other duration accepts it.
 */
export type WorkerClusterConfigDefaults = Pick<
  WorkerClusterOptionsType,
  'workers' | 'systemName' | 'hostname' | 'basePort' | 'readyTimeoutMs'
  | 'restartPolicy' | 'restartMinBackoffMs' | 'restartMaxBackoffMs'
  | 'restartRandomFactor' | 'maxRestarts' | 'restartWindowMs'
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
  if (config.hasPath(keys.systemName)) {
    out.systemName = config.getString(keys.systemName);
  }
  if (config.hasPath(keys.hostname)) {
    out.hostname = config.getString(keys.hostname);
  }
  if (config.hasPath(keys.basePort)) {
    out.basePort = config.getInt(keys.basePort);
  }
  if (config.hasPath(keys.readyTimeout)) {
    out.readyTimeoutMs = config.getDuration(keys.readyTimeout);
  }
  if (config.hasPath(keys.restartPolicy)) {
    out.restartPolicy = config.getString(keys.restartPolicy) as RestartPolicy;
  }
  if (config.hasPath(keys.restartMinBackoff)) {
    out.restartMinBackoffMs = config.getDuration(keys.restartMinBackoff);
  }
  if (config.hasPath(keys.restartMaxBackoff)) {
    out.restartMaxBackoffMs = config.getDuration(keys.restartMaxBackoff);
  }
  if (config.hasPath(keys.restartRandomFactor)) {
    // `getNumber`, not `getInt`: the jitter fraction is the one leaf in the
    // block that is legitimately fractional, and `getInt` throws on `0.2`.
    out.restartRandomFactor = config.getNumber(keys.restartRandomFactor);
  }
  if (config.hasPath(keys.maxRestarts)) {
    // `-1` is the documented "restart forever" value and a legal integer, so
    // `getInt` is the right accessor even though the field is not a count.
    out.maxRestarts = config.getInt(keys.maxRestarts);
  }
  if (config.hasPath(keys.restartWindow)) {
    out.restartWindowMs = config.getDuration(keys.restartWindow);
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
