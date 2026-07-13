import { describe, expect, test } from 'bun:test';
import {
  CborDecoder,
  CborDecodeError,
  CborEncodeError,
  CborEncoder,
} from '../../../src/serialization/CborCodec.js';

const enc = new CborEncoder();
const dec = new CborDecoder();

function rt<T>(v: T): T {
  return dec.decode(enc.encode(v)) as T;
}

describe('CBOR integers', () => {
  test('encodes small positive values in a single byte (additional info 0–23)', () => {
    expect(Array.from(enc.encode(0))).toEqual([0x00]);
    expect(Array.from(enc.encode(10))).toEqual([0x0a]);
    expect(Array.from(enc.encode(23))).toEqual([0x17]);
  });

  test('encodes 24…255 with a 1-byte follow-up', () => {
    const bytes = enc.encode(100);
    expect(bytes[0]).toBe(0x18);
    expect(bytes[1]).toBe(100);
  });

  test('round-trips positive, negative, and zero', () => {
    for (const bignum of [0, 1, 23, 24, 255, 256, 65535, 65536, 2 ** 30, -1, -24, -100, -65536]) {
      expect(rt(bignum)).toBe(bignum);
    }
  });

  test('round-trips near-MAX_SAFE_INTEGER', () => {
    expect(rt(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(rt(-Number.MAX_SAFE_INTEGER)).toBe(-Number.MAX_SAFE_INTEGER);
  });
});

describe('CBOR floats', () => {
  test('round-trips doubles', () => {
    expect(rt(3.14)).toBeCloseTo(3.14);
    expect(rt(-0.5)).toBeCloseTo(-0.5);
    expect(rt(Math.PI)).toBeCloseTo(Math.PI);
  });

  test('decodes half-precision floats', () => {
    // 0xf9 = major 7 | 25 (half float).  Value 0x3c00 = 1.0
    const bytes = new Uint8Array([0xf9, 0x3c, 0x00]);
    expect(dec.decode(bytes)).toBeCloseTo(1.0);
  });

  test('decodes single-precision floats', () => {
    // 0xfa = major 7 | 26 (single float).  0x40490fdb ≈ π
    const bytes = new Uint8Array([0xfa, 0x40, 0x49, 0x0f, 0xdb]);
    expect(dec.decode(bytes) as number).toBeCloseTo(Math.PI, 4);
  });
});

describe('CBOR strings & byte strings', () => {
  test('round-trips empty and non-empty strings', () => {
    expect(rt('')).toBe('');
    expect(rt('hello')).toBe('hello');
    expect(rt('äöüß→™')).toBe('äöüß→™'); // UTF-8
  });

  test('round-trips Uint8Array values', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 255]);
    const restored = rt(bytes);
    expect(restored).toBeInstanceOf(Uint8Array);
    expect(Array.from(restored as Uint8Array)).toEqual([0, 1, 2, 3, 255]);
  });
});

describe('CBOR arrays & maps', () => {
  test('round-trips arrays of mixed primitives', () => {
    expect(rt([1, 'two', true, null, 3.14])).toEqual([1, 'two', true, null, 3.14]);
  });

  test('round-trips nested objects', () => {
    expect(rt({ a: { bytes: { c: [1, 2, { date: 'x' }] } } }))
      .toEqual({ a: { bytes: { c: [1, 2, { date: 'x' }] } } });
  });

  test('empty array and empty object', () => {
    expect(rt([])).toEqual([]);
    expect(rt({})).toEqual({});
  });
});

describe('CBOR booleans, null, undefined', () => {
  test('round-trips true / false / null', () => {
    expect(rt(true)).toBe(true);
    expect(rt(false)).toBe(false);
    expect(rt(null)).toBe(null);
  });

  test('undefined encodes as null', () => {
    // Encoder writes null for undefined (simple value 22).
    expect(rt(undefined)).toBeNull();
  });
});

describe('CBOR Date (tag 1)', () => {
  test('round-trips a Date', () => {
    const date = new Date('2024-03-15T10:20:30.456Z');
    const restored = rt(date);
    expect(restored).toBeInstanceOf(Date);
    expect((restored as Date).getTime()).toBe(date.getTime());
  });
});

describe('CBOR BigInt (tags 2 / 3)', () => {
  test('round-trips positive bigint', () => {
    const bignum = 12345678901234567890n;
    const out = rt(bignum);
    expect(typeof out).toBe('bigint');
    expect(out).toBe(bignum);
  });

  test('round-trips negative bigint', () => {
    const bignum = -98765432109876543210n;
    expect(rt(bignum)).toBe(bignum);
  });

  test('round-trips zero bigint', () => {
    expect(rt(0n)).toBe(0n);
  });
});

describe('CBOR error paths', () => {
  test('decoder rejects trailing bytes', () => {
    // Encode one value, append an extra byte.
    const bytes = enc.encode(1);
    const padded = new Uint8Array(bytes.byteLength + 1);
    padded.set(bytes, 0);
    padded[bytes.byteLength] = 0xff;
    expect(() => dec.decode(padded)).toThrow(CborDecodeError);
  });

  test('decoder rejects truncated input', () => {
    // 0x19 = major 0 | 25 (2-byte length follows) with nothing after.
    expect(() => dec.decode(new Uint8Array([0x19]))).toThrow(CborDecodeError);
  });

  test('encoder rejects unsupported types (functions, symbols)', () => {
    expect(() => enc.encode(Symbol('x') as unknown)).toThrow(CborEncodeError);
  });
});

describe('CBOR byte-level compactness', () => {
  test('small ints fit in 1 byte', () => {
    expect(enc.encode(5).byteLength).toBe(1);
  });

  test('short strings fit in header + content', () => {
    expect(enc.encode('hi').byteLength).toBe(3); // 1 header + 2 chars
  });
});
