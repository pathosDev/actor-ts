/**
 * The inbound byte buffer both TCP actors accumulate partial frames in — one
 * instance per connection, holding the bytes that have arrived but not yet
 * completed a frame.
 *
 * **Why this is not a `Uint8Array` field plus a concat helper.**  It was, and
 * that was the second half of #610: appending by allocating
 * `pending + chunk.length` and copying both in moves every buffered byte again
 * for every chunk, which is O(N²) over a peer that never completes a frame.
 * Resuming the delimiter search where the last chunk stopped (the first half,
 * in `extractLineFrames`) removed the scan from that loop but not the copy,
 * and the copy was the larger share of it: 256 KiB delivered in 64-byte
 * chunks moved ~512 MiB.  Under a `maxLineLen` sized in mebibytes — a cap the
 * docs call a DoS limit — that is seconds of blocked event loop a peer can ask
 * for without ever breaching the cap.
 *
 * So the bytes go into a slab grown by doubling, with a read cursor: a
 * consumed frame advances the cursor instead of re-allocating, and the space
 * it leaves is reclaimed by the next compaction.  Each byte is copied in once,
 * plus the handful of growths.  This is the same shape `FrameDecoder`
 * (`src/cluster/Protocol.ts`) grew for the identical defect on the cluster
 * path (#588) — deliberately re-implemented rather than shared, because a
 * common helper would couple two subsystems that buffer different wire formats
 * for different peers.
 *
 * The extractors stay pure functions over a window of bytes; what lives here
 * is only the ownership of that window.
 */
import {
  TCP_INITIAL_INBOUND_BUFFER_BYTES,
  TCP_RETAINED_INBOUND_BUFFER_BYTES,
} from '../Constants.js';
import {
  DEFAULT_MAX_FRAME_LENGTH,
  DEFAULT_MAX_LINE_LENGTH,
  extractFrames,
} from './TcpFraming.js';
import type { FrameExtraction, TcpFraming } from './TcpFraming.js';

export class TcpInboundBuffer {
  /**
   * Bytes received and not yet framed live in `slab[readOffset, writeOffset)`.
   * The two cursors are what remove the per-chunk copy: a completed frame
   * advances `readOffset` instead of reallocating the leftover.
   */
  private slab: Uint8Array = new Uint8Array(0);
  private readOffset = 0;
  private writeOffset = 0;
  /**
   * How far into the pending window the delimiter search already reached,
   * **relative to `readOffset`** — so it survives a compaction untouched, and
   * is exactly what {@link extractFrames} takes as its `scanFrom`.
   */
  private scanOffset = 0;

  /**
   * Bytes of a frame this buffer is still holding — zero when it has drained
   * exactly on a frame boundary.
   */
  pendingBytes(): number {
    return this.writeOffset - this.readOffset;
  }

  /**
   * Take one inbound chunk and run `framing` over everything pending.
   *
   * `framing` is per call rather than per instance because that is where the
   * actors read it: the three-layer options merge resolves in `preStart`, and
   * both callers already pass `this.options.framing` on every chunk.
   *
   * The returned {@link FrameExtraction} is for the caller's frames and its
   * `overflow`; the buffer has already applied the rest to itself.  A breached
   * cap leaves the bytes where they are — the caller's half of that contract
   * is to drop the connection, which ends in {@link clear}.
   */
  push(chunk: Uint8Array, framing: TcpFraming): FrameExtraction {
    // `bytes` frames nothing, so buffering it would be pure overhead — and
    // worse than that: the frame handed over would be a view into the slab,
    // which the next chunk overwrites underneath whoever is still holding it.
    // Every other strategy hands out copies (a decoded string, a sliced
    // payload), so this is the one case that has to bypass the slab.  The
    // chunk *is* the whole pending window then: nothing was ever written to
    // the slab under this strategy, so there is nothing in front of it.
    if (framing.kind === 'bytes') return extractFrames(chunk, framing);
    this.append(chunk, pendingCeilingBytes(framing));
    const extraction = extractFrames(this.pending(), framing, this.scanOffset);
    if (extraction.overflow === undefined) {
      this.take(extraction.consumed, extraction.scanFrom ?? 0);
    }
    return extraction;
  }

  /**
   * Forget every pending byte and release the slab — the connection holding
   * them is gone, and a connection dropped for breaching a cap is by
   * definition holding the largest buffer of the lot (#578).
   */
  clear(): void {
    this.slab = new Uint8Array(0);
    this.readOffset = 0;
    this.writeOffset = 0;
    this.scanOffset = 0;
  }

  /* --------------------------- buffer management --------------------------- */

  /** The pending window — a view, valid only until the next mutation. */
  private pending(): Uint8Array {
    return this.slab.subarray(this.readOffset, this.writeOffset);
  }

  private append(chunk: Uint8Array, ceilingBytes: number): void {
    if (chunk.byteLength === 0) return;
    this.makeRoomFor(chunk.byteLength, ceilingBytes);
    this.slab.set(chunk, this.writeOffset);
    this.writeOffset += chunk.byteLength;
  }

  /**
   * Make `extra` bytes fit after {@link writeOffset}, compacting in place when
   * the slab is merely fragmented and growing only when it is genuinely too
   * small.
   *
   * **Sized from what arrived, never from what was claimed.**  A
   * `length-prefixed` header announces its payload, and allocating that the
   * moment it is read would re-open the vector the frame cap closes: a peer
   * claims just under `maxFrameLen`, sends no payload at all, and holds the
   * whole cap per connection for free.  Doubling off received bytes gives the
   * same amortised cost with the resident size bounded by what the peer
   * actually paid to send.
   *
   * `ceilingBytes` is where doubling stops: rounding a slab that already holds
   * a whole frame up to the next power of two would double the per-connection
   * ceiling the framing caps exist to bound, so above one frame the slab is
   * sized to fit rather than to the next step.
   */
  private makeRoomFor(extra: number, ceilingBytes: number): void {
    if (this.writeOffset + extra <= this.slab.byteLength) return;
    const pending = this.pendingBytes();
    const needed = pending + extra;
    if (needed <= this.slab.byteLength) {
      // The slab is big enough — the free space is just at the wrong end.
      this.slab.copyWithin(0, this.readOffset, this.writeOffset);
    } else {
      let capacity = Math.max(this.slab.byteLength, TCP_INITIAL_INBOUND_BUFFER_BYTES);
      while (capacity < needed) capacity *= 2;
      this.slab = replaceSlab(
        this.slab, this.readOffset, this.writeOffset, Math.min(capacity, Math.max(needed, ceilingBytes)),
      );
    }
    // Both branches moved the pending window to offset 0.  `scanOffset` is
    // relative to it, so it needs no adjustment.
    this.readOffset = 0;
    this.writeOffset = pending;
  }

  /**
   * Drop the `consumed` bytes the pass framed and remember how far its scan
   * reached, handing a large slab back once nothing is left in it.
   *
   * Without that release a slab is as large as the biggest frame it ever had
   * to hold, so one oversized frame pins that much memory per connection until
   * the peer disconnects.  Ordinary traffic never trips it: the buffer settles
   * at {@link TCP_INITIAL_INBOUND_BUFFER_BYTES}, well under the retention
   * bound, and is reused for the life of the connection.
   */
  private take(consumed: number, scanFrom: number): void {
    this.readOffset += consumed;
    this.scanOffset = scanFrom;
    if (this.readOffset !== this.writeOffset) return;
    this.readOffset = 0;
    this.writeOffset = 0;
    this.scanOffset = 0;
    if (this.slab.byteLength > TCP_RETAINED_INBOUND_BUFFER_BYTES) this.slab = new Uint8Array(0);
  }
}

/** Move `[start, end)` of `slab` into a fresh buffer of `capacity` bytes. */
function replaceSlab(slab: Uint8Array, start: number, end: number, capacity: number): Uint8Array {
  const grown = new Uint8Array(capacity);
  grown.set(slab.subarray(start, end), 0);
  return grown;
}

/**
 * The largest pending window `framing` can legitimately reach — its own size
 * cap, since the extractor reports an overflow rather than buffering past it.
 *
 * Only an upper bound on *useful* growth, never a limit on correctness: a
 * window that has to hold more than this still gets exactly the room it needs
 * (`Math.max(needed, …)` in {@link TcpInboundBuffer.makeRoomFor}), it just
 * stops being rounded up.
 */
function pendingCeilingBytes(framing: TcpFraming): number {
  if (framing.kind === 'lines') return framing.maxLineLen ?? DEFAULT_MAX_LINE_LENGTH;
  if (framing.kind === 'length-prefixed') return framing.maxFrameLen ?? DEFAULT_MAX_FRAME_LENGTH;
  return 0;
}
