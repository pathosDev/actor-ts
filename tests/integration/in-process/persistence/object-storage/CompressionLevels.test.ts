import { afterEach, describe, expect, test } from 'bun:test';
import {
  compressorFor,
  probeCompressionAvailability,
  resetCompressionCache,
} from '../../../../../src/persistence/object-storage/Compression.js';
import {
  COMPRESSION_ZSTD,
  decodeBody,
  encodeBody,
} from '../../../../../src/persistence/object-storage/BodyCodec.js';

/**
 * Compression-level threading (gzip 0–9, zstd 1–22) + level-change
 * semantics.  These run on Bun, which has native zstd
 * (`Bun.zstdCompressSync`) — so the compress path is exercised for real.
 *
 * Key invariants under test:
 *   - the level reaches the underlying compressor (a bad options object
 *     would throw; a valid one round-trips),
 *   - higher level never produces a larger body on compressible data,
 *   - decode needs NO level (the manifest records only the algorithm),
 *   - so a level change requires no migration — a body written at level X
 *     still decodes after the configured level moves to Y.
 */

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

// Highly-but-not-trivially compressible payload — repeated structure with
// small per-row variation, so the compressor has real redundancy to find.
const PAYLOAD = JSON.stringify({
  items: Array.from({ length: 3000 }, (_, i) => ({
    id: i,
    name: `item-${i % 50}`,
    tag: 'alpha beta gamma delta',
    note: 'the quick brown fox jumps over the lazy dog',
  })),
});
const PAYLOAD_BYTES = utf8(PAYLOAD);

afterEach(() => {
  // Each test gets a clean lazy cache so a future runtime-probe test can't
  // leak a memoised impl across cases.
  resetCompressionCache();
});

describe('Compression levels — zstd', () => {
  test('compresses + round-trips at low and high levels', async () => {
    const zstdCompressor = compressorFor('zstd');
    for (const level of [1, 3, 9, 19]) {
      const compressed = await zstdCompressor.compress(PAYLOAD_BYTES, level);
      expect(compressed.length).toBeLessThan(PAYLOAD_BYTES.length);
      const back = await zstdCompressor.decompress(compressed);
      expect(fromUtf8(back)).toBe(PAYLOAD);
    }
  });

  test('higher level never yields a larger body than a lower one', async () => {
    const zstdCompressor = compressorFor('zstd');
    const low = await zstdCompressor.compress(PAYLOAD_BYTES, 1);
    const high = await zstdCompressor.compress(PAYLOAD_BYTES, 19);
    expect(high.length).toBeLessThanOrEqual(low.length);
  });

  test('out-of-range level is clamped, not rejected', async () => {
    const zstdCompressor = compressorFor('zstd');
    // 999 → clamps to 22, -5 → clamps to 1; both must still round-trip.
    for (const level of [999, -5]) {
      const compressed = await zstdCompressor.compress(PAYLOAD_BYTES, level);
      const back = await zstdCompressor.decompress(compressed);
      expect(fromUtf8(back)).toBe(PAYLOAD);
    }
  });

  test('undefined level uses the impl default and round-trips', async () => {
    const zstdCompressor = compressorFor('zstd');
    const compressed = await zstdCompressor.compress(PAYLOAD_BYTES);
    expect(fromUtf8(await zstdCompressor.decompress(compressed))).toBe(PAYLOAD);
  });
});

describe('Compression levels — gzip', () => {
  test('compresses + round-trips across the 0–9 range', async () => {
    const gzipCompressor = compressorFor('gzip');
    for (const level of [0, 1, 6, 9]) {
      const compressed = await gzipCompressor.compress(PAYLOAD_BYTES, level);
      const back = await gzipCompressor.decompress(compressed);
      expect(fromUtf8(back)).toBe(PAYLOAD);
    }
  });

  test('higher level never yields a larger body than a lower one', async () => {
    const gzipCompressor = compressorFor('gzip');
    const low = await gzipCompressor.compress(PAYLOAD_BYTES, 1);
    const high = await gzipCompressor.compress(PAYLOAD_BYTES, 9);
    expect(high.length).toBeLessThanOrEqual(low.length);
  });
});

describe('Compression levels — wire format + level change', () => {
  test('level is NOT recorded on the wire (manifest = algorithm only)', async () => {
    const lo = await encodeBody(PAYLOAD_BYTES, { compression: 'zstd', compressionLevel: 1 });
    const hi = await encodeBody(PAYLOAD_BYTES, { compression: 'zstd', compressionLevel: 19 });
    // Same algorithm bits in the flags byte regardless of level.
    expect(lo[4]! & 0b11).toBe(COMPRESSION_ZSTD);
    expect(hi[4]! & 0b11).toBe(COMPRESSION_ZSTD);
  });

  test('a body written at one level decodes after the level changes', async () => {
    // Simulate: bucket has an old body written at level 1; the deployment
    // later bumps the configured level to 19.  Decode carries no level and
    // must still recover both bodies — no migration needed.
    const oldBody = await encodeBody(PAYLOAD_BYTES, { compression: 'zstd', compressionLevel: 1 });
    const newBody = await encodeBody(PAYLOAD_BYTES, { compression: 'zstd', compressionLevel: 19 });

    expect(fromUtf8((await decodeBody(oldBody)).payload)).toBe(PAYLOAD);
    expect(fromUtf8((await decodeBody(newBody)).payload)).toBe(PAYLOAD);
  });

  test('gzip body with an explicit level decodes transparently', async () => {
    const body = await encodeBody(PAYLOAD_BYTES, { compression: 'gzip', compressionLevel: 9 });
    expect(fromUtf8((await decodeBody(body)).payload)).toBe(PAYLOAD);
  });
});

describe('Compression availability probe', () => {
  test('zstd compress path is available on this (native) runtime', async () => {
    await expect(probeCompressionAvailability('zstd')).resolves.toBeUndefined();
  });

  test('gzip + none are always available', async () => {
    await expect(probeCompressionAvailability('gzip')).resolves.toBeUndefined();
    await expect(probeCompressionAvailability('none')).resolves.toBeUndefined();
  });
});
