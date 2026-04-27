import { describe, expect, test } from 'bun:test';
import {
  ATS1_MAGIC,
  COMPRESSION_GZIP,
  COMPRESSION_NONE,
  COMPRESSION_ZSTD,
  decodeBody,
  encodeBody,
} from '../../../../src/persistence/object-storage/BodyCodec.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('BodyCodec — manifest header', () => {
  test('encoded body starts with the ATS1 magic', async () => {
    const encoded = await encodeBody(utf8('{"a":1}'));
    expect(encoded[0]).toBe(ATS1_MAGIC[0]);
    expect(encoded[1]).toBe(ATS1_MAGIC[1]);
    expect(encoded[2]).toBe(ATS1_MAGIC[2]);
    expect(encoded[3]).toBe(ATS1_MAGIC[3]);
  });

  test('flags byte reflects the compression algorithm', async () => {
    const none = await encodeBody(utf8('x'), { compression: 'none' });
    expect(none[4]! & 0b11).toBe(COMPRESSION_NONE);

    const gzip = await encodeBody(utf8('x'), { compression: 'gzip' });
    expect(gzip[4]! & 0b11).toBe(COMPRESSION_GZIP);

    const zstd = await encodeBody(utf8('x'), { compression: 'zstd' });
    expect(zstd[4]! & 0b11).toBe(COMPRESSION_ZSTD);
  });

  test('decode rejects bodies without ATS1 magic', async () => {
    const bogus = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]);
    await expect(decodeBody(bogus)).rejects.toThrow(/ATS1 magic/);
  });

  test('decode rejects bodies shorter than the header', async () => {
    await expect(decodeBody(new Uint8Array([0x41, 0x54]))).rejects.toThrow();
  });
});

describe('BodyCodec — compression round-trip', () => {
  const sample = JSON.stringify({
    user: 'alice',
    orders: Array.from({ length: 50 }, (_, i) => ({ id: i, amount: i * 17 })),
  });

  test('none — plaintext round-trips byte-for-byte', async () => {
    const encoded = await encodeBody(utf8(sample), { compression: 'none' });
    const decoded = await decodeBody(encoded);
    expect(decoded.compression).toBe('none');
    expect(decoded.encrypted).toBe(false);
    expect(fromUtf8(decoded.payload)).toBe(sample);
  });

  test('gzip — round-trips and the framed body is shorter than plaintext+header for non-trivial input', async () => {
    const plain = utf8(sample);
    const encoded = await encodeBody(plain, { compression: 'gzip' });
    const decoded = await decodeBody(encoded);
    expect(decoded.compression).toBe('gzip');
    expect(fromUtf8(decoded.payload)).toBe(sample);
    expect(encoded.length).toBeLessThan(plain.length);
  });

  test('zstd — round-trips on this runtime', async () => {
    const plain = utf8(sample);
    const encoded = await encodeBody(plain, { compression: 'zstd' });
    const decoded = await decodeBody(encoded);
    expect(decoded.compression).toBe('zstd');
    expect(fromUtf8(decoded.payload)).toBe(sample);
  });
});

describe('BodyCodec — encryption round-trip', () => {
  const subKey = new Uint8Array(32).fill(7);

  test('round-trips encrypted+gzipped bodies and the body bytes are NOT plaintext', async () => {
    const plain = utf8(JSON.stringify({ secret: 'attack-at-dawn' }));
    const framed = await encodeBody(plain, { compression: 'gzip', encryption: { subKey } });
    expect(framed[4]! & 0b100).toBe(0b100);                  // encrypted flag set
    expect(framed[4]! & 0b011).toBe(COMPRESSION_GZIP);
    const asString = new TextDecoder('utf-8', { fatal: false }).decode(framed);
    expect(asString.includes('attack-at-dawn')).toBe(false); // ciphertext, not plaintext
    const decoded = await decodeBody(framed, { encryption: { subKey } });
    expect(decoded.encrypted).toBe(true);
    expect(fromUtf8(decoded.payload)).toBe(fromUtf8(plain));
  });

  test('decode rejects when the supplied subkey is wrong (auth-tag mismatch)', async () => {
    const framed = await encodeBody(utf8('hi'), { encryption: { subKey } });
    const wrongKey = new Uint8Array(32).fill(8);
    await expect(decodeBody(framed, { encryption: { subKey: wrongKey } })).rejects.toThrow();
  });

  test('decode rejects encrypted bodies when no subKey is supplied', async () => {
    const framed = await encodeBody(utf8('hi'), { encryption: { subKey } });
    await expect(decodeBody(framed)).rejects.toThrow(/no subKey/);
  });

  test('decode rejects encrypted bodies that are too short to contain an IV', async () => {
    const fake = new Uint8Array([...ATS1_MAGIC, 0b100]); // header + flag, no IV
    await expect(decodeBody(fake, { encryption: { subKey } })).rejects.toThrow(/IV/);
  });
});
