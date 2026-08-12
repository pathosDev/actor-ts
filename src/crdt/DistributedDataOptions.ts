import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { Config } from '../config/Config.js';
import type { DurableStateStore } from '../persistence/DurableStateStore.js';

/**
 * Built-in default for
 * {@link DistributedDataOptionsType.maxPendingQuorumRequests} — see that
 * field for what the cap actually buys, which is a bound on the unsettled
 * set rather than protection from the mailbox underneath it.
 */
export const DEFAULT_MAX_PENDING_QUORUM_REQUESTS = 1_000;

/** Built-in default ceiling on a caller-supplied quorum `timeoutMs`. */
export const DEFAULT_MAX_QUORUM_TIMEOUT_MS = 30_000;

/** Plain options-object shape accepted by {@link DistributedData.start}. */
export type DistributedDataOptionsType = {
  /** Period between gossip pushes.  Default: 1 s. */
  readonly gossipInterval?: number;
  /**
   * Most quorum requests (`updateAsync` + `getAsync` together) that may be
   * unsettled at once.  A request past the cap is rejected outright instead
   * of being tracked.  `0` disables the cap.
   *
   * What the cap buys is a bound on the unsettled set itself: every entry
   * holds a promise, a timer and a target set until its deadline passes, so
   * an uncapped replicator under load accumulates all three.  Refusing past
   * the cap converts what would be a timeout storm into immediate,
   * attributable rejections naming this knob (#140).
   *
   * It is deliberately *not* justified by the mailbox underneath it any
   * more.  That argument (sit an order of magnitude below the 10 000
   * drop-head bound, so the cap fires before the mailbox strands a
   * `ddata-update` envelope carrying the caller's `resolve` / `reject`) was
   * wrong twice over: measurement in #1078 showed the promises stayed
   * unsettled either way, and #1148 removed the default bound entirely.
   * 1 000 stands on the reasoning above, not on that one.
   */
  readonly maxPendingQuorumRequests?: number;
  /**
   * Ceiling on the per-call `timeoutMs` of `updateAsync` / `getAsync`.  A
   * larger caller-supplied value is clamped down to this one.  `0` disables
   * the ceiling.
   *
   * A pending quorum request holds a promise, a timer and a target set until
   * its deadline passes, and it occupies one of the
   * {@link maxPendingQuorumRequests} slots the whole time.  Without a ceiling
   * a single caller passing a multi-hour timeout parks those slots for hours
   * and locks every later request out of the cap it never reached itself.
   */
  readonly maxQuorumTimeout?: number;
  /**
   * Optional durable backend.  When provided, the local CRDT view
   * is loaded from the store on `preStart` and re-saved after every
   * mutation (local update, gossip merge, delete).  Without this,
   * `DistributedData` is purely in-memory — a full cluster restart
   * (deploy / outage) starts every replica empty.
   *
   * The store is keyed by replica id, so each cluster member owns
   * its own durable record.  CRDT semantics handle convergence
   * across replicas via gossip — durability is per-replica.
   *
   * Plug in any of the existing `DurableStateStore` implementations:
   * `InMemoryDurableStateStore` for tests, the SQLite / Cassandra /
   * S3 / filesystem backends for production.
   */
  readonly durableStore?: DurableStateStore;
};

/**
 * Fluent builder for {@link DistributedDataOptionsType}.  Fed to
 * `DistributedData.start(cluster, options)`; the `cluster` stays a
 * positional argument (it's the identity the store binds to, not a
 * tunable), while the tunables below are accumulated here.
 *
 *     dd.start(cluster, DistributedDataOptions.create()
 *       .withGossipInterval(500)
 *       .withDurableStore(store));
 */
export class DistributedDataOptionsBuilder extends OptionsBuilder<DistributedDataOptionsType> {
  /** Start a fresh builder.  Equivalent to `new DistributedDataOptionsBuilder()`. */
  static create(): DistributedDataOptionsBuilder {
    return new DistributedDataOptionsBuilder();
  }

  /** Period between gossip pushes in milliseconds.  Default 1 s. */
  withGossipInterval(ms: number): this {
    return this.set('gossipInterval', ms);
  }

  /** Cap on unsettled quorum requests (writes + reads).  `0` disables it. */
  withMaxPendingQuorumRequests(maxPendingQuorumRequests: number): this {
    return this.set('maxPendingQuorumRequests', maxPendingQuorumRequests);
  }

  /** Ceiling in ms on a caller's quorum `timeoutMs`.  `0` disables it. */
  withMaxQuorumTimeout(ms: number): this {
    return this.set('maxQuorumTimeout', ms);
  }

  /** Durable per-replica backend — load on start, re-save after each mutation. */
  withDurableStore(store: DurableStateStore): this {
    return this.set('durableStore', store);
  }
}

/** Validates resolved {@link DistributedDataOptionsType} settings. */
export class DistributedDataOptionsValidator extends OptionsValidator<DistributedDataOptionsType> {
  constructor() {
    super('DistributedDataOptions');
  }
  protected rules(_s: Partial<DistributedDataOptionsType>): void {
    this.positiveNumber('gossipInterval');
    // Non-negative rather than positive on both: `0` is the documented
    // "disabled" spelling, which the project prefers over `Infinity`.
    this.nonNegativeInt('maxPendingQuorumRequests');
    this.nonNegativeNumber('maxQuorumTimeout');
  }
}

/**
 * Read `actor-ts.distributed-data.*` into the shape the extension layers
 * under the caller's options.  Only keys actually present are returned, so
 * an absent one falls through to the built-in default instead of landing as
 * an explicit `undefined` — the rule `mergeOptions` encodes.
 *
 * `durableStore` has no leaf here on purpose: it is a `DurableStateStore`
 * instance, which a config file cannot express.
 */
export function readDistributedDataOptionsFromConfig(
  config: Config,
): Partial<DistributedDataOptionsType> {
  const keys = ConfigKeys.distributedData;
  const out: {
    -readonly [K in keyof DistributedDataOptionsType]?: DistributedDataOptionsType[K]
  } = {};
  if (config.hasPath(keys.gossipInterval)) {
    out.gossipInterval = config.getDuration(keys.gossipInterval);
  }
  if (config.hasPath(keys.maxPendingQuorumRequests)) {
    out.maxPendingQuorumRequests = config.getInt(keys.maxPendingQuorumRequests);
  }
  if (config.hasPath(keys.maxQuorumTimeout)) {
    out.maxQuorumTimeout = config.getDuration(keys.maxQuorumTimeout);
  }
  return out;
}

/**
 * Accepted input for {@link DistributedData.start}: the fluent
 * {@link DistributedDataOptionsBuilder} OR a plain
 * {@link DistributedDataOptionsType} object.
 */
export type DistributedDataOptions = DistributedDataOptionsBuilder | Partial<DistributedDataOptionsType>;
/** Value alias so `DistributedDataOptions.create()` / `new DistributedDataOptions()` resolve to the builder. */
export const DistributedDataOptions = DistributedDataOptionsBuilder;
