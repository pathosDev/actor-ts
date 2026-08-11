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
