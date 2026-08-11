/**
 * Tuned values shared across the cluster subsystem.
 *
 * A constant lives here when it is a cap, bound, timeout or cadence that
 * more than one cluster file reads — not when it is the built-in default of
 * a single options type (that belongs in the matching `XOptions.ts`), and
 * not when it is part of the wire format defined beside it (`Protocol.ts`'s
 * `HEADER_SIZE`, `WireValidation.ts`'s codepoints).
 *
 * The case this module exists for is the one `XOptions.ts` cannot express:
 * a default shared by *two* options types.  Co-location would put it in
 * both, which is the duplication it is supposed to prevent.
 *
 * This module imports nothing, so it can never close an import cycle —
 * the same property `XOptions.ts` has by construction.
 */

/**
 * How often the cluster sends heartbeats, in milliseconds.
 *
 * The cadence belongs to the cluster's heartbeat loop, not to the detection
 * algorithm: `Cluster` schedules both its heartbeat tick and its detection
 * tick from whichever detector is installed (`failureDetector.interval`).
 * So swapping `FailureDetector` for `PhiAccrualFailureDetector` without
 * naming options must not silently change how often the node talks to its
 * peers — which is exactly what two independent copies of this number
 * allowed.
 *
 * Mirrored by `actor-ts.cluster.failure-detector.heartbeat-interval` in
 * `reference.conf`, which is pinned to the simple detector's defaults by
 * `ClusterConfigDefaults.test.ts`.  The φ-accrual detector has no config
 * block at all, so its copy was pinned to nothing.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 500;

/**
 * Maximum allowed deviation between a peer-supplied **wall-clock stamp** and
 * the local clock — 1 day.  Anything above is rejected as a corrupted or
 * forged frame.
 *
 * It guards the two fields that are timestamps rather than versions: a
 * tombstone's `removedAt`, which decides when the entry ages out, and a
 * heartbeat's `ts`.  Both are read for housekeeping, not for conflict
 * resolution, so the bound is tuned generous-but-finite — a node with a
 * 23-hour clock skew still prunes in step with its peers, while a frame
 * claiming `Number.MAX_SAFE_INTEGER` (≈ 285 000 years above now) is rejected
 * on the spot.
 *
 * Member **versions** are a different quantity and are held to the much
 * tighter, per-node configurable {@link ClusterOptionsType.maxVersionSkewMs}
 * — see {@link Cluster.admitsVersion} for why the two numbers are not one.
 */
export const MAX_WALL_CLOCK_SKEW_MS = 24 * 60 * 60 * 1_000;

/**
 * How long a `ClusterClient` waits for the receptionist's `hello-ack` before
 * giving up on a contact point and trying the next one.  Matches
 * {@link HANDSHAKE_TIMEOUT_MS}: both bound the same thing from opposite ends
 * of the same handshake.
 */
export const HELLO_TIMEOUT_MS = 5_000;

/**
 * How long a dialled connection may sit without a `hello-ack` before it is
 * torn down and its `byPeer` slot released.  A peer that accepts TCP but never
 * speaks the protocol would otherwise hold the slot — and every frame aimed at
 * it — for the process's lifetime.
 */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * Cap on frames buffered while a handshake is outstanding.  The buffer exists
 * so a `send` racing the handshake is not lost; it is not a durable queue, and
 * an unbounded one turns a silently-stuck peer into a memory leak.  Oldest
 * frames are dropped first — the newest membership/heartbeat state is the
 * state worth keeping.
 */
export const MAX_PENDING_FRAMES = 1_000;

/**
 * How many keys a remote peer may contribute, and how long each value may be.
 * A context rides on *every* envelope and is stamped onto *every* log line the
 * receiving actor emits, so an oversized one is not a single large record —
 * it is a permanent tax on the node's log volume.
 */
export const MAX_CONTEXT_KEYS = 32;
export const MAX_CONTEXT_VALUE_LENGTH = 1_024;

/**
 * How long allocation changes are gathered before one `ShardMapUpdate` goes
 * out.  Long enough to fold a whole-cluster placement into a single
 * broadcast, short enough that a panel still feels live.
 */
export const SHARD_MAP_PUBLISH_DELAY_MS = 50;
