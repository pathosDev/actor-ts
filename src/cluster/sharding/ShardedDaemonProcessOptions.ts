import type { Props } from '../../Props.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/** Plain options-object shape consumed by {@link ShardedDaemonProcess.init}. */
export interface ShardedDaemonProcessOptionsType<T> {
  /** Logical name used for the shard type; must be unique per daemon set. */
  readonly name: string;
  /** Total number of daemons to keep running cluster-wide. */
  readonly numDaemons: number;
  /** Props factory — gets the daemon's stable index (0..numDaemons-1). */
  readonly behaviorFor: (daemonIndex: number) => Props<T>;
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
}

/**
 * Fluent builder for {@link ShardedDaemonProcessOptionsType}.  The
 * `behaviorFor` factory is a whole-object field passed via a single
 * `withBehaviorFor(fn)`.
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

  /** Props factory — gets the daemon's stable index (0..numDaemons-1). */
  withBehaviorFor(behaviorFor: (daemonIndex: number) => Props<T>): this {
    return this.set('behaviorFor', behaviorFor);
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
