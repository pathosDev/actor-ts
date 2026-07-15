import type { Lease } from '../../coordination/Lease.js';
import type { Props } from '../../Props.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Cluster } from '../Cluster.js';

/** Plain options-object shape consumed by a {@link ClusterSingletonManager}. */
export interface ClusterSingletonManagerOptionsType<T> {
  readonly cluster: Cluster;
  /** Logical name for this singleton; also used as the child-actor name. */
  readonly typeName: string;
  /** How to construct the singleton actor.  Only instantiated on the leader. */
  readonly singletonProps: Props<T>;
  /** Optional role — only nodes with this role will host the singleton. */
  readonly role?: string;
  /** Optional split-brain protection — see {@link StartSingletonOptionsType.lease}. */
  readonly lease?: Lease;
  /** Retry interval for `lease.acquire()` after a failed attempt.  Default: 5 s. */
  readonly acquireRetryIntervalMs?: number;
}

/**
 * Fluent builder for {@link ClusterSingletonManagerOptionsType}.  The
 * manager is constructed directly by the {@link ClusterSingleton}
 * extension, so callers rarely build this by hand — but the builder
 * keeps the construction API uniform with the rest of the cluster layer.
 */
export class ClusterSingletonManagerOptionsBuilder<T> extends OptionsBuilder<ClusterSingletonManagerOptionsType<T>> {
  /** Start a fresh builder. */
  static create<T>(): ClusterSingletonManagerOptionsBuilder<T> {
    return new ClusterSingletonManagerOptionsBuilder<T>();
  }

  /** The cluster this manager lives in — drives membership + leadership. */
  withCluster(cluster: Cluster): this {
    return this.set('cluster', cluster);
  }

  /** Logical name for this singleton; also used as the child-actor name. */
  withTypeName(typeName: string): this {
    return this.set('typeName', typeName);
  }

  /** How to construct the singleton actor.  Only instantiated on the leader. */
  withSingletonProps(props: Props<T>): this {
    return this.set('singletonProps', props);
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

/**
 * Accepted input for a {@link ClusterSingletonManager}: the fluent
 * {@link ClusterSingletonManagerOptionsBuilder} OR a plain (partial)
 * {@link ClusterSingletonManagerOptionsType} object.
 */
export type ClusterSingletonManagerOptions<T> =
  | ClusterSingletonManagerOptionsBuilder<T>
  | Partial<ClusterSingletonManagerOptionsType<T>>;
/** Value alias so `ClusterSingletonManagerOptions.create()` resolves to the builder. */
export const ClusterSingletonManagerOptions = ClusterSingletonManagerOptionsBuilder;
