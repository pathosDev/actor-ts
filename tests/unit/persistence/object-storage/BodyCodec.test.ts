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

/* ===================== #8 — master-key rotation ====================== */

describe('BodyCodec — versioned encryption (#8)', () => {
  const subKeyV0 = new Uint8Array(32).fill(0xa0);
  const subKeyV1 = new Uint8Array(32).fill(0xa1);
  const subKeyV2 = new Uint8Array(32).fill(0xa2);

  test('encoder embeds the key-version byte when keyVersion is supplied', async () => {
    const framed = await encodeBody(utf8('payload'), {
      encryption: { subKey: subKeyV1, keyVersion: 1 },
    });
    expect(framed[4]! & 0b1100).toBe(0b1100);   // FLAG_ENCRYPTED + FLAG_KEY_VERSIONED
    expect(framed[5]).toBe(1);                  // version byte right after flags
  });

  test('legacy single-key bodies round-trip through the resolver path (treated as version 0)', async () => {
    // Legacy = no keyVersion stamped at encode time.
    const framed = await encodeBody(utf8('legacy'), { encryption: { subKey: subKeyV0 } });
    expect(framed[4]! & 0b1000).toBe(0);        // FLAG_KEY_VERSIONED unset

    // Decode via a resolver that maps v0 → subKeyV0 — succeeds.
    const decoded = await decodeBody(framed, {
      encryption: {
        subKeyFor: async (v) => v === 0 ? subKeyV0 : null,
      },
    });
    expect(decoded.keyVersion).toBeUndefined();
    expect(fromUtf8(decoded.payload)).toBe('legacy');
  });

  test('round-trip with a keyring resolver: version-1 body is decrypted by the v1 key', async () => {
    const framed = await encodeBody(utf8('rotated'), {
      encryption: { subKey: subKeyV1, keyVersion: 1 },
    });
    const decoded = await decodeBody(framed, {
      encryption: {
        subKeyFor: async (v) => v === 0 ? subKeyV0 : v === 1 ? subKeyV1 : null,
      },
    });
    expect(decoded.keyVersion).toBe(1);
    expect(fromUtf8(decoded.payload)).toBe('rotated');
  });

  test('reading a v0 body after rotation uses the retired v0 key', async () => {
    // Simulate: written under v0, then we rotated.  Resolver still has v0 in retired.
    const framed = await encodeBody(utf8('historical'), {
      encryption: { subKey: subKeyV0, keyVersion: 0 },
    });
    const decoded = await decodeBody(framed, {
      encryption: {
        subKeyFor: async (v) => v === 0 ? subKeyV0 : v === 1 ? subKeyV1 : null,
      },
    });
    expect(decoded.keyVersion).toBe(0);
    expect(fromUtf8(decoded.payload)).toBe('historical');
  });

  test('resolver returning null for the requested version surfaces a clear error', async () => {
    const framed = await encodeBody(utf8('orphaned'), {
      encryption: { subKey: subKeyV2, keyVersion: 2 },
    });
    await expect(decodeBody(framed, {
      encryption: {
        subKeyFor: async (_v) => null,
      },
    })).rejects.toThrow(/no master key registered for version 2/);
  });

  test('encoder rejects out-of-range key versions', async () => {
    await expect(encodeBody(utf8('x'), {
      encryption: { subKey: subKeyV1, keyVersion: -1 },
    })).rejects.toThrow(/keyVersion/);
    await expect(encodeBody(utf8('x'), {
      encryption: { subKey: subKeyV1, keyVersion: 256 },
    })).rejects.toThrow(/keyVersion/);
    await expect(encodeBody(utf8('x'), {
      encryption: { subKey: subKeyV1, keyVersion: 1.5 },
    })).rejects.toThrow(/keyVersion/);
  });
});
