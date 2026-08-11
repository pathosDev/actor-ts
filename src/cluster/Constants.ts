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
