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

/**
 * How long a GELF or syslog stream connection may go without draining, after
 * a write it answered `false`, before the batch counts as failed, retryably,
 * and the connection is torn down (#1827).
 *
 * A sink writes no further record into a socket that has pushed back until
 * the socket drains, so records pile up in the sink's own bounded queue — with
 * its reported drop — rather than in a socket backlog without bound.  A drain
 * that never comes is a collector that stopped reading while keeping the
 * connection open; without a bound here it would hold the batch, and the
 * sink's final drain on close, for good.  Ten seconds, the same as the dial
 * bound in front of it: a collector that takes nothing for that long is no
 * more alive than one that never answers the SYN, and a fresh dial on the
 * retry is the one thing that can tell a restarted collector from a dead one.
 */
export const SINK_STREAM_DRAIN_TIMEOUT_MS = 10_000;
