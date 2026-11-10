import type { ActorClassOrFactory } from '../../Actor.js';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/**
 * Built-in default for {@link ShardedDaemonProcessOptionsType.livenessIntervalMs}
 * — the period of the safety-net ping that re-wakes every daemon index.  `0`
 * disables it.  Mirrors `actor-ts.sharded-daemon-process.liveness-interval`
 * in `reference.conf` (#854).
 *
 * Named rather than left as the literal it used to be at the read site,
 * because `DocumentedDefaults` can only pin a shipped HOCON value against a
 * constant — a rename now breaks a compile instead of quietly letting the
 * file and the fallback drift apart.
 */
export const DEFAULT_DAEMON_LIVENESS_INTERVAL_MS = 30_000;

/** Plain options-object shape consumed by {@link ShardedDaemonProcess.init}. */
export type ShardedDaemonProcessOptionsType<T> = {
  /** Logical name used for the shard type; must be unique per daemon set. */
  readonly name: string;
  /** Total number of daemons to keep running cluster-wide. */
  readonly numDaemons: number;
  /** The daemon actor, chosen per index — gets the stable index (0..numDaemons-1). */
  readonly actorFor: (daemonIndex: number) => ActorClassOrFactory<T>;
  /**
   * Optional role — only members carrying the role host daemons.
   *
   * Left unset the daemon region inherits `actor-ts.sharding.role`, because
   * nothing explicit is passed down and `ClusterSharding.start` merges that
   * block under whatever it is handed.  Set it — in code or via
   * `actor-ts.sharded-daemon-process.role` — to place *only* the daemons and
   * leave every other sharded type to the global key (#854).
   */
  readonly role?: string;
  /**
   * Period (ms) at which a "liveness ping" wakes every daemon index even
   * when no cluster topology event has fired.  Acts as a safety net for
   * the event-driven path (`LeaderChanged` / `MemberRemoved`) — if a wake
   * was missed (e.g. brief partition right at the failover moment), the
   * heartbeat ensures the daemons still get re-materialized.
   *
   * Default: {@link DEFAULT_DAEMON_LIVENESS_INTERVAL_MS} (30 s), also
   * settable as `actor-ts.sharded-daemon-process.liveness-interval`.  Set to
   * `0` to disable.
   */
  readonly livenessIntervalMs?: number;
};

/**
 * Fluent builder for {@link ShardedDaemonProcessOptionsType}.  The
 * `actorFor` factory is a whole-object field passed via a single
 * `withActorFor(actorFor)`.
 */
export class ShardedDaemonProcessOptionsBuilder<T> extends OptionsBuilder<ShardedDaemonProcessOptionsType<T>> {
  /** Start a fresh builder.  Equivalent to `new ShardedDaemonProcessOptionsBuilder<T>()`. */
  static create<T>(): ShardedDaemonProcessOptionsBuilder<T> {
    return new ShardedDaemonProcessOptionsBuilder<T>();
  }

  /** Logical name used for the shard type; must be unique per daemon set. */
  withName(name: string): this {
    return this.set('name', name);
  }

  /** Total number of daemons to keep running cluster-wide. */
  withNumDaemons(numDaemons: number): this {
    return this.set('numDaemons', numDaemons);
  }

  /** The daemon actor, chosen per index — gets the stable index (0..numDaemons-1). */
  withActorFor(actorFor: (daemonIndex: number) => ActorClassOrFactory<T>): this {
    return this.set('actorFor', actorFor);
  }

  /** Only members carrying this role host daemons. */
  withRole(role: string): this {
    return this.set('role', role);
  }

  /** Period (ms) for the liveness ping that re-materializes daemons.  Default: 30 s; `0` disables. */
  withLivenessIntervalMs(livenessIntervalMs: number): this {
    return this.set('livenessIntervalMs', livenessIntervalMs);
  }
}

/** Validates resolved {@link ShardedDaemonProcessOptionsType} settings. */
export class ShardedDaemonProcessOptionsValidator<T> extends OptionsValidator<ShardedDaemonProcessOptionsType<T>> {
  constructor() {
    super('ShardedDaemonProcessOptions');
  }
  protected rules(_s: Partial<ShardedDaemonProcessOptionsType<T>>): void {
    this.nonEmptyString('name');
    this.positiveInt('numDaemons');
    this.nonNegativeInt('livenessIntervalMs'); // 0 disables the liveness ping
  }
}

/**
 * Accepted input for {@link ShardedDaemonProcess.init}: the fluent
 * {@link ShardedDaemonProcessOptionsBuilder} OR a plain (partial)
 * {@link ShardedDaemonProcessOptionsType} object.
 */
export type ShardedDaemonProcessOptions<T> =
  | ShardedDaemonProcessOptionsBuilder<T>
  | Partial<ShardedDaemonProcessOptionsType<T>>;
/** Value alias so `ShardedDaemonProcessOptions.create()` / `new ShardedDaemonProcessOptions()` resolve to the builder. */
export const ShardedDaemonProcessOptions = ShardedDaemonProcessOptionsBuilder;

/**
 * The slice of daemon-process settings HOCON can supply.
 *
 * No message type parameter: both configurable fields are scalars, and the
 * file is read once per node without knowing which daemon type it will be
 * layered under.
 */
export type ShardedDaemonProcessConfigDefaults = Pick<
  ShardedDaemonProcessOptionsType<unknown>,
  'role' | 'livenessIntervalMs'
>;

/**
 * Read the `actor-ts.sharded-daemon-process.*` block into the shape
 * {@link ShardedDaemonProcess.init} merges under the caller's options (#854).
 *
 * Only keys actually present come back, which is what the `hasPath` guards
 * buy: a key read unconditionally would return `undefined` and, once spread,
 * shadow the built-in default it was meant to fall through to.
 */
export function readShardedDaemonProcessOptionsFromConfig(
  config: Config,
): ShardedDaemonProcessConfigDefaults {
  const keys = ConfigKeys.shardedDaemonProcess;
  // Mutable while being filled; consumers see the readonly shape.
  const out: {
    -readonly [K in keyof ShardedDaemonProcessConfigDefaults]: ShardedDaemonProcessConfigDefaults[K]
  } = {};
  if (config.hasPath(keys.livenessInterval)) {
    out.livenessIntervalMs = config.getDuration(keys.livenessInterval);
  }
  if (config.hasPath(keys.role)) {
    // `""` is dropped rather than returned, and that is load-bearing twice
    // over.  `reference.conf` ships the placeholder, so `hasPath` is true on
    // every node forever; and `mergeOptions` falls through on `undefined`
    // only, never on `''`.  Returned, the empty string would therefore reach
    // `sharding.start` as an EXPLICIT role on every daemon set — shadowing
    // `actor-ts.sharding.role` for the daemon region alone, which is the one
    // region an operator setting a global role would least expect to be
    // exempt.  Dropped, an unset daemon role inherits the global one (#847).
    const role = config.getString(keys.role);
    if (role.length > 0) out.role = role;
  }
  return out;
}
