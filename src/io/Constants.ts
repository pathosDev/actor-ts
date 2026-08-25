/**
 * Tuned values shared across the IO subsystem.
 *
 * A constant lives here when it is a tuned value — a cap, bound, timeout,
 * retry limit or buffer size — that is *not* the built-in default of one
 * options type (that belongs in the matching `XOptions.ts`, e.g. the framing
 * defaults in `TcpFraming.ts`, which are part of the framing vocabulary
 * defined beside the extractors) and *not* vocabulary whose meaning is the
 * codec or algorithm sitting beside it.  Being read by only one IO file is
 * not a reason to leave it there: what makes a value belong here is that it
 * is tuned rather than derived, so re-tuning it is a visible edit to a file
 * that holds nothing else.
 *
 * This module imports nothing, so it can never close an import cycle — the
 * same property `XOptions.ts` has by construction.
 */

/**
 * Where a TCP connection's inbound frame buffer starts, and the largest one it
 * keeps once it has nothing left to frame (#610).
 *
 * The buffer accumulates into a slab it grows by doubling, so the initial size
 * only decides how many growths an ordinary connection performs before it
 * settles — a few kilobytes covers any line-oriented or length-prefixed frame
 * a normal peer sends, so in practice that is one allocation for the life of
 * the connection.
 *
 * The retention bound is the other half: a slab is sized by the largest frame
 * it has ever had to hold, so one peer that once filled a 16 MiB
 * `maxFrameLen` would otherwise pin 16 MiB per connection until it hangs up.
 * Above this size the slab is released the moment the buffer drains, which
 * costs one allocation on the next chunk — worth paying for a frame size that,
 * by definition, is rare.
 *
 * Deliberately *not* shared with the cluster transport's identically-tuned
 * `INITIAL_FRAME_BUFFER_BYTES` / `RETAINED_FRAME_BUFFER_BYTES`
 * (`src/cluster/Constants.ts`): the two subsystems buffer different wire
 * formats for different peers, and a common helper would couple them so that
 * re-tuning one silently re-tunes the other.
 */
export const TCP_INITIAL_INBOUND_BUFFER_BYTES = 8 * 1_024;
export const TCP_RETAINED_INBOUND_BUFFER_BYTES = 64 * 1_024;

/**
 * How long the Redis-Streams consumer loop waits before re-issuing an
 * `XREADGROUP` that failed for a reason a new connection would not fix (#742).
 *
 * This is the *command-level* retry only.  A connection-level rejection now
 * leaves the loop entirely and hands the outage to the base class's
 * `reconnect` backoff and circuit breaker, so the delay no longer has to
 * double as an outage policy the operator cannot configure — which is what it
 * silently was while every failure landed here.
 *
 * Kept short deliberately: what reaches this path is a command Redis itself
 * refused (a bad argument, a `WRONGTYPE`, a busy script) on a connection that
 * is still healthy, and the loop is a consumer whose latency budget is the
 * `blockMs` it would otherwise be sitting in anyway.  The log volume that
 * shape used to produce is bounded by
 * {@link REDIS_STREAMS_WARN_DEDUPLICATION_WINDOW_MS} rather than by stretching
 * this number, so raising it would only add consume latency.
 */
export const REDIS_STREAMS_COMMAND_RETRY_DELAY_MS = 500;

/**
 * How long an identical Redis-Streams consumer-loop failure stays suppressed
 * before it is logged again, with the count of what it stood in for (#742).
 *
 * A persistent command-level failure retries every
 * {@link REDIS_STREAMS_COMMAND_RETRY_DELAY_MS}, so without a window a single
 * stuck consumer writes thousands of identical WARN records per hour and N of
 * them multiply it by N.  The window is on *identical* messages only — a
 * failure whose text changed is new information and is logged immediately,
 * because the failure mode this dampens is repetition, not volume.
 *
 * Half a minute is short enough that the record still reads as "ongoing" to an
 * operator watching a log stream, and long enough that the suppressed count
 * carries the rate instead of the log doing it one line at a time.
 */
export const REDIS_STREAMS_WARN_DEDUPLICATION_WINDOW_MS = 30_000;
