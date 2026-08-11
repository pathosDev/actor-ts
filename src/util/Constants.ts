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
 * Default ask-reply timeout.  Used by `ActorRef.ask` itself, and by
 * `ClusterClient`, `ClusterClientReceptionist` and `DistributedData`
 * quorum read/write.  Per-call `timeoutMs` overrides at every site.
 *
 * `ActorRef.ask` carried its own `5_000` literal until #1088, where the
 * cost of that showed up: `ScatterGatherRouter` has to stay *below* this
 * value to report before the caller gives up, and a duplicated literal is
 * a coupling nothing can check.
 */
export const DEFAULT_ASK_TIMEOUT_MS = 5_000;

/**
 * Default seed-retry interval — how long a node waits before
 * re-attempting a failed `Cluster.join`.  3 s balances "give the
 * seed node time to start" with "fail fast on a missing peer".
 */
export const DEFAULT_SEED_RETRY_INTERVAL_MS = 3_000;

/**
 * Default per-phase timeout in the `CoordinatedShutdown` pipeline.
 * A phase that overruns it is abandoned so the next one still gets
 * to run — 5 s balances letting a slow task finish against blocking
 * shutdown indefinitely.  Overridable globally, per phase, or via
 * `actor-ts.coordinated-shutdown.default-phase-timeout`.
 */
export const DEFAULT_PHASE_TIMEOUT_MS = 5_000;

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
 * Messages an explain plan keeps when the caller names no capacity.
 *
 * There are two doors onto the same ring and they have to resolve
 * "unspecified" identically: `ActorContext.enableExplainPlan()` for code
 * that switches it on directly, and the DevTools `explain.enable` RPC for
 * a client that switches it on from outside.  Both land in
 * `ActorCell._enableExplain`.  Two copies of the number meant the same
 * feature could answer "how big is the default ring?" two ways depending
 * on which door you came through.
 *
 * The DevTools path additionally *clamps* a caller-supplied capacity; that
 * ceiling is a guard on untrusted RPC input rather than a property of the
 * ring, so it stays in `ExplainTap` where the input arrives.
 */
export const DEFAULT_EXPLAIN_CAPACITY = 100;

/**
 * Whole-token values that would carry traversal meaning in a name.
 *
 * Rejected as an actor-path segment (`ActorPath`) and as a persistence id
 * (`PersistenceIdValidator`).  The two validators guard different things
 * but against the same attack: a persistence id reaches a filesystem or
 * object-storage key, where `..` climbs out of the configured prefix, and
 * a path segment reaches actor-selection resolution.
 *
 * Shared rather than duplicated because a denylist that exists twice is a
 * denylist that can be extended once.  Adding a third traversal token to
 * one copy and not the other leaves a hole in whichever validator was
 * forgotten, and nothing about the two files makes that omission visible.
 *
 * Typed `ReadonlySet` on purpose: `new Set([…])` alone infers a mutable
 * `Set<string>`, and a shared denylist any caller can `.delete()` from is
 * worse than two private ones.
 */
export const PATH_TRAVERSAL_SEGMENTS: ReadonlySet<string> = new Set(['.', '..']);
