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

  test('NaN and the infinities survive; -0 keeps its sign (#1036)', () => {
    expect(Number.isNaN(rt(NaN))).toBe(true);
    expect(rt(Infinity)).toBe(Infinity);
    expect(rt(-Infinity)).toBe(-Infinity);
    expect(Object.is(rt(-0), -0)).toBe(true);
    expect(Object.is(rt(0), 0)).toBe(true);
    // In an array slot and an object property, not just at the root.
    const nested = rt({ limit: -0, stats: [-0, 0] }) as { limit: number; stats: number[] };
    expect(Object.is(nested.limit, -0)).toBe(true);
    expect(Object.is(nested.stats[0], -0)).toBe(true);
    expect(Object.is(nested.stats[1], 0)).toBe(true);
  });

  test('a plain zero stays a one-byte integer — only -0 pays for the float', () => {
    expect(Array.from(enc.encode(0))).toEqual([0x00]);
    expect(enc.encode(-0).byteLength).toBe(9); // 0xfb + 8 bytes
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

describe('CBOR hostile input', () => {
  /** `tag` (major 6) applied to a byte string of `length` 0xff bytes. */
  function bignumPayload(tag: 2 | 3, length: number): Uint8Array {
    const out = new Uint8Array(1 + 5 + length);
    out[0] = 0xc0 | tag;          // major 6, additional info = tag number
    out[1] = 0x5a;                // major 2 (bytes), 4-byte length follows
    new DataView(out.buffer).setUint32(2, length, false);
    out.fill(0xff, 6);
    return out;
  }

  test('an oversize bignum is rejected instead of decoded (#567)', () => {
    // 200 KB was measured at 5-16 s of blocked event loop before the fix.
    expect(() => dec.decode(bignumPayload(2, 200_000))).toThrow(CborDecodeError);
    expect(() => dec.decode(bignumPayload(3, 200_000))).toThrow(CborDecodeError);
  });

  test('rejecting an oversize bignum is immediate, not merely eventual (#567)', () => {
    // The point of the fix is that the CPU is never spent.  A decoder that
    // still ground through the quadratic loop and threw afterwards would
    // satisfy the test above but not this one.
    const started = performance.now();
    expect(() => dec.decode(bignumPayload(2, 400_000))).toThrow(CborDecodeError);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test('a bignum at the limit still decodes, and linearly (#567)', () => {
    // 1024 bytes = 8192-bit, the documented ceiling.  Guards against a fix
    // that bounds the attack by making legitimate values unreachable.
    const atLimit = bignumPayload(2, 1024);
    const started = performance.now();
    const value = dec.decode(atLimit);
    expect(typeof value).toBe('bigint');
    expect(value).toBe((1n << 8192n) - 1n);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test('nesting deeper than the cap is rejected before the stack blows (#618)', () => {
    // 0x81 = array of one element; 100k of them is a 100k-deep structure.
    const deep = new Uint8Array(100_000).fill(0x81);
    expect(() => dec.decode(deep)).toThrow(CborDecodeError);
  });

  test('ordinary nesting still decodes', () => {
    expect(rt({ a: [{ b: [{ c: 1 }] }] })).toEqual({ a: [{ b: [{ c: 1 }] }] });
  });

  test('a __proto__ map key cannot re-parent the decoded object (#581)', () => {
    // Map of one pair: "__proto__" -> { polluted: true }.
    const payload = new Uint8Array([
      0xa1,                                            // map(1)
      0x69, ...[...'__proto__'].map((c) => c.charCodeAt(0)), // text(9) "__proto__"
      0xa1,                                            // map(1)
      0x68, ...[...'polluted'].map((c) => c.charCodeAt(0)),  // text(8) "polluted"
      0xf5,                                            // true
    ]);

    const decoded = dec.decode(payload) as Record<string, unknown>;

    // The key became a field, not a new prototype.
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(decoded, '__proto__')).toBe(true);
    expect(decoded['__proto__']).toEqual({ polluted: true });
    // And nothing leaked onto every other object in the process.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
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

describe('CBOR encoder limits (#1036)', () => {
  test('a cycle is a CborEncodeError, not a stack overflow', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node['self'] = node;
    expect(() => enc.encode(node)).toThrow(CborEncodeError);

    const list: unknown[] = [1];
    list.push(list);
    expect(() => enc.encode(list)).toThrow(CborEncodeError);
  });

  test('a shared reference is not a cycle — a DAG duplicates, like JSON.stringify', () => {
    const shared = { id: 7 };
    expect(rt({ left: shared, right: shared })).toEqual({ left: { id: 7 }, right: { id: 7 } });
    expect(rt([shared, shared])).toEqual([{ id: 7 }, { id: 7 }]);
  });

  // The encoder used to have no bound at all while the decoder capped at 256,
  // so it could write bytes it could not read back.  Both now measure the
  // same levels.
  test('the encoder refuses what its own decoder would refuse', () => {
    const nest = (levels: number): unknown => {
      let out: unknown = 'leaf';
      for (let i = 0; i < levels; i++) out = [out];
      return out;
    };
    expect(() => enc.encode(nest(200_000))).toThrow(CborEncodeError);
    expect(() => enc.encode(nest(300))).toThrow(CborEncodeError);
    // Just inside the bound: encodes, and decodes back.
    expect(dec.decode(enc.encode(nest(250)))).toEqual(nest(250));
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
