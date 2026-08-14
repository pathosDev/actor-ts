import { describe, expect, test } from 'bun:test';
import { encodeBody, decodeBody } from '../../../src/persistence/object-storage/BodyCodec.js';
import { compressorFor } from '../../../src/persistence/object-storage/Compression.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { ObjectStorageSnapshotStoreOptionsValidator } from '../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import { ObjectStorageDurableStateStoreOptionsValidator } from '../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStoreOptions.js';

// 200 KB of zeros — compresses to a few bytes, decompresses back to 200 KB.
// A real decompression bomb is far worse; the cap logic is what matters.
const big = new Uint8Array(200_000);

/**
 * The two cap mechanisms are told apart by the TAIL of the message, never by
 * whether they throw — an over-cap read fails either way, which is why a bare
 * `.rejects.toThrow()` cannot see the difference between refusing a bomb and
 * decoding it in full and then complaining (#580).
 */
const ABORTED_BEFORE_ALLOCATION = /maxOutputBytes=\d+ \(aborted before the output was allocated\)/;
const MEASURED_AFTER_DECODING = /maxOutputBytes=\d+ \(got \d+\)/;

// security audit #3 — decoding a stored body must bound the decompressed
// size, so a tampered/hostile compressed blob can't OOM the process on read.
describe('BodyCodec — decompression cap (#3)', () => {
  test('gzip: decoding past maxOutputBytes throws', async () => {
    const framed = await encodeBody(big, { compression: 'gzip' });
    await expect(decodeBody(framed, { maxOutputBytes: 1024 }))
      .rejects.toThrow(ABORTED_BEFORE_ALLOCATION);
  });

  test('gzip: decoding within the cap succeeds', async () => {
    const framed = await encodeBody(big, { compression: 'gzip' });
    const out = await decodeBody(framed, { maxOutputBytes: 1_000_000 });
    expect(out.payload.length).toBe(big.length);
  });

  test('an uncompressed body over the cap is rejected', async () => {
    const framed = await encodeBody(big, { compression: 'none' });
    // `none` has nothing to abort — the bytes are already in hand, so this is
    // the one path that legitimately reports a measured size.
    await expect(decodeBody(framed, { maxOutputBytes: 1024 }))
      .rejects.toThrow(MEASURED_AFTER_DECODING);
  });

  test('the default cap admits normal-sized bodies', async () => {
    const framed = await encodeBody(big, { compression: 'gzip' });
    const out = await decodeBody(framed);   // default 512 MiB
    expect(out.payload.length).toBe(big.length);
  });

  test('maxOutputBytes: Infinity opts out of the cap', async () => {
    const framed = await encodeBody(big, { compression: 'none' });
    const out = await decodeBody(framed, { maxOutputBytes: Infinity });
    expect(out.payload.length).toBe(big.length);
  });
});

/**
 * #580 — the zstd cap used to be a post-mortem.  `zstdCompressor.decompress`
 * called an implementation that takes no options, so the full output was
 * materialised and only the finished buffer's length was compared against the
 * cap: a 9.6 KB stored object bought a 300 MB allocation, which is the bomb
 * working as designed, with a complaint filed afterwards.
 *
 * The fix is a resolver preference, not a frame parser — `node:zlib` is
 * chosen ahead of `Bun.zstdDecompressSync` because it is the only zstd
 * implementation on any supported runtime that takes `maxOutputLength`.  So
 * what these pin is the MECHANISM, not just the rejection: the message tail
 * (see the two matchers above) is the only observable that separates "refused
 * before allocating" from "allocated, then refused", and reverting the
 * resolver order flips every one of them to `(got …)` while a plain
 * `.rejects.toThrow()` would stay green throughout.
 */
describe('BodyCodec — zstd decompression cap (#580)', () => {
  test('a zstd bomb is refused before its output is allocated', async () => {
    // 64 MiB of zeros → a ~2 KB frame.  The ratio is what makes it a bomb;
    // the cap has to act on the frame's declared output, not on its size.
    const bomb = await encodeBody(new Uint8Array(64 * 1024 * 1024), { compression: 'zstd' });
    expect(bomb.length).toBeLessThan(64 * 1024);
    await expect(decodeBody(bomb, { maxOutputBytes: 1024 }))
      .rejects.toThrow(ABORTED_BEFORE_ALLOCATION);
  });

  test('zstd: decoding past maxOutputBytes throws', async () => {
    const framed = await encodeBody(big, { compression: 'zstd' });
    await expect(decodeBody(framed, { maxOutputBytes: 1024 }))
      .rejects.toThrow(ABORTED_BEFORE_ALLOCATION);
  });

  test('zstd: decoding within the cap succeeds', async () => {
    const framed = await encodeBody(big, { compression: 'zstd' });
    const out = await decodeBody(framed, { maxOutputBytes: 1_000_000 });
    expect(out.payload.length).toBe(big.length);
  });

  test('zstd: the default cap admits normal-sized bodies', async () => {
    const framed = await encodeBody(big, { compression: 'zstd' });
    const out = await decodeBody(framed);   // default 512 MiB
    expect(out.payload.length).toBe(big.length);
  });

  test('zstd: maxOutputBytes Infinity opts out of the cap', async () => {
    const framed = await encodeBody(big, { compression: 'zstd' });
    const out = await decodeBody(framed, { maxOutputBytes: Infinity });
    expect(out.payload.length).toBe(big.length);
  });

  // Two mechanisms now enforce one option, so they have to agree on where the
  // edge is — otherwise the same cap admits a body through one algorithm and
  // rejects it through another, and the difference is invisible until an
  // operator hits it in production.  The cap is inclusive: output == cap is in.
  test('the cap is inclusive, and gzip and zstd put the edge in the same place', async () => {
    const payload = new Uint8Array(4096);
    for (const compression of ['gzip', 'zstd'] as const) {
      const framed = await encodeBody(payload, { compression });
      const atCap = await decodeBody(framed, { maxOutputBytes: payload.length });
      expect(atCap.payload.length).toBe(payload.length);
      await expect(decodeBody(framed, { maxOutputBytes: payload.length - 1 }))
        .rejects.toThrow(ABORTED_BEFORE_ALLOCATION);
    }
  });

  // The compressor is reached directly here: `decodeBody` always passes a cap
  // (its own 512 MiB default), so it cannot exercise the no-cap call at all.
  test('an omitted cap decompresses normally rather than being treated as zero', async () => {
    const zstd = compressorFor('zstd');
    const out = await zstd.decompress(await zstd.compress(big));
    expect(out.length).toBe(big.length);
  });
});

// The object-storage stores expose the cap as `maxDecompressedBytes` and
// validate it at construction; a bad value throws OptionsError, Infinity opts
// out.  (End-to-end pass-through to decodeBody is covered in the store
// integration tests.)
describe('object-storage store options — maxDecompressedBytes validation', () => {
  test('snapshot store: rejects a non-positive / non-integer cap; Infinity ok', () => {
    const validator = new ObjectStorageSnapshotStoreOptionsValidator();
    expect(() => validator.validate({ maxDecompressedBytes: 0 })).toThrow(OptionsError);
    expect(() => validator.validate({ maxDecompressedBytes: -1 })).toThrow(/maxDecompressedBytes/);
    expect(() => validator.validate({ maxDecompressedBytes: 2.5 })).toThrow(/maxDecompressedBytes/);
    expect(() => validator.validate({ maxDecompressedBytes: Infinity })).not.toThrow();
    expect(() => validator.validate({ maxDecompressedBytes: 1_048_576 })).not.toThrow();
  });

  test('durable-state store: same rule', () => {
    const validator = new ObjectStorageDurableStateStoreOptionsValidator();
    expect(() => validator.validate({ maxDecompressedBytes: 0 })).toThrow(/maxDecompressedBytes/);
    expect(() => validator.validate({ maxDecompressedBytes: Infinity })).not.toThrow();
  });
});
