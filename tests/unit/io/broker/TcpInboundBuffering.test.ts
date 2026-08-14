/**
 * What one inbound chunk *costs* the TCP actors (#610).
 *
 * The extractor half of #610 — resuming the delimiter search where the last
 * chunk stopped — landed already and is covered by `TcpFrameExtraction.test.ts`.
 * This file covers the other half, which did not: the buffer the chunk is
 * appended to.  Re-allocating it per chunk copies everything buffered so far,
 * which is O(N²) over a delimiter-free stream no matter how cheap the scan
 * got, and the cap that bounds the stream is sized in mebibytes.
 *
 * **Why bytes copied and not milliseconds.**  A wall-clock budget for a copy
 * loop is a flake generator: it moves with the machine, the runtime and
 * whatever else the CI box is doing.  The quantity the defect is actually
 * about is bytes moved, and that is exactly measurable — every copy a
 * `Uint8Array` performs goes through `set` / `copyWithin` / `slice`, so
 * wrapping those three counts it with no timing involved.  The budget below
 * is over-generous on purpose: the point is the difference between "a small
 * multiple of what arrived" and "a multiple of the chunk count", which is
 * three orders of magnitude here, not a tight constant.
 */
import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { TCP_INITIAL_INBOUND_BUFFER_BYTES } from '../../../../src/io/Constants.js';
import { TcpInboundBuffer } from '../../../../src/io/broker/TcpInboundBuffer.js';
import { TcpSocketActor } from '../../../../src/io/broker/TcpSocketActor.js';
import type { TcpSocketOptionsType } from '../../../../src/io/broker/TcpSocketOptions.js';

/**
 * A socket actor with resolved options but no system, no socket and no start.
 *
 * `BrokerActor.options` throws before `preStart`, and starting the actor would
 * mean a real connection — so the resolved settings are supplied by overriding
 * the accessor.  That is the whole seam: `handleData` is the method the
 * socket's `'data'` listener calls, and it is what these tests drive.
 */
class ProbeSocketActor extends TcpSocketActor {
  private readonly resolved: TcpSocketOptionsType;

  constructor(resolved: TcpSocketOptionsType) {
    super(resolved);
    this.resolved = resolved;
  }

  protected override get options(): TcpSocketOptionsType {
    return this.resolved;
  }

  /** One inbound chunk, exactly as the socket's `'data'` listener delivers it. */
  feed(chunk: Uint8Array): void {
    (this as unknown as { handleData(chunk: Uint8Array): void }).handleData(chunk);
  }
}

/** Collects what the actor pushes at its `target`, without an ActorSystem. */
function collectingTarget(received: unknown[]): ActorRef<unknown> {
  return { tell: (message: unknown) => { received.push(message); } } as unknown as ActorRef<unknown>;
}

/**
 * Bytes copied through the `Uint8Array` copy primitives while `body` runs.
 *
 * The patch is installed and removed around a **synchronous** body, so no
 * other code can observe the wrapped prototype: nothing interleaves with a
 * synchronous loop, and the `finally` restores the originals even if the body
 * throws.
 */
function countCopiedBytes(body: () => void): number {
  const prototype = Uint8Array.prototype;
  const originalSet = prototype.set;
  const originalCopyWithin = prototype.copyWithin;
  const originalSlice = prototype.slice;
  let copied = 0;
  prototype.set = function (this: Uint8Array, source: ArrayLike<number>, offset?: number): void {
    copied += source.length;
    originalSet.call(this, source, offset);
  };
  prototype.copyWithin = function (
    this: Uint8Array, target: number, start: number, end?: number,
  ): Uint8Array {
    copied += Math.max(0, Math.min(end ?? this.length, this.length) - Math.max(start, 0));
    return originalCopyWithin.call(this, target, start, end);
  };
  prototype.slice = function (this: Uint8Array, start?: number, end?: number): Uint8Array {
    const result = originalSlice.call(this, start, end);
    copied += result.length;
    return result;
  };
  try {
    body();
  } finally {
    prototype.set = originalSet;
    prototype.copyWithin = originalCopyWithin;
    prototype.slice = originalSlice;
  }
  return copied;
}

const CHUNK_BYTES = 64;
const CHUNK_COUNT = 4_096;
const STREAM_BYTES = CHUNK_BYTES * CHUNK_COUNT;   // 256 KiB, well under the 1 MiB cap

describe('TcpSocketActor — what a delimiter-free stream costs (#610)', () => {
  test('buffering is linear in the bytes received, not quadratic', () => {
    // 256 KiB of delimiter-free bytes in 64-byte chunks — a peer that never
    // terminates a line, staying inside the default 1 MiB `maxLineLen` the
    // whole way, so nothing here is a cap breach.  Appending by re-allocating
    // copies the whole pending buffer per chunk: 64 * (0+1+…+4095) bytes, i.e.
    // ~512 MiB moved to receive 256 KiB.  A buffer grown by doubling copies
    // each byte in once plus the handful of growths.
    const received: unknown[] = [];
    const actor = new ProbeSocketActor({
      framing: { kind: 'lines' },
      target: collectingTarget(received),
    });
    const chunk = new Uint8Array(CHUNK_BYTES).fill(0x78);   // 'x'

    const copied = countCopiedBytes(() => {
      for (let sent = 0; sent < CHUNK_COUNT; sent++) actor.feed(chunk);
    });

    // No frame can have completed — there is no delimiter in the stream.
    expect(received).toEqual([]);
    // Sanity floor: every byte has to be copied into the buffer at least once,
    // so a counter that observed nothing would fail here rather than pass the
    // budget below vacuously.
    expect(copied).toBeGreaterThanOrEqual(STREAM_BYTES);
    // The budget.  Linear buffering lands near 2x (one copy in, plus the
    // doubling growths — measured at 1.97x); the quadratic append was 2048x.
    expect(copied).toBeLessThanOrEqual(STREAM_BYTES * 6);
  });

  test('and the bytes it buffered still frame correctly afterwards', () => {
    // The other half of the same claim: cheaper must not mean lossy.  Same
    // stream, terminated — one line of exactly the bytes that were sent, in
    // order, delivered once.
    const received: unknown[] = [];
    const actor = new ProbeSocketActor({
      framing: { kind: 'lines' },
      target: collectingTarget(received),
    });
    for (let sent = 0; sent < CHUNK_COUNT; sent++) {
      actor.feed(new Uint8Array(CHUNK_BYTES).fill(0x78));
    }
    expect(received).toEqual([]);
    actor.feed(new TextEncoder().encode('\n'));

    expect(received).toEqual(['x'.repeat(STREAM_BYTES)]);
  });
});

/** The slab is private; its size is the only way to pin the two bounds on it. */
const slabBytesOf = (buffer: TcpInboundBuffer): number =>
  (buffer as unknown as { slab: Uint8Array }).slab.byteLength;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** `[uint32 big-endian length][payload]`, the wire shape `length-prefixed` reads. */
function lengthPrefixed(payload: string): Uint8Array {
  const body = encode(payload);
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, false);
  frame.set(body, 4);
  return frame;
}

describe('TcpInboundBuffer', () => {
  test('accumulates chunks in order, whatever the boundaries', () => {
    const buffer = new TcpInboundBuffer();
    const framing = { kind: 'lines' } as const;
    for (const part of ['ab', 'cd', 'ef']) {
      expect(buffer.push(encode(part), framing).frames).toEqual([]);
    }
    expect(buffer.pendingBytes()).toBe(6);
    expect(buffer.push(encode('gh\n'), framing).frames).toEqual(['abcdefgh']);
    expect(buffer.pendingBytes()).toBe(0);
  });

  test('bytes framing is handed straight through, unbuffered and uncopied', () => {
    // The strategy that frames nothing must not go near the slab: the frame it
    // yields is the chunk itself, and a view into a slab the next chunk
    // overwrites would corrupt whatever the subscriber still holds.
    const buffer = new TcpInboundBuffer();
    const chunk = encode('anything');
    const extraction = buffer.push(chunk, { kind: 'bytes' });
    expect(extraction.frames).toEqual([chunk]);
    expect(extraction.frames[0]).toBe(chunk);   // same reference: no copy at all
    expect(buffer.pendingBytes()).toBe(0);
    expect(slabBytesOf(buffer)).toBe(0);        // and nothing was ever allocated
  });

  test('a delivered frame is a copy, not a window onto the slab', () => {
    // The hazard the slab introduces: a frame handed to a subscriber outlives
    // the pass that produced it, and the bytes behind it get overwritten by
    // the next chunk.  Only `bytes` may alias, and it aliases the chunk.
    const buffer = new TcpInboundBuffer();
    const framing = { kind: 'length-prefixed' } as const;
    const first = buffer.push(lengthPrefixed('alpha'), framing).frames[0] as Uint8Array;
    expect(decode(first)).toBe('alpha');

    for (let more = 0; more < 64; more++) buffer.push(lengthPrefixed('zzzzz'), framing);
    expect(decode(first)).toBe('alpha');
  });

  test('a long-lived connection compacts in place instead of growing', () => {
    // Steady state for a line protocol: every chunk completes a line and
    // leaves a partial one behind, so the read cursor marches up the slab
    // forever.  Without compaction it would reallocate once it hit the end.
    const buffer = new TcpInboundBuffer();
    const framing = { kind: 'lines', maxLineLen: 1_024 } as const;
    const chunk = encode(`${'x'.repeat(50)}\n${'y'.repeat(49)}`);
    buffer.push(chunk, framing);
    const settled = slabBytesOf(buffer);
    expect(settled).toBeLessThanOrEqual(TCP_INITIAL_INBOUND_BUFFER_BYTES);

    let frames = 1;
    for (let sent = 0; sent < 1_000; sent++) {
      const extraction = buffer.push(chunk, framing);
      expect(extraction.overflow).toBeUndefined();
      frames += extraction.frames.length;
    }
    expect(frames).toBe(1_001);
    // Exactly the slab it allocated on the first chunk, 100 KB of traffic
    // later: the cursor wrapped by compaction, never by reallocating.
    expect(slabBytesOf(buffer)).toBe(settled);
    expect(buffer.pendingBytes()).toBe(49);
    // And the bytes that survived all that compaction are still the right ones.
    expect(buffer.push(encode('\n'), framing).frames).toEqual(['y'.repeat(49)]);
  });

  test('a large frame does not pin its buffer once it has drained', () => {
    // A slab is as large as the biggest frame it ever held, so without the
    // release one oversized line would keep that much memory per connection
    // until the peer hangs up.
    const buffer = new TcpInboundBuffer();
    const framing = { kind: 'lines' } as const;
    expect(buffer.push(encode(`${'z'.repeat(200_000)}\n`), framing).frames).toHaveLength(1);
    expect(slabBytesOf(buffer)).toBe(0);
    // And it still frames afterwards — releasing must not leave a broken
    // buffer behind.
    expect(buffer.push(encode('after\n'), framing).frames).toEqual(['after']);
  });

  test('clear forgets the bytes, the slab and the scan position', () => {
    const buffer = new TcpInboundBuffer();
    const framing = { kind: 'lines' } as const;
    buffer.push(encode('abc'), framing);
    expect(buffer.pendingBytes()).toBe(3);

    buffer.clear();
    expect(buffer.pendingBytes()).toBe(0);
    expect(slabBytesOf(buffer)).toBe(0);
    // Not 'abcde': the dropped connection's bytes must not splice onto the
    // next one's (#578).
    expect(buffer.push(encode('de\n'), framing).frames).toEqual(['de']);
  });

  test('an over-long line leaves the buffer untouched for the caller to drop', () => {
    // The overflow contract: the pass reports the breach and consumes nothing,
    // because the caller's answer is to drop the connection, not to resume.
    const buffer = new TcpInboundBuffer();
    const framing = { kind: 'lines', maxLineLen: 8 } as const;
    const extraction = buffer.push(encode('x'.repeat(32)), framing);
    expect(extraction.overflow).toMatch(/unterminated line/);
    expect(extraction.consumed).toBe(0);
    expect(buffer.pendingBytes()).toBe(32);

    buffer.clear();
    expect(buffer.pendingBytes()).toBe(0);
  });
});
