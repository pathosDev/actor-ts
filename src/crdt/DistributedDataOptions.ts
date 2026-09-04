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

/**
 * Built-in default budget for one `ddata-gossip` frame's payload — 1 MiB.
 *
 * Not the wire cap, and deliberately far below it.  The wire cap
 * (`actor-ts.remote.max-frame-bytes`, 16 MiB) is where the *link dies*: a
 * frame past it is rejected on its 4-byte length prefix, and the transport
 * answers the decoder's throw by dropping the whole association (#691).  This
 * budget is where gossip *stops packing*, so the two are one order of
 * magnitude apart on purpose — the association also carries heartbeats, and
 * `failure-detector.unreachable-after` is 2 s, so a gossip frame sized to the
 * wire cap would be a head-of-line stall long enough to be mistaken for a
 * dead node (#846 is the general form of that).
 *
 * 1 MiB measured against the real `toJSON` shapes and the real encoder: a
 * three-replica `GCounter` under an `actor-ts@host:port` replica id costs
 * ~131 bytes on the wire, so a tick carries ~8 000 such keys and a
 * 100 000-key store sweeps in ~13 default-interval ticks.  Convergence is
 * unaffected — state-based CRDT merge is idempotent and commutative, and
 * `onGossip` treats an absent key as "no information" — so spreading the key
 * set over ticks costs latency, not agreement.
 *
 * A store that already fits in one frame is unaffected by the number; raise
 * it (or set `0`) only where a large store must converge in fewer rounds and
 * the link has nothing latency-sensitive to lose.  The effective budget is
 * always clamped to the transport's own {@link Transport.maxFrameBytes}, so
 * *lowering* the wire cap lowers this with it and no setting can put gossip
 * back over the edge.
 */
export const DEFAULT_MAX_GOSSIP_BYTES = 1024 * 1024;

/**
 * Built-in default for {@link DistributedDataOptionsType.logDataSizeExceeding}
 * — 100 KiB, roughly a tenth of {@link DEFAULT_MAX_GOSSIP_BYTES}.
 *
 * *Roughly*, because the two are round numbers in the same unit and not
 * multiples of each other: 100 KiB is 9.77 % of 1 MiB.  A literal tenth would
 * be 104 857.6 bytes, which is neither an integer nor something an operator
 * can write in HOCON, and the reasoning below is about an order of magnitude
 * rather than a ratio, so the round number is the honest spelling.
 *
 * Derived from the budget rather than picked, because "large" has no absolute
 * meaning for a CRDT: the framework cannot know whether a key holds four
 * counters or a shopping cart.  What it can measure is the key's share of one
 * gossip tick, and a tenth is where that share starts governing everybody
 * else's convergence — ten such keys fill a whole frame, so every remaining
 * key in the store waits an extra sweep for each of them.  Below that the
 * packer absorbs the key without anyone noticing, which is the correct
 * outcome and the reason the threshold is not lower.
 *
 * Against the same wire measurement {@link DEFAULT_MAX_GOSSIP_BYTES} was
 * chosen on — a three-replica `GCounter` under an `actor-ts@host:port`
 * replica id costs ~131 bytes — this is ~780 ordinary entries' worth in a
 * single key, so no legitimate small value reaches it by accident.
 *
 * Deliberately **not** Akka's 10 KiB.  That number is a tenth of *this* one
 * and was chosen against Akka's own frame sizing; here it would sit at 1 % of
 * a tick and fire on the first honest `ORSet` a deployment stores, which ends
 * the way every over-eager warning ends — filtered out, taking the one case
 * that mattered with it.
 *
 * `0` disables the warning entirely, the project's spelling for "off".
 */
export const DEFAULT_LOG_DATA_SIZE_EXCEEDING_BYTES = 100 * 1024;

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
   * Byte budget for one gossip frame's payload.  A store larger than this is
   * pushed a slice at a time, resuming where the previous tick stopped, so
   * every key is gossiped within `ceil(store / budget)` ticks instead of all
   * of them in one frame nobody can receive.  `0` removes the budget.
   *
   * Default: {@link DEFAULT_MAX_GOSSIP_BYTES} (1 MiB) — see that constant for
   * why it sits an order of magnitude under the wire cap rather than at it.
   *
   * **The effective budget is the smaller of this and the transport's
   * `maxFrameBytes`**, and that clamp is the point rather than a detail.
   * Lowering `actor-ts.remote.max-frame-bytes` is the documented advice for a
   * network crossing a semi-trusted boundary; a DistributedData budget that
   * ignored it would leave a store sized for the old cap gossiping frames the
   * peer now rejects on the length prefix, killing the association once per
   * tick with nothing logged on the sending side (#691).
   *
   * A single key whose own encoding exceeds the budget cannot be sliced —
   * `entries` is keyed per CRDT and the unit is one key's full state.  It is
   * skipped, warned about (rate-limited, naming the key and both sizes) and
   * counted in `distributed_data_gossip_skipped_keys_total`.  That key does
   * not converge; the honest options were a divergent key that says so and a
   * dead link that does not, and the alternative to bounding the value is
   * bounding nothing.  `MAX_CRDT_ENTRIES` bounds an entry *count*, never a
   * byte size, so one legitimate `ORSet` can reach this on its own.
   */
  readonly maxGossipBytes?: number;
  /**
   * Warn when one key's own encoded size passes this many bytes.  `0` never
   * warns.  Default: {@link DEFAULT_LOG_DATA_SIZE_EXCEEDING_BYTES} (100 KiB).
   *
   * The early warning {@link maxGossipBytes} does not give.  That cap only
   * says something once a key has grown past a *whole* frame, at which point
   * the key has already stopped converging.  A key at a large fraction of the
   * budget is invisible by comparison and still expensive: it travels fine,
   * but it consumes that fraction of every tick it appears in, so the rest of
   * the store sweeps proportionally slower and nothing anywhere says why.
   *
   * **Warns, never skips.**  This is a report about a value the operator
   * chose, not a bound on it — the packer keeps packing the key exactly as it
   * would have. Its own rate limiter is separate from the oversize warning's
   * on purpose: the two lines call for different actions (split the value
   * versus raise the budget), and one must not suppress the other.
   *
   * **Measured once per sweep, not once per tick.**  The packer visits keys
   * from its cursor until the budget fills, so a key in a store larger than
   * one frame is measured every `ceil(store / budget)` ticks.  That is the
   * right cadence for a warning that is already rate-limited to a minute, and
   * the running total in the line covers the windows it skipped.
   */
  readonly logDataSizeExceeding?: number;
  /**
   * Which keys {@link durableStore} persists.  **Empty means every key** —
   * the behaviour of every release before this option existed — and never
   * "persist nothing"; the way to persist nothing is to configure no store.
   *
   * An entry is either an exact key name or a prefix ending in a single `*`
   * (`session-*`).  That is the whole syntax, and the restriction is a
   * security decision rather than a shortcut: a fuller glob means compiling a
   * matcher out of operator-supplied text, and `new RegExp(fromConfig)` is a
   * ReDoS surface reachable from a configuration file.  `ActorSelection` made
   * the same call for actor paths.
   *
   * **Narrowing the list drops what it no longer names.**
   * `DurableDistributedDataStore.save` replaces the replica's whole record on
   * every mutation, so a key that stops matching is not merely no longer
   * updated — it is gone from the persisted record on the next save, and a
   * cold start will not bring it back. Widening is safe: the next save writes
   * whatever the live view holds.
   *
   * Inert without a {@link durableStore}.  A non-empty list with no store
   * configured is warned about at startup rather than ignored silently — it
   * is a whitelist for a persistence layer that is not running.
   */
  readonly durableKeys?: readonly string[];
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

  /** Byte budget for one gossip frame's payload.  `0` removes it. */
  withMaxGossipBytes(maxGossipBytes: number): this {
    return this.set('maxGossipBytes', maxGossipBytes);
  }

  /** Warn about a key whose encoding passes this many bytes.  `0` never warns. */
  withLogDataSizeExceeding(logDataSizeExceeding: number): this {
    return this.set('logDataSizeExceeding', logDataSizeExceeding);
  }

  /** Keys the durable store persists — exact names or one trailing `*`.  Empty = all. */
  withDurableKeys(durableKeys: readonly string[]): this {
    return this.set('durableKeys', durableKeys);
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
  protected rules(s: Partial<DistributedDataOptionsType>): void {
    this.positiveNumber('gossipInterval');
    // Non-negative rather than positive on all three: `0` is the documented
    // "disabled" spelling, which the project prefers over `Infinity`.
    this.nonNegativeInt('maxPendingQuorumRequests');
    this.nonNegativeNumber('maxQuorumTimeout');
    // An integer because it is a byte count, and `getBytes` already resolves
    // `1M` to one.  A fractional budget would be arithmetic that never
    // matches a frame length.
    this.nonNegativeInt('maxGossipBytes');
    // Same reasoning again: a byte count, and `0` is how it is switched off.
    this.nonNegativeInt('logDataSizeExceeding');
    // Cross-field rather than a helper, because there is no list helper and
    // the rule is about a pattern's *shape*: an entry that matches nothing is
    // silently a no-op, and on a whitelist a no-op entry is a key an operator
    // believes is being persisted and is not.  `*` is rejected anywhere but
    // the last character so an entry never reads as a glob the matcher will
    // not honour — `a*b` would match the literal key `a*b` and nothing else,
    // which is the sort of surprise a durable whitelist cannot afford.
    for (const pattern of s.durableKeys ?? []) {
      if (typeof pattern !== 'string' || pattern.trim().length === 0) {
        this.fail('durableKeys', 'must contain only non-blank key patterns', pattern);
      }
      const star = pattern.indexOf('*');
      if (star !== -1 && star !== pattern.length - 1) {
        this.fail(
          'durableKeys',
          'allows "*" only as the last character of an entry, meaning a prefix match',
          pattern,
        );
      }
      if (pattern === '*') {
        this.fail(
          'durableKeys',
          'does not take a bare "*" — an empty list already means every key',
          pattern,
        );
      }
    }
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
  if (config.hasPath(keys.maxGossipBytes)) {
    out.maxGossipBytes = config.getBytes(keys.maxGossipBytes);
  }
  if (config.hasPath(keys.logDataSizeExceeding)) {
    out.logDataSizeExceeding = config.getBytes(keys.logDataSizeExceeding);
  }
  if (config.hasPath(keys.durableKeys)) {
    out.durableKeys = config.getStringList(keys.durableKeys);
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
