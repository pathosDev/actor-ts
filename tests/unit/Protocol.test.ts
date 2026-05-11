import { describe, expect, test } from 'bun:test';
import { FrameDecoder, encodeFrame, type WireMessage } from '../../src/cluster/Protocol.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';

const sampleHello: WireMessage = {
  t: 'hello',
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
});

describe('FrameDecoder', () => {
  test('decodes a single complete frame', () => {
    const d = new FrameDecoder();
    const frames = d.push(encodeFrame(sampleHello));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(sampleHello);
  });

  test('decodes multiple frames in a single chunk', () => {
    const hb: WireMessage = {
      t: 'heartbeat',
      from: new NodeAddress('demo', 'h', 1).toJSON(),
      seq: 7,
      ts: 1_700_000_000,
    };
    const combined = new Uint8Array(
      encodeFrame(sampleHello).byteLength + encodeFrame(hb).byteLength,
    );
    combined.set(encodeFrame(sampleHello), 0);
    combined.set(encodeFrame(hb), encodeFrame(sampleHello).byteLength);
    const d = new FrameDecoder();
    const frames = d.push(combined);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(sampleHello);
    expect(frames[1]).toEqual(hb);
  });

  test('buffers partial frames across pushes (byte-at-a-time feed)', () => {
    const frame = encodeFrame(sampleHello);
    const d = new FrameDecoder();
    let out: WireMessage[] = [];
    for (let i = 0; i < frame.byteLength; i++) {
      out = out.concat(d.push(frame.subarray(i, i + 1)));
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(sampleHello);
  });

  test('returns frames only when header says the full payload is available', () => {
    const frame = encodeFrame(sampleHello);
    const d = new FrameDecoder();
    // Feed only the 4-byte header
    expect(d.push(frame.subarray(0, 4))).toEqual([]);
    // Feed everything except the last byte
    expect(d.push(frame.subarray(4, frame.byteLength - 1))).toEqual([]);
    // Feed the last byte — frame completes
    const finalFrames = d.push(frame.subarray(frame.byteLength - 1));
    expect(finalFrames).toHaveLength(1);
    expect(finalFrames[0]).toEqual(sampleHello);
  });

  test('throws on invalid JSON payload', () => {
    // Construct a frame with a 4-byte length prefix followed by invalid JSON.
    const badJson = new TextEncoder().encode('not-json{');
    const frame = new Uint8Array(4 + badJson.byteLength);
    new DataView(frame.buffer).setUint32(0, badJson.byteLength, false);
    frame.set(badJson, 4);
    const d = new FrameDecoder();
    expect(() => d.push(frame)).toThrow(/Invalid wire frame JSON/);
  });

  test('empty push produces no frames and does not error', () => {
    const d = new FrameDecoder();
    expect(d.push(new Uint8Array(0))).toEqual([]);
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
      const d = new FrameDecoder();
      const evil = new Uint8Array(4);
      // Claim a 4-GiB frame — far above the default 16-MiB cap.
      new DataView(evil.buffer).setUint32(0, 0xFFFFFFFF, false);
      expect(() => d.push(evil)).toThrow(/maxFrameBytes/);
    });

    test('exploit: 1-GiB-claim header alone (no payload sent) is still rejected', () => {
      // The crucial property: rejection happens before any payload
      // arrives, so the attacker can't slowly leak memory by sending
      // the header then nothing.
      const d = new FrameDecoder();
      const evil = new Uint8Array(4);
      new DataView(evil.buffer).setUint32(0, 1024 * 1024 * 1024, false);
      expect(() => d.push(evil)).toThrow(/maxFrameBytes/);
    });

    test('cap is configurable — smaller caps reject smaller frames', () => {
      const d = new FrameDecoder(1024); // 1 KiB cap
      const headerOnly = new Uint8Array(4);
      new DataView(headerOnly.buffer).setUint32(0, 2048, false); // 2 KiB claim
      expect(() => d.push(headerOnly)).toThrow(/maxFrameBytes 1024/);
    });

    test('cap is configurable — larger caps allow larger frames', () => {
      const big = 'x'.repeat(200_000); // ~200 KB JSON
      const payload = JSON.stringify({ t: 'envelope', to: 'foo', from: null, body: big });
      const bytes = new TextEncoder().encode(payload);
      const frame = new Uint8Array(4 + bytes.byteLength);
      new DataView(frame.buffer).setUint32(0, bytes.byteLength, false);
      frame.set(bytes, 4);

      // Default 16-MiB cap is enough.
      const d = new FrameDecoder();
      const out = d.push(frame);
      expect(out).toHaveLength(1);
    });

    test('legitimate small frames still decode after the cap is in place', () => {
      // Regression guard: the cap must not break normal traffic.
      const d = new FrameDecoder();
      const frames = d.push(encodeFrame(sampleHello));
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

  test('round-trips each wire message variant', () => {
    const variants: WireMessage[] = [
      { t: 'hello', self: new NodeAddress('s', 'h', 1).toJSON() },
      { t: 'hello-ack', self: new NodeAddress('s', 'h', 1).toJSON() },
      {
        t: 'heartbeat',
        from: new NodeAddress('s', 'h', 1).toJSON(),
        seq: 42,
        ts: 1_700_000_000,
      },
      {
        t: 'heartbeat-ack',
        from: new NodeAddress('s', 'h', 1).toJSON(),
        seq: 42,
      },
      {
        t: 'gossip',
        from: new NodeAddress('s', 'h', 1).toJSON(),
        members: [
          { address: new NodeAddress('s', 'h', 1).toJSON(), status: 'up', version: 3, roles: ['backend'] },
        ],
      },
      { t: 'envelope', to: 'path', from: null, body: { hello: 'world' } },
      { t: 'envelope', to: 'path', from: 'sender', body: 'str', tag: 'Str' },
      { t: 'leave', node: new NodeAddress('s', 'h', 1).toJSON() },
      {
        t: 'shard-map',
        type: 'counter',
        shards: { 0: new NodeAddress('s', 'h', 1).toJSON() },
        version: 1,
      },
    ];
    for (const v of variants) {
      const d = new FrameDecoder();
      const out = d.push(encodeFrame(v));
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual(v);
    }
  });
});
