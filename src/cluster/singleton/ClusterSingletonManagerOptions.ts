import type { Lease } from '../../coordination/Lease.js';
import type { ActorClassOrFactory } from '../../Actor.js';
import type { ActorOptions } from '../../ActorOptions.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { Cluster } from '../Cluster.js';

/** Plain options-object shape consumed by a {@link ClusterSingletonManager}. */
export type ClusterSingletonManagerOptionsType<T> = {
  readonly cluster: Cluster;
  /** Logical name for this singleton; also used as the child-actor name. */
  readonly typeName: string;
  /** How to construct the singleton actor.  Only instantiated on the leader. */
  readonly singletonActor: ActorClassOrFactory<T>;
  readonly singletonActorOptions?: ActorOptions<T>;
  /** Optional role — only nodes with this role will host the singleton. */
  readonly role?: string;
  /** Optional split-brain protection — see {@link StartSingletonOptionsType.lease}. */
  readonly lease?: Lease;
  /** Retry interval for `lease.acquire()` after a failed attempt.  Default: 5 s. */
  readonly acquireRetryIntervalMs?: number;
  /**
   * How long to wait for every eligible peer to confirm it is not hosting
   * before spawning anyway — see
   * {@link StartSingletonOptionsType.handOverTimeoutMs}.  Default: 10 s.
   */
  readonly handOverTimeoutMs?: number;
  /**
   * Whether the manager re-spawns the singleton after its child dies
   * *unexpectedly* — `context.stopSelf()`, or a supervision budget exhausted
   * — as opposed to the planned teardown of a handover.  Default: `true`.
   *
   * `true` is the availability-preserving answer, and the reason it is the
   * default: without it the singleton is gone cluster-wide until the next
   * leader change, which in a stable cluster may be never (#1175).
   *
   * Set it to `false` when the actor uses `stopSelf()` as a terminal state
   * and "done" genuinely means done.  The manager then releases its lease
   * instead, so another node *could* host — rather than holding a lease over
   * a dead child, which is the one shape that makes the outage unrecoverable
   * without a restart.
   */
  readonly restartOnTermination?: boolean;
};

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

  /** The singleton actor.  Only instantiated on the leader. */
  withSingletonActor(singletonActor: ActorClassOrFactory<T>): this {
    return this.set('singletonActor', singletonActor);
  }

  /** Spawn options for the singleton instance. */
  withSingletonActorOptions(singletonActorOptions: ActorOptions<T>): this {
    return this.set('singletonActorOptions', singletonActorOptions);
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

  /** How long to wait for eligible peers to stand down before spawning.  Default 10 s. */
  withHandOverTimeoutMs(ms: number): this {
    return this.set('handOverTimeoutMs', ms);
  }

  /** Re-spawn the singleton after an unexpected child death?  Default `true`. */
  withRestartOnTermination(restartOnTermination: boolean): this {
    return this.set('restartOnTermination', restartOnTermination);
  }
}

/**
 * Validates resolved {@link ClusterSingletonManagerOptionsType} settings.
 *
 * Lower-stakes than most validators in the repo, because the extension is
 * normally the only thing that builds these and it validates
 * `StartSingletonOptions` first — so this is reachable only by a caller
 * constructing the manager directly.  Worth closing anyway: that caller gets
 * the same up-front `OptionsError` as everyone else instead of a
 * `Cannot read properties of undefined` from inside `preStart`.
 */
export class ClusterSingletonManagerOptionsValidator<T>
  extends OptionsValidator<ClusterSingletonManagerOptionsType<T>> {
  constructor() {
    super('ClusterSingletonManagerOptions');
  }

  protected rules(s: Partial<ClusterSingletonManagerOptionsType<T>>): void {
    // The check helpers are no-ops on `undefined` by design, so required-ness
    // is asserted separately — as in `StartSingletonOptionsValidator`.
    if (s.cluster === undefined) this.fail('cluster', 'is required');
    if (s.typeName === undefined) this.fail('typeName', 'is required');
    if (s.singletonActor === undefined) this.fail('singletonActor', 'is required');
    this.nonEmptyString('typeName');
    this.nonEmptyString('role');
    this.positiveNumber('acquireRetryIntervalMs');
    this.positiveNumber('handOverTimeoutMs');
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
