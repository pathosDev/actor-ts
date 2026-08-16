import { describe, expect, test } from 'bun:test';
import { FrameDecoder, encodeFrame, type WireMessage } from '../../src/cluster/Protocol.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';

const sampleHello: WireMessage = {
  kind: 'hello',
  self: new NodeAddress('demo', '127.0.0.1', 9001).toJSON(),
};

describe('encodeFrame', () => {
  test('prefixes the payload with big-endian u32 length', () => {
    const frame = encodeFrame(sampleHello);
    expect(frame.byteLength).toBeGreaterThanOrEqual(4);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const declaredLen = view.getUint32(0, false);
    expect(declaredLen).toBe(frame.byteLength - 4);
  });

  test('payload decodes to the original JSON', () => {
    const frame = encodeFrame(sampleHello);
    const payload = frame.subarray(4);
    const json = new TextDecoder().decode(payload);
    expect(JSON.parse(json)).toEqual(sampleHello);
  });

  /**
   * #450 — the frame is a *tagged* JSON tree now, the same format the
   * persistence stores write.  The two properties that matter are that a
   * payload made of plain data is untouched (so a mixed-version cluster sees
   * identical bytes for everything that was not already broken) and that a
   * payload made of the types plain JSON corrupts survives instead.
   */
  describe('tagged-tree framing', () => {
    test('a plain payload encodes to the same bytes JSON.stringify produced', () => {
      const frames: WireMessage[] = [
        sampleHello,
        { kind: 'heartbeat', from: new NodeAddress('s', 'h', 1).toJSON(), seq: 3, ts: 1_700_000_000 },
        { kind: 'envelope', to: '/user/x', from: null, body: { n: 1, list: [1, 'two', true, null] } },
      ];
      for (const frame of frames) {
        const encoded = new TextDecoder().decode(encodeFrame(frame).subarray(4));
        expect(encoded).toBe(JSON.stringify(frame));
      }
    });

    test('the types plain JSON corrupts round-trip through the frame codec', () => {
      const body = {
        byName: new Map<string, number>([['a', 1]]),
        seen: new Set<number>([1, 2]),
        when: new Date('2026-08-15T10:20:30.400Z'),
        bytes: new Uint8Array([1, 2, 3]),
        balance: 42n,
        nan: Number.NaN,
      };
      const decoder = new FrameDecoder();
      const out = decoder.push(encodeFrame({ kind: 'envelope', to: 'x', from: null, body }));
      expect(out).toHaveLength(1);
      const arrived = (out[0] as { body: typeof body }).body;
      expect([...arrived.byName]).toEqual([['a', 1]]);
      expect([...arrived.seen]).toEqual([1, 2]);
      expect(arrived.when.getTime()).toBe(body.when.getTime());
      expect([...arrived.bytes]).toEqual([1, 2, 3]);
      expect(arrived.balance).toBe(42n);
      expect(Number.isNaN(arrived.nan)).toBe(true);
    });

    test('a malformed tag is reported as a payload problem, not a JSON one', () => {
      // Well-formed JSON that a hostile peer could send; the decoder has to
      // answer it the way it answers any other unusable frame — by throwing,
      // which the transport turns into a closed connection.
      const payload = new TextEncoder().encode(
        JSON.stringify({ kind: 'envelope', to: 'x', from: null, body: { __date__: 42 } }),
      );
      const frame = new Uint8Array(4 + payload.byteLength);
      new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
      frame.set(payload, 4);
      expect(() => new FrameDecoder().push(frame)).toThrow(/Invalid wire frame payload/);
    });
  });
});

describe('FrameDecoder', () => {
  test('decodes a single complete frame', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame(sampleHello));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(sampleHello);
  });

  test('decodes multiple frames in a single chunk', () => {
    const hb: WireMessage = {
      kind: 'heartbeat',
      from: new NodeAddress('demo', 'h', 1).toJSON(),
      seq: 7,
      ts: 1_700_000_000,
    };
    const combined = new Uint8Array(
      encodeFrame(sampleHello).byteLength + encodeFrame(hb).byteLength,
    );
    combined.set(encodeFrame(sampleHello), 0);
    combined.set(encodeFrame(hb), encodeFrame(sampleHello).byteLength);
    const decoder = new FrameDecoder();
    const frames = decoder.push(combined);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(sampleHello);
    expect(frames[1]).toEqual(hb);
  });

  test('buffers partial frames across pushes (byte-at-a-time feed)', () => {
    const frame = encodeFrame(sampleHello);
    const decoder = new FrameDecoder();
    let out: WireMessage[] = [];
    for (let i = 0; i < frame.byteLength; i++) {
      out = out.concat(decoder.push(frame.subarray(i, i + 1)));
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(sampleHello);
  });

  test('returns frames only when header says the full payload is available', () => {
    const frame = encodeFrame(sampleHello);
    const decoder = new FrameDecoder();
    // Feed only the 4-byte header
    expect(decoder.push(frame.subarray(0, 4))).toEqual([]);
    // Feed everything except the last byte
    expect(decoder.push(frame.subarray(4, frame.byteLength - 1))).toEqual([]);
    // Feed the last byte — frame completes
    const finalFrames = decoder.push(frame.subarray(frame.byteLength - 1));
    expect(finalFrames).toHaveLength(1);
    expect(finalFrames[0]).toEqual(sampleHello);
  });

  test('throws on invalid JSON payload', () => {
    // Construct a frame with a 4-byte length prefix followed by invalid JSON.
    const badJson = new TextEncoder().encode('not-json{');
    const frame = new Uint8Array(4 + badJson.byteLength);
    new DataView(frame.buffer).setUint32(0, badJson.byteLength, false);
    frame.set(badJson, 4);
    const decoder = new FrameDecoder();
    expect(() => decoder.push(frame)).toThrow(/Invalid wire frame JSON/);
  });

  test('empty push produces no frames and does not error', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(new Uint8Array(0))).toEqual([]);
  });

  /* ------------------------- security: oversized-frame DoS ------------------------- */

  describe('security — oversized frame rejection', () => {
    /**
     * **Exploit walkthrough** (pre-fix, would have caused OOM/DoS):
     *
     * A malicious peer sends a frame whose 4-byte big-endian length-
     * prefix claims `0xFFFFFFFF` (≈ 4 GiB).  The old decoder would
     * buffer subsequent bytes up to that claimed length — either
     * exhausting RAM if the attacker actually streams 4 GiB, or
     * stalling forever waiting for the rest (effective per-connection
     * DoS).  Cap added in {@link FrameDecoder} (default 16 MiB) so
     * the decoder throws before allocating anything.
     */
    test('exploit: oversized length-prefix claim is rejected immediately', () => {
      const decoder = new FrameDecoder();
      const evil = new Uint8Array(4);
      // Claim a 4-GiB frame — far above the default 16-MiB cap.
      new DataView(evil.buffer).setUint32(0, 0xFFFFFFFF, false);
      expect(() => decoder.push(evil)).toThrow(/maxFrameBytes/);
    });

    test('exploit: 1-GiB-claim header alone (no payload sent) is still rejected', () => {
      // The crucial property: rejection happens before any payload
      // arrives, so the attacker can't slowly leak memory by sending
      // the header then nothing.
      const decoder = new FrameDecoder();
      const evil = new Uint8Array(4);
      new DataView(evil.buffer).setUint32(0, 1024 * 1024 * 1024, false);
      expect(() => decoder.push(evil)).toThrow(/maxFrameBytes/);
    });

    test('cap is configurable — smaller caps reject smaller frames', () => {
      const decoder = new FrameDecoder(1024); // 1 KiB cap
      const headerOnly = new Uint8Array(4);
      new DataView(headerOnly.buffer).setUint32(0, 2048, false); // 2 KiB claim
      expect(() => decoder.push(headerOnly)).toThrow(/maxFrameBytes 1024/);
    });

    test('cap is configurable — larger caps allow larger frames', () => {
      const big = 'x'.repeat(200_000); // ~200 KB JSON
      const payload = JSON.stringify({ kind: 'envelope', to: 'foo', from: null, body: big });
      const bytes = new TextEncoder().encode(payload);
      const frame = new Uint8Array(4 + bytes.byteLength);
      new DataView(frame.buffer).setUint32(0, bytes.byteLength, false);
      frame.set(bytes, 4);

      // Default 16-MiB cap is enough.
      const decoder = new FrameDecoder();
      const out = decoder.push(frame);
      expect(out).toHaveLength(1);
    });

    test('legitimate small frames still decode after the cap is in place', () => {
      // Regression guard: the cap must not break normal traffic.
      const decoder = new FrameDecoder();
      const frames = decoder.push(encodeFrame(sampleHello));
      expect(frames).toHaveLength(1);
      expect(frames[0]).toEqual(sampleHello);
    });

    test('invalid cap configuration is rejected', () => {
      expect(() => new FrameDecoder(0)).toThrow(/positive integer/);
      expect(() => new FrameDecoder(-1)).toThrow(/positive integer/);
      expect(() => new FrameDecoder(Number.NaN)).toThrow(/positive integer/);
      expect(() => new FrameDecoder(Number.POSITIVE_INFINITY)).toThrow(/positive integer/);
    });
  });

  /* ---------------- security: attacker-chosen chunking cost ---------------- */

  /**
   * **Exploit walkthrough (pre-fix, #588).**  `push` began with
   * `buffer = concat(buffer, chunk)`, which allocates a full-size array and
   * copies everything received so far — on *every* chunk.  The peer picks how a
   * frame is split, so a frame just under the 16 MiB cap delivered in
   * TCP-sized ~1400-byte writes is ~12 000 chunks and ≈ 100 GB of memcpy: an
   * amplification of roughly 6000× on bytes the attacker never had to send.
   * The decoder runs before the `hello` gate, so no membership was needed.
   *
   * The property under test is **cost**, not correctness — the byte-at-a-time
   * feed above already covers correctness and passed before the fix too.  It is
   * asserted as bytes copied rather than as elapsed time, because a wall-clock
   * assertion on a shared CI runner is a flake generator.
   */
  describe('security — decode cost is linear in the bytes received', () => {
    /**
     * Total bytes the decoder's buffer management moves while a frame arrives
     * in `chunkBytes`-sized pieces, measured by counting what `Uint8Array.set`
     * and `copyWithin` are asked to move.
     */
    function bytesCopiedFeeding(payloadBytes: number, chunkBytes: number): number {
      const payload = new TextEncoder().encode(
        JSON.stringify({ kind: 'envelope', to: 'x', from: null, body: 'y'.repeat(payloadBytes) }),
      );
      const frame = new Uint8Array(4 + payload.byteLength);
      new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
      frame.set(payload, 4);

      const realSet = Uint8Array.prototype.set;
      const realCopyWithin = Uint8Array.prototype.copyWithin;
      let copied = 0;
      Uint8Array.prototype.set = function (
        this: Uint8Array, source: ArrayLike<number>, offset?: number,
      ): void {
        copied += source.length;
        realSet.call(this, source, offset);
      };
      Uint8Array.prototype.copyWithin = function (
        this: Uint8Array, target: number, start: number, end?: number,
      ): Uint8Array {
        copied += (end ?? this.length) - start;
        return realCopyWithin.call(this, target, start, end);
      };
      try {
        const decoder = new FrameDecoder();
        let decoded = 0;
        for (let offset = 0; offset < frame.byteLength; offset += chunkBytes) {
          decoded += decoder.push(frame.subarray(offset, offset + chunkBytes)).length;
        }
        expect(decoded).toBe(1);
      } finally {
        Uint8Array.prototype.set = realSet;
        Uint8Array.prototype.copyWithin = realCopyWithin;
      }
      return copied;
    }

    test('exploit: chunking a large frame does not multiply the work to assemble it', () => {
      const payloadBytes = 512 * 1024;
      const copied = bytesCopiedFeeding(payloadBytes, 1_400);
      // Each byte is copied once on arrival plus once per doubling it lives
      // through, so a constant multiple of the frame — measured at ~3x here.
      // Pre-fix this was N²/2 x chunk ≈ 98 MB for this size, ~190x the bound.
      expect(copied).toBeLessThan(payloadBytes * 4);
    });

    test('the amplification does not grow when the attacker halves the chunk size', () => {
      // The signature of a quadratic cost: halving the chunk size doubles the
      // chunk count and quadruples the work.  Linear buffering is flat.
      const payloadBytes = 256 * 1024;
      const coarse = bytesCopiedFeeding(payloadBytes, 2_800);
      const fine = bytesCopiedFeeding(payloadBytes, 1_400);
      expect(fine).toBeLessThan(coarse * 1.5);
    });

    test('a frame arriving whole costs one copy of itself', () => {
      // The regression side: the slab must not make the ordinary case — one
      // complete frame per chunk — any more expensive than it was.
      const payloadBytes = 64 * 1024;
      const copied = bytesCopiedFeeding(payloadBytes, payloadBytes * 2);
      expect(copied).toBeLessThan(payloadBytes * 2);
    });
  });

  describe('pendingBytes — what the transport keys its stall deadline on', () => {
    test('is zero between frames and non-zero mid-frame', () => {
      const frame = encodeFrame(sampleHello);
      const decoder = new FrameDecoder();
      expect(decoder.pendingBytes()).toBe(0);

      decoder.push(frame.subarray(0, frame.byteLength - 1));
      expect(decoder.pendingBytes()).toBe(frame.byteLength - 1);

      decoder.push(frame.subarray(frame.byteLength - 1));
      expect(decoder.pendingBytes()).toBe(0);
    });

    test('counts only the trailing partial frame, not the ones already yielded', () => {
      const whole = encodeFrame(sampleHello);
      const combined = new Uint8Array(whole.byteLength + 3);
      combined.set(whole, 0);
      combined.set(whole.subarray(0, 3), whole.byteLength);

      const decoder = new FrameDecoder();
      expect(decoder.push(combined)).toHaveLength(1);
      expect(decoder.pendingBytes()).toBe(3);
    });
  });

  test('a large frame does not pin its buffer once it has been decoded', () => {
    // A slab is as large as the biggest frame it ever held, so without the
    // reclaim step one oversized envelope keeps that much memory per
    // connection until the peer disconnects (#588).
    const body = 'z'.repeat(400_000);
    const decoder = new FrameDecoder();
    expect(decoder.push(encodeFrame({ kind: 'envelope', to: 'x', from: null, body }))).toHaveLength(1);

    const slabBytes = (decoder as unknown as { slab: Uint8Array }).slab.byteLength;
    expect(slabBytes).toBeLessThan(100_000);
    // And it still decodes afterwards — reclaiming must not leave a broken
    // buffer behind.
    expect(decoder.push(encodeFrame(sampleHello))).toHaveLength(1);
  });

  test('round-trips each wire message variant', () => {
    const variants: WireMessage[] = [
      { kind: 'hello', self: new NodeAddress('s', 'h', 1).toJSON() },
      { kind: 'hello-ack', self: new NodeAddress('s', 'h', 1).toJSON() },
      {
        kind: 'heartbeat',
        from: new NodeAddress('s', 'h', 1).toJSON(),
        seq: 42,
        ts: 1_700_000_000,
      },
      {
        kind: 'heartbeat-ack',
        from: new NodeAddress('s', 'h', 1).toJSON(),
        seq: 42,
      },
      {
        kind: 'gossip',
        from: new NodeAddress('s', 'h', 1).toJSON(),
        sequence: 1_700_000_000_001,
        members: [
          { address: new NodeAddress('s', 'h', 1).toJSON(), status: 'up', version: 3, roles: ['backend'] },
        ],
      },
      { kind: 'envelope', to: 'path', from: null, body: { hello: 'world' } },
      { kind: 'envelope', to: 'path', from: 'sender', body: 'str', tag: 'Str' },
      { kind: 'leave', node: new NodeAddress('s', 'h', 1).toJSON() },
      {
        kind: 'shard-map',
        type: 'counter',
        shards: { 0: new NodeAddress('s', 'h', 1).toJSON() },
        version: 1,
      },
    ];
    for (const v of variants) {
      const decoder = new FrameDecoder();
      const out = decoder.push(encodeFrame(v));
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual(v);
    }
  });
});
