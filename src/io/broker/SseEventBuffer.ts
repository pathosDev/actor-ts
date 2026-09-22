/**
 * The pending-event buffer `SseActor` accumulates partial `text/event-stream`
 * blocks in — one instance per stream, holding the characters that have
 * arrived but have not yet completed an event.
 *
 * **Why this is not a `string` field plus `indexOf`.**  It was, and that was
 * #749.  `buffer += chunk` followed by `buffer.indexOf('\n\n')` restarts the
 * delimiter search at index 0 on every read, so a server that dribbles bytes
 * and never sends the blank line makes each read O(pending) — and the cap that
 * bounds the stream is a mebibyte, so the cap sets the cost ceiling instead of
 * lowering it.  A trickle of bandwidth buys seconds of blocked event loop, and
 * `BrokerActor` reconnects afterwards with `maxAttempts: Infinity`, so the
 * peer simply replays the cycle.
 *
 * Carrying a scan offset into `indexOf` — the fix the report proposed — is
 * necessary and **not sufficient**, which is the part that makes this a class
 * rather than one extra argument.  `buffer += chunk` leaves a rope behind, and
 * every method call that reaches into it flattens the whole accumulation
 * first; the offset narrows the window that is *searched* while the string
 * under it is still materialised per read.  So the characters stay unjoined in
 * {@link SseEventBuffer.parts} until a delimiter actually turns up, and the
 * search each read runs is over the arriving chunk alone.
 *
 * The seam is the one thing a naive offset gets wrong in the other direction:
 * `\n\n` split across two reads has its first newline at the end of the
 * previous chunk, so the search resumes one character *before* the join, never
 * at it.
 *
 * **Line endings are normalised here, and only here** (#1510).  The SSE
 * grammar terminates a line with CRLF, LF *or* a lone CR, so a conformant feed
 * may never contain a single `'\n\n'`; until this buffer accepted all three,
 * a `\r\n\r\n`-framed stream completed no block at all and grew until the
 * actor's 1 MiB cap declared it hostile.  Converting on the way in — rather
 * than teaching the delimiter search, the cut and the field parser three
 * spellings each — is what keeps that a single decision, and it is the reason
 * {@link SseEventBuffer.push} is the only place a `\r` is ever seen.
 *
 * Same defect and same shape as `TcpInboundBuffer` (#610) on the byte side,
 * deliberately not shared with it: that one owns a `Uint8Array` slab framed by
 * a pluggable strategy, this one owns decoded characters split on a fixed
 * delimiter, and a common helper would couple two wire formats that have
 * nothing but the complexity class in common.
 */

/**
 * The blank line that terminates one SSE event block, **after** the line
 * endings of the arriving chunk have been normalised to LF.  Wire vocabulary
 * of the format parsed beside it, not a tuned value — and not a claim that the
 * wire itself only ever frames with LF, which is the reading this comment
 * invited before #1510 gave it something to be true of.
 */
const EVENT_DELIMITER = '\n\n';

/**
 * The two line terminators the SSE grammar allows besides LF: a CR followed by
 * an LF, and a lone CR.
 *
 * Written `\r\n?` rather than `\r|\r\n` because alternation is ordered and the
 * regex engine takes the first branch that matches — `/\r|\r\n/` would consume
 * the CR alone and leave the LF standing, turning every CRLF into a blank line
 * and every event into two.  The optional-suffix form cannot express that
 * mistake.
 */
const CARRIAGE_RETURN_TERMINATOR = /\r\n?/g;

export class SseEventBuffer {
  /**
   * Characters received and not yet delivered as a block, **unjoined**.
   * Keeping them apart is what removes the per-read materialisation: they are
   * concatenated only on the read that completes an event, and everything the
   * join produces is either handed out as a block or is the residual that
   * becomes the single part left behind.
   */
  private parts: string[] = [];
  private pending = 0;

  /**
   * Whether the chunk before this one ended on a CR — the seam state of the
   * line-ending normalisation, and the one thing a per-chunk `replace` cannot
   * know.
   *
   * It is a flag and not a withheld character, deliberately.  A CR is a line
   * terminator on its own, so converting it the moment it arrives is always
   * right; what the *next* chunk decides is only whether a leading LF belongs
   * to it — making the pair one terminator — or opens a line of its own.
   * Holding the CR back until that is known would be the other way to get the
   * pair right, and it loses the last event of a CR-framed feed: at end of
   * stream there is no next chunk to resolve the carry, so a terminator the
   * grammar considers complete would never be applied.
   */
  private lastChunkEndedInCarriageReturn = false;

  /**
   * Characters buffered without a delimiter — zero when the stream has drained
   * exactly on an event boundary.  This is the quantity the actor's safety cap
   * is about, so it is public where the parts are not.
   */
  pendingLength(): number {
    return this.pending;
  }

  /**
   * Take one decoded chunk and return every event block it completed, in
   * arrival order — empty for the ordinary read that only extends a partial
   * event.
   *
   * Invariant that keeps the search local: what stays buffered after `push`
   * never contains a delimiter, so a chunk only has to be examined against the
   * seam it lands on and not against anything older.  The second invariant is
   * newer and is what the rest of the reader rests on: nothing buffered here
   * contains a CR, because {@link SseEventBuffer.normaliseLineEndings} runs
   * before any of it is kept (#1510).
   */
  push(chunk: string): string[] {
    const normalised = this.normaliseLineEndings(chunk);
    if (normalised.length === 0) return [];
    const seam = this.seamCharacter();
    const carriesDelimiter = (seam + normalised).indexOf(EVENT_DELIMITER) >= 0;
    this.parts.push(normalised);
    this.pending += normalised.length;
    return carriesDelimiter ? this.splitCompletedBlocks() : [];
  }

  /* ----------------------------- internals ----------------------------- */

  /**
   * Rewrite the chunk's CRLF and lone-CR terminators as LF, carrying the one
   * decision that cannot be made inside a single chunk across the seam.
   *
   * The seam case is the whole difficulty: a terminator may arrive in two
   * pieces, `\r` at the end of one read and `\n` at the start of the next, and
   * that pair is **one** terminator.  So a leading LF is dropped when the
   * previous chunk ended on a CR — the CR was already converted, and keeping
   * the LF as well would manufacture a blank line and dispatch half an event.
   * Everything else the SSE grammar says about line endings is chunk-local.
   *
   * An empty chunk returns before the seam state is touched: `TextDecoder`
   * yields `''` for a read that is entirely the lead bytes of a multi-byte
   * character, and letting that clear the flag would split a terminator that a
   * split codepoint happened to land between.
   *
   * The scan is over the arriving chunk and nothing older, which is the
   * property #749 is about; `includes` short-circuits on the first CR and the
   * overwhelmingly common LF-framed chunk pays one pass and no allocation.
   */
  private normaliseLineEndings(chunk: string): string {
    if (chunk.length === 0) return '';
    const body = this.lastChunkEndedInCarriageReturn && chunk.startsWith('\n')
      ? chunk.slice(1)
      : chunk;
    this.lastChunkEndedInCarriageReturn = chunk.endsWith('\r');
    if (!body.includes('\r')) return body;
    return body.replace(CARRIAGE_RETURN_TERMINATOR, '\n');
  }

  /**
   * The last buffered character, or `''` when nothing is pending — the one
   * character a delimiter can hide behind when it straddles two reads.
   *
   * Read by index rather than `slice`, so it costs nothing on a buffer of any
   * size: the last part is always a chunk or a residual, both already flat.
   */
  private seamCharacter(): string {
    if (this.parts.length === 0) return '';
    const last = this.parts[this.parts.length - 1]!;
    return last[last.length - 1] ?? '';
  }

  /**
   * Materialise the pending characters once and cut every completed block out
   * of them, leaving the trailing partial event as the only part.
   *
   * This is the amortised half of the design and runs only on a read that
   * completed an event: each character is joined into exactly the block that
   * carries it, and what survives the join is bounded by the chunk that
   * arrived — so the total work stays linear in the characters received.  The
   * cut walks a moving start index instead of re-slicing the remainder per
   * block, which would put the quadratic back for a chunk carrying many
   * events.  Emptying {@link SseEventBuffer.parts} rather than leaving an empty
   * residual in it is the other half of the same accounting: it is what keeps
   * the next read's cut a single flat part.  Both are measured, in characters
   * copied, by `tests/unit/io/broker/SseInboundBuffering.test.ts`.
   *
   * The one-element branch of the materialisation is deliberately *not* in that
   * measurement, and cannot be: `['x'].join('')` returns its element, so what
   * the branch saves is a call and not a copy, and a character counter that
   * scored it would be charging for a copy that does not happen.
   */
  private splitCompletedBlocks(): string[] {
    const whole = this.parts.length === 1 ? this.parts[0]! : this.parts.join('');
    const blocks: string[] = [];
    let start = 0;
    let index = whole.indexOf(EVENT_DELIMITER);
    while (index >= 0) {
      blocks.push(whole.slice(start, index));
      start = index + EVENT_DELIMITER.length;
      index = whole.indexOf(EVENT_DELIMITER, start);
    }
    const residual = whole.slice(start);
    this.parts = residual.length === 0 ? [] : [residual];
    this.pending = residual.length;
    return blocks;
  }
}
