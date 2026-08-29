import type { Lease } from '../../coordination/Lease.js';
import type { ActorClassOrFactory } from '../../Actor.js';
import type { ActorOptions } from '../../ActorOptions.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/**
 * Built-in default for {@link StartSingletonOptionsType.bufferSize} — the cap
 * on messages a proxy holds while no host is known.  See that field for why
 * the wait it covers is unbounded in principle, which is what makes a cap
 * necessary rather than merely tidy.
 */
export const DEFAULT_BUFFER_SIZE = 1_000;

/** Plain options-object shape accepted by {@link ClusterSingleton.start}. */
export type StartSingletonOptionsType<T> = {
  /** Logical name for this singleton — used in the manager/child actor path. */
  readonly typeName: string;
  /** The singleton actor — its class, or a factory when it needs dependencies. */
  readonly actor: ActorClassOrFactory<T>;
  /** Spawn options for the singleton instance. */
  readonly actorOptions?: ActorOptions<T>;
  /** If set, only nodes carrying this role tag will host the singleton. */
  readonly role?: string;
  /**
   * Optional split-brain protection.  When provided, the elected
   * leader's manager calls `lease.acquire()` before spawning the
   * singleton — so a partition that produces two oldest views still
   * only ever spawns the singleton on the side that holds the lease.
   * The manager subscribes to `lease.onLost(reason)` and stops the
   * child if ownership is revoked mid-flight.
   *
   * Without a lease the manager keeps its current sync behaviour:
   * spawn the moment cluster gossip says we're leader, no external
   * arbitration.
   */
  readonly lease?: Lease;
  /**
   * How often to retry `lease.acquire()` after a failed attempt
   * (another holder owns it, transient backend error, etc.).
   * Default: `5_000` ms.  Ignored if no lease is provided.
   */
  readonly acquireRetryIntervalMs?: number;
  /**
   * How long this node waits for every other eligible node to confirm it is
   * not running the singleton, before hosting it anyway.  Default: `10_000` ms.
   *
   * The wait is what makes "at most one instance" a cluster property: without
   * it the incoming host spawns off its own gossip view while the incumbent is
   * still draining the instance it was told to stop, so a routine scale-up
   * runs two (#949).  A healthy hand-over costs one network round trip and
   * never reaches this number.
   *
   * Reaching it means some eligible peer did not answer — it is unreachable,
   * or it believes it is still the host and declined.  The manager then
   * **spawns anyway** and logs at `warn`: availability is chosen over an
   * invariant it could not prove.  Where the invariant must survive that,
   * configure a {@link StartSingletonOptionsType.lease} — a third party both
   * sides can reach is the only thing that can arbitrate when reaching the
   * incumbent is what failed.
   */
  readonly handOverTimeoutMs?: number;
  /**
   * Largest warm-hand-over snapshot this singleton will put on the wire, in
   * bytes.  Default: `1_048_576` (1 MiB).
   *
   * Only consulted when the singleton actor implements
   * {@link WarmHandOverActor} — warm hand-over is opted into on the actor, not
   * here, so this field turns nothing on.  What it does is bound what an
   * opted-in actor may ship: a snapshot above it is not sent, and the incoming
   * instance starts cold, which is what every singleton did before the feature
   * existed.
   *
   * Raising it is measured against the *transport's* frame cap rather than
   * against this number.  A snapshot is base64 inside a JSON frame, so it
   * costs about a third more on the wire, and a frame over the receiving
   * node's cap costs the whole inter-node connection rather than the message —
   * so an oversized snapshot is refused independently of this setting, however
   * high it is set.  See
   * `ClusterOptions.maxFrameBytes` for the other half of that arithmetic.
   */
  readonly maxHandOverStateBytes?: number;
  /**
   * Whether the singleton is re-spawned after its instance dies
   * *unexpectedly* — `context.stopSelf()`, or a supervision budget exhausted
   * — as opposed to the planned teardown of a handover.  Default: `true`.
   *
   * Leave it on unless the actor uses `stopSelf()` as a terminal state.  With
   * it off the manager releases its lease instead of re-spawning, so another
   * node could host; what it will not do is hold a lease over a dead child
   * (#1175).
   */
  readonly restartOnTermination?: boolean;
  /**
   * How many messages the proxy holds while the cluster has no host for this
   * singleton, before it starts dropping them to dead letters.  Default:
   * `1_000`.
   *
   * The wait is normally momentary — a leader is elected within a gossip round
   * — but it is not bounded by anything: seeds unreachable, or a partition in
   * which this node sees nobody, is a state that can last as long as the
   * outage while the application keeps sending.  A cap turns that from
   * unbounded memory growth into visible message loss.
   */
  readonly bufferSize?: number;
};

/**
 * Fluent builder for {@link StartSingletonOptionsType}:
 *
 *     system.extension(ClusterSingletonId).start(
 *       cluster,
 *       StartSingletonOptions.create<Command>()
 *         .withTypeName('counter')
 *         .withActor(CounterActor),
 *     );
 */
export class StartSingletonOptionsBuilder<T> extends OptionsBuilder<StartSingletonOptionsType<T>> {
  /** Start a fresh builder. */
  static create<T>(): StartSingletonOptionsBuilder<T> {
    return new StartSingletonOptionsBuilder<T>();
  }

  /** Logical name for this singleton — used in the manager/child actor path. */
  withTypeName(typeName: string): this {
    return this.set('typeName', typeName);
  }

  /** The actor the singleton is built from.  Only instantiated on the leader. */
  withActor(actor: ActorClassOrFactory<T>): this {
    return this.set('actor', actor);
  }

  /** Spawn options for the singleton instance. */
  withActorOptions(actorOptions: ActorOptions<T>): this {
    return this.set('actorOptions', actorOptions);
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

  /** How long to wait for eligible peers to stand down before hosting.  Default 10 s. */
  withHandOverTimeoutMs(ms: number): this {
    return this.set('handOverTimeoutMs', ms);
  }

  /** Cap on a warm-hand-over snapshot's size in bytes.  Default 1 MiB. */
  withMaxHandOverStateBytes(bytes: number): this {
    return this.set('maxHandOverStateBytes', bytes);
  }

  /** Re-spawn the singleton after an unexpected instance death?  Default `true`. */
  withRestartOnTermination(restartOnTermination: boolean): this {
    return this.set('restartOnTermination', restartOnTermination);
  }

  /** Messages the proxy buffers while no node hosts the singleton.  Default 1000. */
  withBufferSize(messages: number): this {
    return this.set('bufferSize', messages);
  }
}

/** Validates resolved {@link StartSingletonOptionsType} settings. */
export class StartSingletonOptionsValidator<T> extends OptionsValidator<StartSingletonOptionsType<T>> {
  constructor() {
    super('StartSingletonOptions');
  }
  protected rules(s: Partial<StartSingletonOptionsType<T>>): void {
    // The check helpers pass on `undefined` by design, so the two fields
    // without which `start()` cannot do anything are asserted here.  The
    // alternative is a `Cannot read properties of undefined` raised inside
    // the spawn, several frames from anything the caller wrote.
    if (s.typeName === undefined) this.fail('typeName', 'is required');
    if (s.actor === undefined) this.fail('actor', 'is required');
    this.nonEmptyString('typeName');
    this.nonEmptyString('role');
    this.positiveNumber('acquireRetryIntervalMs');
    this.positiveNumber('handOverTimeoutMs');
    this.positiveInt('maxHandOverStateBytes');
    this.positiveInt('bufferSize');
  }
}

/**
 * Accepted input for {@link ClusterSingleton.start}: the fluent
 * {@link StartSingletonOptionsBuilder} OR a plain (partial)
 * {@link StartSingletonOptionsType} object.
 */
export type StartSingletonOptions<T> =
  | StartSingletonOptionsBuilder<T>
  | Partial<StartSingletonOptionsType<T>>;
/** Value alias so `StartSingletonOptions.create()` / `new StartSingletonOptions()` resolve to the builder. */
export const StartSingletonOptions = StartSingletonOptionsBuilder;
