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

/** Longest JSON a captured message may occupy, in characters. */
export const MESSAGE_JSON_LIMIT = 2_000;

/** How deep {@link describeMessagePayload} walks before giving up. */
export const MESSAGE_JSON_DEPTH = 6;
