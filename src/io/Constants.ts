/**
 * Tuned values shared across the IO subsystem.
 *
 * A constant lives here when it is a cap, bound or buffer size that more than
 * one IO file reads — not when it is the built-in default of a single options
 * type (that belongs in the matching `XOptions.ts`, e.g. the framing defaults
 * in `TcpFraming.ts`, which are part of the framing vocabulary defined beside
 * the extractors).
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
