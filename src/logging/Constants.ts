/**
 * Tuned values shared inside the logging subsystem that are not the
 * built-in default of an options field (those live in the matching
 * `XOptions.ts`).
 *
 * This module imports nothing, so it can never close an import cycle.
 */

/**
 * How often a sink may report the same class of trouble on the console.
 *
 * A sink cannot report through the framework logger — it *is* the framework
 * logger — so it falls back to raw `console.error`.  That fallback has no
 * level gate and no sampling in front of it, which makes it a firehose in
 * exactly the situation it exists for: a destination that is down produces
 * one failure per batch, and a queue that is full produces one per record.
 * A minute is long enough that a broken destination costs a handful of
 * lines an hour, short enough that an operator watching a terminal sees the
 * problem while it is happening.
 *
 * Deliberately not configurable: a knob here would be the one thing an
 * operator turns down before an incident and forgets to turn back up.
 */
export const SINK_REPORT_INTERVAL_MS = 60_000;
