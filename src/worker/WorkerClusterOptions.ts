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
 * The only URL scheme {@link WorkerClusterOptionsType.bootstrap} may carry.
 *
 * The specifier is handed straight to `new Worker(url)`, so its scheme decides
 * where the worker's entry code comes from.  Measured once per runtime rather
 * than assumed (Bun 1.4.0, Node 26.7.0, Deno 2.6.8):
 *
 * | scheme     | Bun              | Node                     | Deno                      |
 * | ---------- | ---------------- | ------------------------ | ------------------------- |
 * | `file:`    | runs             | runs                     | runs                      |
 * | `data:`    | runs             | runs                     | runs                      |
 * | `blob:`    | runs             | `ERR_INVALID_URL_SCHEME` | runs                      |
 * | `http(s):` | `ModuleNotFound` | `ERR_INVALID_URL_SCHEME` | fetched and run           |
 *
 * So the sharp edges are not theoretical: a `data:` entry executes
 * caller-supplied bytes on all three runtimes, `blob:` on two, and a remote
 * specifier is code off the network on Deno (which needs `--allow-import`, an
 * unrelated flag an application may well already carry).  `file:` is the only
 * scheme that names an artifact the operator put on disk, and it is what every
 * doc and example already uses — `new URL('./worker.js', import.meta.url)`
 * produces exactly this.  Narrowing to it is a pre-1.0 hard cut (#776).
 *
 * The scheme is only half the allow-list, though — see
 * {@link BOOTSTRAP_ALLOWED_HOST}.
 */
const BOOTSTRAP_ALLOWED_PROTOCOL = 'file:';

/**
 * The only authority a `file:` {@link WorkerClusterOptionsType.bootstrap} may
 * carry: none.
 *
 * Checking the scheme alone left the hole the scheme check was introduced to
 * close.  A `file:` URL may carry a host, and a host turns it into a path on
 * *that machine*: measured on Windows 11 with Node 26.7.0,
 * `fileURLToPath('file://attacker.example.com/share/worker.js')` yields the UNC
 * path `\\attacker.example.com\share\worker.js`, and no runtime refuses the
 * specifier — Node's `Worker` fails with `MODULE_NOT_FOUND` on that UNC path,
 * Deno with `Module not found "file://attacker.example.com/share/worker.js"`,
 * Bun with an `Error in worker`.  All three *accepted* the URL; only the SMB
 * fetch failed.  On a host where the share resolves, the worker's entry module
 * is code off a remote server — the same class of hole as a `http:` specifier,
 * wearing the allowed scheme (#776).
 *
 * `localhost` is the one host WHATWG admits for `file:`, and it needs no
 * exemption: the parser erases it.  Measured identically on Bun 1.4.0, Node
 * 26.7.0 and Deno 2.6.8, `new URL('file://localhost/srv/app/worker.js')` — and
 * `LOCALHOST`, which is lower-cased first — normalises to
 * `file:///srv/app/worker.js` with an empty `host`, so it reaches this check
 * already indistinguishable from the plain form and stays accepted.  Admitting
 * it by construction is better than special-casing the string: a
 * `'localhost'` exemption would also have to decide about `127.0.0.1` and
 * `[::1]`, which the parser does *not* erase and which on Windows still name a
 * UNC share rather than a plain path.  Those are refused.
 */
const BOOTSTRAP_ALLOWED_HOST = '';

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

  /**
   * Module URL of the worker entrypoint each worker runs.  Required, and must
   * be an absolute `file:` URL **with no host** — `new URL('./worker.js',
   * import.meta.url)` is the intended form and produces exactly that.  A string
   * is accepted under the same two constraints.  See
   * {@link BOOTSTRAP_ALLOWED_PROTOCOL} for why the other schemes a `Worker`
   * constructor would take are refused, and {@link BOOTSTRAP_ALLOWED_HOST} for
   * why a host is: it makes the specifier a UNC path, so the entry module comes
   * off a remote server.
   */
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
    // Required-ness first, and by hand: every check helper is a no-op on
    // `undefined` by design, so `WorkerClusterOptions` being a
    // `Partial<WorkerClusterOptionsType>` let an empty options object through
    // the validator and into `new URL(undefined)`, which surfaced a raw
    // ERR_INVALID_URL from inside the runtime rather than a named OptionsError
    // naming the field (#776).
    if (s.bootstrap === undefined) {
      this.fail('bootstrap', 'is required — there is no worker entrypoint to spawn without it');
    }
    // `url()` is typed for `string` fields and `bootstrap` is `URL | string`,
    // so the scheme check is hand-rolled too.
    const bootstrapUrl = parseBootstrapUrl(s.bootstrap);
    if (bootstrapUrl === undefined) {
      this.fail(
        'bootstrap',
        'must be an absolute URL — resolve a relative specifier against the entry first, '
        + "as in new URL('./worker.js', import.meta.url)",
        s.bootstrap,
      );
    }
    if (bootstrapUrl.protocol !== BOOTSTRAP_ALLOWED_PROTOCOL) {
      this.fail(
        'bootstrap',
        `must use the ${BOOTSTRAP_ALLOWED_PROTOCOL} scheme — a data:, blob: or remote `
        + 'specifier hands the worker constructor code from outside the deployment',
        bootstrapUrl.href,
      );
    }
    // The scheme is not the whole allow-list: a host on a file: URL is a UNC
    // share, so the entry module comes off that server.  See
    // BOOTSTRAP_ALLOWED_HOST for what each runtime measurably does with one.
    if (bootstrapUrl.host !== BOOTSTRAP_ALLOWED_HOST) {
      this.fail(
        'bootstrap',
        'must be a host-less file: URL — a host makes it a UNC path '
        + `(\\\\${bootstrapUrl.host}\\…), so the worker's entry module is fetched off that `
        + 'server; file:///path is the intended form, and file://localhost/path '
        + 'normalises to it',
        bootstrapUrl.href,
      );
    }
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
 * Parse a `bootstrap` specifier into a `URL`, or `undefined` when it is not
 * one.  A bare relative string is the `undefined` case and always was: with no
 * base to resolve against, `new URL('./worker.js')` throws — it just used to
 * throw from inside {@link WorkerCluster.spawn} instead of from the validator.
 */
function parseBootstrapUrl(bootstrap: URL | string | undefined): URL | undefined {
  if (bootstrap instanceof URL) return bootstrap;
  if (typeof bootstrap !== 'string') return undefined;
  try {
    return new URL(bootstrap);
  } catch {
    return undefined;
  }
}

/**
 * The slice of worker-cluster settings HOCON can supply — every field but the
 * four a config file has no way to carry, or must not: `initData` is per-call
 * identity, `backend` / `onWorkerPermanentlyDown` are live objects rather than
 * values, and `bootstrap` is held back deliberately (below) (#883).
 *
 * The four duration leaves drop the `Ms` suffix their fields carry and take a
 * HOCON duration literal instead — `actor-ts.logger.close-timeout` reads into
 * `closeTimeoutMs` and `…delivery.flush-interval` into `flushIntervalMs`, so
 * this is the house spelling rather than an exception to the `withX` ⇔ `x` ⇔
 * leaf lockstep.  A `…-ms` leaf would be the first in `reference.conf`, and
 * would make `10s` unwritable where every other duration accepts it.
 *
 * **`bootstrap` stays out of HOCON on purpose** — it is absent from
 * `ConfigKeys` and from `reference.conf`, and #883 publishing the other nine
 * did not change that.  It names a module the runtime will *execute*, and a
 * config file is a wider surface than the call site: `ACTOR_TS_CONFIG` and a
 * dropped-in `application.conf` both feed {@link Config.load}, so a leaf here
 * would let something other than the application's own source decide which
 * code a worker runs.  {@link WorkerClusterOptionsValidator} constrains the
 * scheme precisely because that decision has teeth (#776).
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
