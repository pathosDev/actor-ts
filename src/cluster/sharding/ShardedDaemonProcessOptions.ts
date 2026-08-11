import type { ActorClassOrFactory } from '../../Actor.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/** Plain options-object shape consumed by {@link ShardedDaemonProcess.init}. */
export type ShardedDaemonProcessOptionsType<T> = {
  /** Logical name used for the shard type; must be unique per daemon set. */
  readonly name: string;
  /** Total number of daemons to keep running cluster-wide. */
  readonly numDaemons: number;
  /** The daemon actor, chosen per index — gets the stable index (0..numDaemons-1). */
  readonly actorFor: (daemonIndex: number) => ActorClassOrFactory<T>;
  /** Optional role — only members carrying the role host daemons. */
  readonly role?: string;
  /**
   * Period (ms) at which a "liveness ping" wakes every daemon index even
   * when no cluster topology event has fired.  Acts as a safety net for
   * the event-driven path (`LeaderChanged` / `MemberRemoved`) — if a wake
   * was missed (e.g. brief partition right at the failover moment), the
   * heartbeat ensures the daemons still get re-materialized.
   *
   * Default: `30_000` (30 s).  Set to `0` to disable.
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
