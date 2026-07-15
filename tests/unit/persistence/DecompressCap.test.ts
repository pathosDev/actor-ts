import { describe, expect, test } from 'bun:test';
import { encodeBody, decodeBody } from '../../../src/persistence/object-storage/BodyCodec.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { ObjectStorageSnapshotStoreOptionsValidator } from '../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import { ObjectStorageDurableStateStoreOptionsValidator } from '../../../src/persistence/durable-state-stores/ObjectStorageDurableStateStoreOptions.js';

// 200 KB of zeros — compresses to a few bytes, decompresses back to 200 KB.
// A real decompression bomb is far worse; the cap logic is what matters.
const big = new Uint8Array(200_000);

// security audit #3 — decoding a stored body must bound the decompressed
// size, so a tampered/hostile compressed blob can't OOM the process on read.
describe('BodyCodec — decompression cap (#3)', () => {
  test('gzip: decoding past maxOutputBytes throws', async () => {
    const framed = await encodeBody(big, { compression: 'gzip' });
    await expect(decodeBody(framed, { maxOutputBytes: 1024 })).rejects.toThrow();
  });

  test('gzip: decoding within the cap succeeds', async () => {
    const framed = await encodeBody(big, { compression: 'gzip' });
    const out = await decodeBody(framed, { maxOutputBytes: 1_000_000 });
    expect(out.payload.length).toBe(big.length);
  });

  test('an uncompressed body over the cap is rejected', async () => {
    const framed = await encodeBody(big, { compression: 'none' });
    await expect(decodeBody(framed, { maxOutputBytes: 1024 })).rejects.toThrow(/maxOutputBytes/);
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
