import type { Lease } from '../../coordination/Lease.js';
import type { Props } from '../../Props.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/** Plain options-object shape accepted by {@link ClusterSingleton.start}. */
export type StartSingletonOptionsType<T> = {
  /** Logical name for this singleton — used in the manager/child actor path. */
  readonly typeName: string;
  /** Props used to construct the singleton on the leader. */
  readonly props: Props<T>;
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
 *         .withProps(Props.create(() => new CounterActor())),
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
    // `Props.create`, several frames from anything the caller wrote.
    if (s.typeName === undefined) this.fail('typeName', 'is required');
    if (s.props === undefined) this.fail('props', 'is required');
    this.nonEmptyString('typeName');
    this.nonEmptyString('role');
    this.positiveNumber('acquireRetryIntervalMs');
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
