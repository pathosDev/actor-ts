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
 * Same defect and same shape as `TcpInboundBuffer` (#610) on the byte side,
 * deliberately not shared with it: that one owns a `Uint8Array` slab framed by
 * a pluggable strategy, this one owns decoded characters split on a fixed
 * delimiter, and a common helper would couple two wire formats that have
 * nothing but the complexity class in common.
 */

/**
 * The blank line that terminates one SSE event block.  Wire vocabulary of the
 * format parsed beside it, not a tuned value.
 */
const EVENT_DELIMITER = '\n\n';

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
   * seam it lands on and not against anything older.
   */
  push(chunk: string): string[] {
    if (chunk.length === 0) return [];
    const seam = this.seamCharacter();
    const carriesDelimiter = (seam + chunk).indexOf(EVENT_DELIMITER) >= 0;
    this.parts.push(chunk);
    this.pending += chunk.length;
    return carriesDelimiter ? this.splitCompletedBlocks() : [];
  }

  /* ----------------------------- internals ----------------------------- */

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
   * events.
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
