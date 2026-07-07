import type { Props } from '../../Props.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { ShardedDaemonProcessSettings } from './ShardedDaemonProcess.js';

/**
 * Fluent builder for {@link ShardedDaemonProcessSettings}.  The
 * `behaviorFor` factory is a whole-object field passed via a single
 * `withBehaviorFor(fn)`.
 */
export class ShardedDaemonProcessOptions<T> extends OptionsBuilder<ShardedDaemonProcessSettings<T>> {
  /** Start a fresh builder.  Equivalent to `new ShardedDaemonProcessOptions<T>()`. */
  static create<T>(): ShardedDaemonProcessOptions<T> {
    return new ShardedDaemonProcessOptions<T>();
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
