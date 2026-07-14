/**
 * Cross-subsystem default values that were previously duplicated as
 * inline literals across multiple sites.
 *
 * Centralising serves two purposes:
 *   1. **One source of truth** — when the gossip interval needs to
 *      change, every consumer picks up the new default automatically
 *      (per-call options still override at the site).
 *   2. **Self-documenting magic numbers** — the named export
 *      `DEFAULT_GOSSIP_INTERVAL_MS` is clearer at the call site than
 *      a bare `1_000` literal with a comment.
 *
 * Naming convention: `DEFAULT_<DOMAIN>_<UNIT>` (always with the unit
 * suffix, since milliseconds are by far the most common unit and
 * mixing up `5` (seconds) with `5_000` (milliseconds) is the kind of
 * bug centralisation should head off).
 *
 * **Scope rule**: a value lives here only if it is **shared across
 * multiple subsystems** (cluster + persistence + ...).  File-local
 * security-tuned constants (e.g. the `MAX_VERSION_SKEW_MS` in
 * `Cluster.ts`, whose 24h value is justified by the security-exploit
 * comment at the call site) stay where they are — moving them here
 * would obscure the per-site rationale.
 */

/**
 * Default cluster gossip-tick interval.  Used by `Cluster`,
 * `DistributedPubSubMediator`, and `Receptionist`.
 */
export const DEFAULT_GOSSIP_INTERVAL_MS = 1_000;

/**
 * Default ask-reply timeout.  Used by `ClusterClient`,
 * `ClusterClientReceptionist`, and `DistributedData` quorum
 * read/write.  Per-call `timeoutMs` overrides at every site.
 */
export const DEFAULT_ASK_TIMEOUT_MS = 5_000;

/**
 * Default seed-retry interval — how long a node waits before
 * re-attempting a failed `Cluster.join`.  3 s balances "give the
 * seed node time to start" with "fail fast on a missing peer".
 */
export const DEFAULT_SEED_RETRY_INTERVAL_MS = 3_000;

/**
 * Default tombstone retention (`Cluster.tombstoneTtlMs`).  24 h
 * gives slow / partitioned peers a generous window to converge
 * after a member is removed; once expired, peers can re-mint the
 * address without resurrecting the tombstone.  See `Cluster.ts`
 * + #75 for the full lifecycle.
 *
 * Note: distinct from `MAX_VERSION_SKEW_MS` in `Cluster.ts` —
 * those happen to share the same value but have separate
 * justifications (security-cap vs retention).
 */
export const DEFAULT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Default cadence for the tombstone-pruning sweep.  5 min gives
 * a useful safety margin around the 24 h TTL without busy-looping.
 */
export const DEFAULT_TOMBSTONE_PRUNE_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Default TTL for cache-fronted snapshot stores
 * (`CachedSnapshotStore`).  5 min suits the typical "actor
 * restarts a few times during deploy" pattern without holding
 * stale data forever.
 */
export const DEFAULT_SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1_000;

/**
 * Default mailbox capacity for every actor that doesn't pin its own
 * via `Props.withMailbox(...)`.  10 000 is high enough that a
 * well-tuned actor never hits it on a normal traffic spike, low
 * enough that a runaway producer is bounded before the heap explodes.
 *
 * Pre-#310 the default was unbounded — operationally an OOM-or-bust
 * proposition.  The current default trades the worst-case loss-of-
 * messages for a guaranteed memory ceiling.  Opt out per-actor via
 * `Props.withMailbox(() => new Mailbox())` for the unbounded shape.
 */
export const DEFAULT_MAILBOX_CAPACITY = 10_000;

/**
 * Default overflow policy for the bounded default mailbox.  `drop-
 * head` discards the oldest queued message when a new one arrives
 * on a full mailbox — the right shape for telemetry-style workloads
 * where stale messages are worthless and the freshest snapshot is
 * the only thing that matters.
 *
 * Pick `drop-new` or `reject` per-actor (see `BoundedMailbox`
 * documentation) when the trade-off is different.
 */
export const DEFAULT_MAILBOX_OVERFLOW = 'drop-head' as const;
