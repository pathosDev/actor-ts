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

/**
 * How long the bus panel waits for the PubSub mediator's topic list.
 *
 * Short, because this is a panel refresh and not a cluster operation: a
 * mediator too busy to answer a local mailbox hop in two seconds is
 * itself the finding, and a longer wait would only delay reporting it.
 */
export const PUBSUB_TOPICS_TIMEOUT_MS = 2_000;

/** Events returned per page — a journal can be enormous. */
export const DEFAULT_EVENT_LIMIT = 200;

export const MAXIMUM_EVENT_LIMIT = 2_000;

/**
 * Requests one connection may have outstanding at once (#758).
 *
 * The hub answers a `request` frame *off* its mailbox — deliberately, so a
 * slow journal read cannot stall every other connected tab — which also
 * means the mailbox is no longer the thing that serialises the work.  With
 * nothing counting, a client can dispatch frames as fast as it can write
 * them and hold thousands of concurrent journal reads and full-state
 * replays against the host process, which shares its event loop with the
 * application's own actors.
 *
 * Well above what a panel does: the whole bundled UI has fewer than
 * thirty request call sites, and a burst is a page's worth of them, not a
 * loop.  So this bounds a flood without ever being reachable by a client
 * behaving normally — which is why it is a fixed floor rather than an
 * option.  A debugger that needs it raised is a debugger doing something
 * the panel does not do.
 */
export const MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION = 32;

/**
 * Requests the hub may have outstanding across *all* connections (#758).
 *
 * The per-session cap alone bounds one socket, not the hub: nothing caps
 * how many sockets a client opens, so N connections would multiply it by
 * N.  This is the bound that does not depend on the connection count, and
 * therefore the one that decides how much concurrent journal I/O the
 * process can be made to carry.
 *
 * Eight saturated sessions' worth.  Deliberately smaller than
 * {@link MAXIMUM_HUB_CONNECTIONS} × {@link MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION}
 * so that it, and not the product of the other two, is what binds.
 */
export const MAXIMUM_IN_FLIGHT_REQUESTS = 256;

/**
 * Concurrent WebSocket connections admitted on the DevTools tap (#758).
 *
 * Defence in depth rather than the bound that matters: the global
 * in-flight cap above already limits the *work*, and this limits the
 * sockets, which cost a session entry and a connection actor each.  The
 * route default is `Infinity`, which for a debugger is a stranger choice
 * than any finite number — a developer opens tabs, not hundreds of them.
 */
export const MAXIMUM_HUB_CONNECTIONS = 32;
