/**
 * Tuned values shared across the DevTools subsystem.
 *
 * A constant lives here when it is a cap, bound, timeout or sampling size
 * that more than one DevTools file reads — not when it is part of a frame
 * declaration (those bounds stay in `protocol/*Frames.ts`, where they
 * define the wire schema) and not when it is the built-in default of an
 * options field (that belongs in `DevToolsOptions.ts`).
 *
 * This module imports nothing, so it can never close an import cycle —
 * the same property `XOptions.ts` has by construction.
 */

/**
 * How many hot mailboxes to surface.  Applied twice on the same data: a
 * node reports its own busiest five (`NodeSampler`), and the overview
 * shows the busiest five across all nodes (`StatsTap`).  The two have to
 * agree, or the aggregate silently truncates a node's contribution before
 * it can compete — which is why the value is shared rather than tuned
 * per site.
 */
export const TOP_MAILBOX_COUNT = 5;

/**
 * Address reported for the single node of a system with no cluster.  Both
 * the actor tree and the stats overview fall back to it, and the UI keys
 * per-node state on the string, so the two must not diverge.
 */
export const LOCAL_ADDRESS = 'local';

/**
 * How long a peer's last answer stays fresh.
 *
 * Generous relative to the poll interval, so one dropped envelope does
 * not flag a healthy node as stale.
 */
export const STALE_AFTER_MS = 5_000;

/** How often departed members are checked for expiry. */
export const SWEEP_INTERVAL_MS = 30_000;

/**
 * Hard ceiling on cached peer readings, oldest evicted first.
 *
 * Deliberately the same 1000 as the cluster's own `maxMembers` default:
 * the collector only ever caches a node the cluster holds as a member, so
 * a cache larger than the member map is a cache holding rows for nodes
 * that do not exist.  A backstop rather than the first line of defence —
 * it is here because the two caps live in different subsystems, and
 * "they will stay in agreement" is not a property anything checks.
 */
export const MAXIMUM_PEER_REPORTS = 1_000;

/**
 * Longest actor tree accepted from a peer; the rest is dropped.
 *
 * A node's own tree is sent whole, because a node reporting on itself
 * cannot lie about its size.  A peer's arrives off the cluster wire, and
 * the collector holds it until the next round — so an unbounded one is a
 * memory cost this node did not choose.  Ten thousand rows is already far
 * past what the tree panel can show; a truncated tree beats a stalled
 * dashboard.
 */
export const MAXIMUM_PEER_ACTORS = 10_000;

/** How often a running session reports its sample count. */
export const PROGRESS_INTERVAL_MS = 500;

/** Longest auto-stopping run; a profiler is not a monitoring agent. */
export const MAXIMUM_DURATION_MS = 10 * 60 * 1000;

/** Refuse anything larger; a ring is a debugging aid, not a log. */
export const MAXIMUM_CAPACITY = 10_000;

/** Persistence ids returned per page. */
export const DEFAULT_IDENTIFIER_LIMIT = 100;

/** Events returned per page — a journal can be enormous. */
export const DEFAULT_EVENT_LIMIT = 200;

export const MAXIMUM_EVENT_LIMIT = 2_000;
