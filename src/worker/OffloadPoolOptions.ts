import { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { WorkerBackend } from '../runtime/worker/index.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import {
  BOOTSTRAP_ALLOWED_HOST,
  BOOTSTRAP_ALLOWED_PROTOCOL,
  DEFAULT_MAX_RESTARTS,
  DEFAULT_RESTART_WINDOW_MS,
  parseBootstrapUrl,
} from './WorkerClusterOptions.js';

/**
 * `'auto'` is the machine's available parallelism **minus one**, for the
 * reason the worker mesh applies: the main thread keeps running the actors
 * that offload, so a pool that also takes its core measures contention.
 * Floored at one worker.
 */
export const DEFAULT_OFFLOAD_POOL_SIZE: number | 'auto' = 'auto';
/** Workers kept alive through idleness.  `0` lets a quiet pool wind down to nothing. */
export const DEFAULT_OFFLOAD_MIN_SIZE = 0;
/** Tasks waiting for a worker before `overflow` decides what happens to the next one. */
export const DEFAULT_OFFLOAD_MAX_QUEUE = 10_000;
/**
 * `'reject'` fails the run at once with `OffloadQueueFullError`; `'wait'`
 * keeps the promise pending until a queue slot frees — back-pressure the
 * caller feels as latency rather than as an error.  Reject by default, the
 * mailbox's own choice for a bound: a caller that sees the error can shed or
 * retry, one that waits cannot tell waiting from a hang.
 */
export const DEFAULT_OFFLOAD_OVERFLOW: OffloadOverflow = 'reject';
/** How long a worker beyond `minSize` stays alive with nothing to do. */
export const DEFAULT_OFFLOAD_IDLE_TIMEOUT_MS = 60_000;
/** `0` — no deadline unless a run names one; a deadline terminates the worker. */
export const DEFAULT_OFFLOAD_TASK_TIMEOUT_MS = 0;
/** Spawn every worker at `start` rather than on the first task that needs it. */
export const DEFAULT_OFFLOAD_WARM_UP = false;

export type OffloadOverflow = 'reject' | 'wait';

/** Plain options-object shape layered over `actor-ts.offload-pool.*`. */
export type OffloadPoolOptionsType = {
  readonly size?: number | 'auto';
  readonly minSize?: number;
  readonly maxQueue?: number;
  readonly overflow?: OffloadOverflow;
  readonly idleTimeoutMs?: number;
  readonly taskTimeoutMs?: number;
  /** Worker terminations — crash or deadline — the pool replaces inside `restartWindowMs` before it stops replacing. */
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  readonly warmUp?: boolean;
  /** The worker entry to spawn instead of the shipped one — the escape hatch for a bundler. */
  readonly bootstrap?: URL | string;
  /** Test seam: the thread implementation behind the pool. */
  readonly backend?: WorkerBackend;
};

export class OffloadPoolOptionsBuilder extends OptionsBuilder<OffloadPoolOptionsType> {
  static create(): OffloadPoolOptionsBuilder {
    return new OffloadPoolOptionsBuilder();
  }

  withSize(size: number | 'auto'): this { return this.set('size', size); }
  withMinSize(minSize: number): this { return this.set('minSize', minSize); }
  withMaxQueue(maxQueue: number): this { return this.set('maxQueue', maxQueue); }
  withOverflow(overflow: OffloadOverflow): this { return this.set('overflow', overflow); }
  withIdleTimeoutMs(idleTimeoutMs: number): this { return this.set('idleTimeoutMs', idleTimeoutMs); }
  withTaskTimeoutMs(taskTimeoutMs: number): this { return this.set('taskTimeoutMs', taskTimeoutMs); }
  withMaxRestarts(maxRestarts: number): this { return this.set('maxRestarts', maxRestarts); }
  withRestartWindowMs(restartWindowMs: number): this { return this.set('restartWindowMs', restartWindowMs); }
  withWarmUp(warmUp = true): this { return this.set('warmUp', warmUp); }
  withBootstrap(bootstrap: URL | string): this { return this.set('bootstrap', bootstrap); }
  withBackend(backend: WorkerBackend): this { return this.set('backend', backend); }
}

export class OffloadPoolOptionsValidator extends OptionsValidator<OffloadPoolOptionsType> {
  constructor() {
    super('OffloadPoolOptions');
  }

  protected rules(s: Partial<OffloadPoolOptionsType>): void {
    if (s.size !== undefined && s.size !== 'auto' && (!Number.isInteger(s.size) || s.size < 1)) {
      this.fail('size', "must be a positive integer or 'auto'", s.size);
    }
    this.nonNegativeInt('minSize');
    if (s.minSize !== undefined && typeof s.size === 'number' && s.minSize > s.size) {
      this.fail('minSize', `must not exceed size (${s.size})`, s.minSize);
    }
    this.nonNegativeInt('maxQueue');
    this.oneOf('overflow', ['reject', 'wait']);
    this.nonNegativeNumber('idleTimeoutMs');
    this.nonNegativeNumber('taskTimeoutMs');
    if (s.maxRestarts !== undefined && (!Number.isInteger(s.maxRestarts) || s.maxRestarts < -1)) {
      this.fail('maxRestarts', 'must be an integer >= -1 (-1 = unlimited)', s.maxRestarts);
    }
    this.nonNegativeNumber('restartWindowMs');
    if (s.bootstrap !== undefined) this.bootstrapUrl(s.bootstrap);
  }

  private bootstrapUrl(value: URL | string): void {
    const url = parseBootstrapUrl(value);
    if (url === undefined) {
      this.fail('bootstrap', "must be an absolute URL — resolve it against the caller with new URL('./x.js', import.meta.url)", value);
    }
    if (url.protocol !== BOOTSTRAP_ALLOWED_PROTOCOL) {
      this.fail('bootstrap', `must use the ${BOOTSTRAP_ALLOWED_PROTOCOL} scheme`, url.href);
    }
    if (url.host !== BOOTSTRAP_ALLOWED_HOST) {
      this.fail('bootstrap', 'must be a host-less file: URL', url.href);
    }
  }
}

/** The subset a config file can carry — no bootstrap, no backend. */
export type OffloadPoolConfigDefaults = Omit<OffloadPoolOptionsType, 'bootstrap' | 'backend'>;

export function readOffloadPoolOptionsFromConfig(config: Config = Config.load()): OffloadPoolConfigDefaults {
  const keys = ConfigKeys.offloadPool;
  const out: { -readonly [K in keyof OffloadPoolConfigDefaults]: OffloadPoolConfigDefaults[K] } = {};
  if (config.hasPath(keys.size)) {
    const raw = config.getString(keys.size);
    out.size = raw === 'auto' ? 'auto' : config.getInt(keys.size);
  }
  if (config.hasPath(keys.minSize)) out.minSize = config.getInt(keys.minSize);
  if (config.hasPath(keys.maxQueue)) out.maxQueue = config.getInt(keys.maxQueue);
  if (config.hasPath(keys.overflow)) out.overflow = config.getString(keys.overflow) as OffloadOverflow;
  if (config.hasPath(keys.idleTimeout)) out.idleTimeoutMs = config.getDuration(keys.idleTimeout);
  if (config.hasPath(keys.taskTimeout)) out.taskTimeoutMs = config.getDuration(keys.taskTimeout);
  if (config.hasPath(keys.maxRestarts)) out.maxRestarts = config.getInt(keys.maxRestarts);
  if (config.hasPath(keys.restartWindow)) out.restartWindowMs = config.getDuration(keys.restartWindow);
  if (config.hasPath(keys.warmUp)) out.warmUp = config.getBoolean(keys.warmUp);
  return out;
}

/** Layer explicit options over the HOCON block: explicit > HOCON > built-in defaults. */
export function withOffloadPoolConfigDefaults(
  options: OffloadPoolOptions | undefined,
  config: Config,
): OffloadPoolOptionsType {
  return mergeOptions<OffloadPoolOptionsType>(
    {},
    readOffloadPoolOptionsFromConfig(config),
    (options as OffloadPoolOptionsType | undefined) ?? {},
  );
}

/** The restart defaults a pool shares with the worker cluster, re-exported so a reader of this file sees the whole set. */
export { DEFAULT_MAX_RESTARTS, DEFAULT_RESTART_WINDOW_MS };

/**
 * Accepted input for {@link OffloadPool.start}: the fluent
 * {@link OffloadPoolOptionsBuilder} OR a plain {@link OffloadPoolOptionsType}.
 */
export type OffloadPoolOptions = OffloadPoolOptionsBuilder | OffloadPoolOptionsType;
export const OffloadPoolOptions = OffloadPoolOptionsBuilder;
