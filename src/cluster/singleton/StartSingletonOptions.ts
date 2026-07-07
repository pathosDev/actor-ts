import type { Lease } from '../../coordination/Lease.js';
import type { Props } from '../../Props.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { StartSingletonSettings } from './ClusterSingleton.js';

/**
 * Fluent builder for {@link StartSingletonSettings}:
 *
 *     system.extension(ClusterSingletonId).start(
 *       cluster,
 *       StartSingletonOptions.create<Cmd>()
 *         .withTypeName('counter')
 *         .withProps(Props.create(() => new CounterActor())),
 *     );
 */
export class StartSingletonOptions<T> extends OptionsBuilder<StartSingletonSettings<T>> {
  /** Start a fresh builder. */
  static create<T>(): StartSingletonOptions<T> {
    return new StartSingletonOptions<T>();
  }

  /** Logical name for this singleton — used in the manager/child actor path. */
  withTypeName(typeName: string): this {
    return this.set('typeName', typeName);
  }

  /** Props used to construct the singleton on the leader. */
  withProps(props: Props<T>): this {
    return this.set('props', props);
  }

  /** Only nodes carrying this role tag will host the singleton. */
  withRole(role: string): this {
    return this.set('role', role);
  }

  /** Split-brain protection — the leader acquires this lease before spawning. */
  withLease(lease: Lease): this {
    return this.set('lease', lease);
  }

  /** Retry interval (ms) for `lease.acquire()` after a failed attempt.  Default 5 s. */
  withAcquireRetryIntervalMs(ms: number): this {
    return this.set('acquireRetryIntervalMs', ms);
  }
}
