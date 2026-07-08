import { describe, expect, test } from 'bun:test';
import { encodeBody, decodeBody } from '../../../src/persistence/object-storage/BodyCodec.js';

// 200 KB of zeros — compresses to a few bytes, decompresses back to 200 KB.
// A real decompression bomb is far worse; the cap logic is what matters.
const big = new Uint8Array(200_000);

// SECURITY_AUDIT.md #3 — decoding a stored body must bound the decompressed
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
