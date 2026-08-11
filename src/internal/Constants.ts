/**
 * Tuned values used by the actor runtime internals.
 *
 * Caps and sizes that are not backed by an options field — anything a
 * caller can set belongs in `ActorOptions.ts` instead.
 *
 * This module imports nothing, so it can never close an import cycle —
 * the same property `XOptions.ts` has by construction.
 */

export const DEFAULT_STASH_CAPACITY = 1024;

/**
 * Queued user messages at which a cell first warns that an actor is falling
 * behind its producers, then again at every doubling.
 *
 * Deliberately the capacity the default mailbox used to be bounded at
 * (#310).  #1148 removed the bound because evicting the oldest envelope is
 * not a decision a framework may take unasked, but the number itself was
 * good operational advice — 10 000 queued messages means something is
 * wrong — so it survives as the point where that advice is *given* rather
 * than the point where messages are destroyed.
 *
 * Doubling rather than repeating keeps it self-limiting at log2(n) lines
 * per actor and needs no reset hook on the drain path; the escalation from
 * 10k to 20k to 40k is itself the signal that the heap is the next thing to
 * go.
 */
export const MAILBOX_HIGH_WATER_MARK = 10_000;

/** Longest JSON a captured message may occupy, in characters. */
export const MESSAGE_JSON_LIMIT = 2_000;

/** How deep {@link describeMessagePayload} walks before giving up. */
export const MESSAGE_JSON_DEPTH = 6;
