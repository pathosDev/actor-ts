import { describe, expect, test } from 'bun:test';
import {
  CborDecoder,
  CborDecodeError,
  CborEncodeError,
  CborEncoder,
} from '../../../src/serialization/CborCodec.js';
import { BidirectionalMap } from '../../../src/util/BidirectionalMap.js';

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

  test('undefined round-trips as CBOR simple value 23, distinct from null (#1036)', () => {
    expect(Array.from(enc.encode(undefined))).toEqual([0xf7]);
    expect(rt(undefined)).toBeUndefined();
    expect(rt(null)).toBeNull();
  });

  // Unlike the JSON tree, which drops the key under its 'omit' policy and
  // throws under 'reject'.  CBOR keeps it: the key is already present today
  // (with the wrong value), and skipping an entry mid-loop would falsify the
  // already-written map header and corrupt the stream rather than lose a key.
  test('an undefined object property keeps its key', () => {
    const decoded = rt({ a: undefined, b: 1 }) as Record<string, unknown>;
    expect('a' in decoded).toBe(true);
    expect(decoded['a']).toBeUndefined();
    expect(decoded['b']).toBe(1);
  });

  test('undefined survives in array slots', () => {
    const decoded = rt([1, undefined, 3]) as unknown[];
    expect(decoded.length).toBe(3);
    expect(decoded[1]).toBeUndefined();
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

  // All three used to reach the generic object branch, where `Object.entries`
  // is `[]` — they were stored as `{}` with nothing to say they had ever been
  // anything else (#1036).
  test('encoder refuses Promise, WeakMap and WeakSet instead of storing {}', () => {
    expect(() => enc.encode(Promise.resolve(1))).toThrow(CborEncodeError);
    expect(() => enc.encode(new WeakMap())).toThrow(CborEncodeError);
    expect(() => enc.encode(new WeakSet())).toThrow(CborEncodeError);
    expect(() => enc.encode({ pending: Promise.resolve(1) })).toThrow(CborEncodeError);
  });

  test('wrapper objects unwrap to their primitive, like JSON.stringify', () => {
    expect(rt(new Number(42) as unknown)).toBe(42);
    expect(rt(new String('ab') as unknown)).toBe('ab');
    expect(rt(new Boolean(true) as unknown)).toBe(true);
  });
});

describe('CBOR Map and Set (tags 259 / 258, #1036)', () => {
  test('a Map round-trips as a Map, with its entries', () => {
    const source = new Map<string, unknown>([['ada', 1], ['grace', { rank: 2 }]]);
    const decoded = rt(source);
    expect(decoded).toBeInstanceOf(Map);
    expect(decoded.size).toBe(2);
    expect(decoded.get('ada')).toBe(1);
    expect(decoded.get('grace')).toEqual({ rank: 2 });
  });

  test('a Set round-trips as a Set, with its members', () => {
    const decoded = rt(new Set([1, 'two', { three: true }]));
    expect(decoded).toBeInstanceOf(Set);
    expect(decoded.size).toBe(3);
    expect([...decoded]).toEqual([1, 'two', { three: true }]);
  });

  test('empty collections survive', () => {
    expect(rt(new Map())).toBeInstanceOf(Map);
    expect(rt(new Map()).size).toBe(0);
    expect(rt(new Set())).toBeInstanceOf(Set);
    expect(rt(new Set()).size).toBe(0);
  });

  // The reason `Map` is tagged at all: a bare major-5 map is what a plain
  // object writes, so the two would be indistinguishable coming back.
  test('a plain object still decodes as a plain object, not a Map', () => {
    const decoded = rt({ ada: 1 });
    expect(decoded).not.toBeInstanceOf(Map);
    expect(decoded).toEqual({ ada: 1 });
  });

  test('Map keys are not restricted to strings', () => {
    const source = new Map<unknown, unknown>([
      [1, 'number key'],
      [new Date('2024-01-01T00:00:00Z'), 'date key'],
      [{ nested: true }, 'object key'],
    ]);
    const decoded = rt(source);
    expect(decoded.get(1)).toBe('number key');
    const keys = [...decoded.keys()];
    expect(keys[1]).toBeInstanceOf(Date);
    expect(keys[2]).toEqual({ nested: true });
  });

  test('rich types survive on both sides of an entry, and nest', () => {
    const source = new Map<unknown, unknown>([
      ['when', new Date('2024-06-01T12:00:00Z')],
      ['big', 2n ** 70n],
      ['inner', new Set([new Map([['deep', 1]])])],
    ]);
    const decoded = rt(source);
    expect(decoded.get('when')).toBeInstanceOf(Date);
    expect(decoded.get('big')).toBe(2n ** 70n);
    const inner = decoded.get('inner') as Set<Map<string, number>>;
    expect(inner).toBeInstanceOf(Set);
    expect([...inner][0]).toBeInstanceOf(Map);
    expect([...inner][0]!.get('deep')).toBe(1);
  });

  // A Map key reaches no prototype setter, so the plain-object hardening has
  // nothing to protect here — but the value must still arrive intact.
  test('a __proto__ Map key stays an ordinary key', () => {
    const decoded = rt(new Map<string, unknown>([['__proto__', { polluted: true }]]));
    expect(decoded).toBeInstanceOf(Map);
    expect(decoded.get('__proto__')).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('an untagged map still refuses non-string keys', () => {
    // 0xa1 = map(1), 0x01 = key 1 (an integer), 0x02 = value 2.
    expect(() => dec.decode(new Uint8Array([0xa1, 0x01, 0x02]))).toThrow(CborDecodeError);
  });

  test('a malformed tag body is rejected, not misread', () => {
    // Tag 259 (0xd9 0x01 0x03) over a text string instead of a map.
    expect(() => dec.decode(new Uint8Array([0xd9, 0x01, 0x03, 0x61, 0x78]))).toThrow(CborDecodeError);
    // Tag 258 (0xd9 0x01 0x02) over a text string instead of an array.
    expect(() => dec.decode(new Uint8Array([0xd9, 0x01, 0x02, 0x61, 0x78]))).toThrow(CborDecodeError);
    // Tag 259 with nothing after it.
    expect(() => dec.decode(new Uint8Array([0xd9, 0x01, 0x03]))).toThrow(CborDecodeError);
  });

  test('a Map body costs the same bytes as the equivalent plain object, plus the tag', () => {
    const asObject = enc.encode({ a: 1 }).byteLength;
    const asMap = enc.encode(new Map([['a', 1]])).byteLength;
    expect(asMap).toBe(asObject + 3); // 0xd9 0x01 0x03
  });
});

describe('CBOR BidirectionalMap (tag 27, #1036)', () => {
  test('round-trips as a BidirectionalMap, both directions usable', () => {
    const source = new BidirectionalMap<string, number>([['ada', 1], ['grace', 2]]);
    const decoded = rt(source);
    expect(decoded).toBeInstanceOf(BidirectionalMap);
    expect(decoded.get('ada')).toBe(1);
    // Never written to the wire — if this answers, it was genuinely rebuilt.
    expect(decoded.getKey(2)).toBe('grace');
    expect(decoded.size).toBe(2);
  });

  test('only the forward pairs are written, under 27(["BidirectionalMap", 259(map)])', () => {
    const bytes = enc.encode(new BidirectionalMap([['ada', 1]]));
    expect(Array.from(bytes)).toEqual([
      0xd8, 0x1b,                                            // tag 27
      0x82,                                                  // array(2)
      0x70, ...[...'BidirectionalMap'].map((c) => c.charCodeAt(0)), // text(16)
      0xd9, 0x01, 0x03,                                      // tag 259
      0xa1,                                                  // map(1) — one pair, not two
      0x63, ...[...'ada'].map((c) => c.charCodeAt(0)),       // text(3) "ada"
      0x01,                                                  // 1
    ]);
  });

  test('is not encoded as a plain Map despite implementing the interface', () => {
    const decoded = rt(new BidirectionalMap([['a', 1]]));
    expect(decoded).toBeInstanceOf(BidirectionalMap);
    const plain = rt(new Map([['a', 1]]));
    expect(plain).toBeInstanceOf(Map);
    expect(plain).not.toBeInstanceOf(BidirectionalMap);
  });

  test('rich types survive on both sides, and a Map nests inside', () => {
    const source = new BidirectionalMap<unknown, unknown>([
      [new Date('2024-02-02T00:00:00Z'), 9n],
      ['inner', new Map([['deep', new Set([1])]])],
    ]);
    const decoded = rt(source);
    expect([...decoded.keys()][0]).toBeInstanceOf(Date);
    expect(decoded.get('inner')).toBeInstanceOf(Map);
    const deep = (decoded.get('inner') as Map<string, Set<number>>).get('deep');
    expect(deep).toBeInstanceOf(Set);
  });

  test('an empty BidirectionalMap survives', () => {
    const decoded = rt(new BidirectionalMap());
    expect(decoded).toBeInstanceOf(BidirectionalMap);
    expect(decoded.size).toBe(0);
  });

  test('a malformed generic object is rejected; an unknown class name passes through', () => {
    // Tag 27 over a text string instead of [name, ...arguments].
    expect(() => dec.decode(new Uint8Array([0xd8, 0x1b, 0x61, 0x78]))).toThrow(CborDecodeError);
    // Tag 27, array(2), "BidirectionalMap", 1 — the argument is not a map.
    const wrongArgument = new Uint8Array([
      0xd8, 0x1b, 0x82, 0x70,
      ...[...'BidirectionalMap'].map((c) => c.charCodeAt(0)),
      0x01,
    ]);
    expect(() => dec.decode(wrongArgument)).toThrow(CborDecodeError);

    // An unrecognised name degrades to plain data rather than failing the
    // message — a newer node's class must not break an older reader.
    const unknownClass = new Uint8Array([
      0xd8, 0x1b, 0x82, 0x64,
      ...[...'Whom'].map((c) => c.charCodeAt(0)),
      0x01,
    ]);
    expect(dec.decode(unknownClass)).toEqual(['Whom', 1]);
  });
});

describe('CBOR RegExp, URL and Error (#1036)', () => {
  test('RegExp round-trips source and flags; lastIndex is not carried', () => {
    const pattern = /order-\d+/gi;
    pattern.lastIndex = 7;
    const decoded = rt(pattern);
    expect(decoded).toBeInstanceOf(RegExp);
    expect(decoded.source).toBe(pattern.source);
    expect(decoded.flags).toBe('gi');
    expect(decoded.lastIndex).toBe(0);
  });

  test('URL round-trips as a URL instance (toJSON must not flatten it)', () => {
    const decoded = rt(new URL('https://example.com/a?b=1#c'));
    expect(decoded).toBeInstanceOf(URL);
    expect(decoded.href).toBe('https://example.com/a?b=1#c');
  });

  test('Error round-trips name, message and cause — never the stack', () => {
    const cause = new RangeError('too deep');
    const decoded = rt(new TypeError('bad shape', { cause }));
    expect(decoded).toBeInstanceOf(TypeError);
    expect(decoded.message).toBe('bad shape');
    expect(decoded.cause).toBeInstanceOf(RangeError);
    expect((decoded.cause as RangeError).message).toBe('too deep');
    expect(decoded.stack).not.toBe(new TypeError('bad shape').stack);
    // The stack is never written, so nothing in the bytes mentions this file.
    expect(new TextDecoder().decode(enc.encode(new Error('boom')))).not.toContain('CborCodec');
  });

  test('an unknown error name reconstructs as Error with that name', () => {
    const custom = new Error('boom');
    custom.name = 'PaymentDeclinedError';
    const decoded = rt(custom);
    expect(decoded).toBeInstanceOf(Error);
    expect(decoded.name).toBe('PaymentDeclinedError');
    expect(decoded.message).toBe('boom');
  });

  test('AggregateError round-trips its member errors', () => {
    const decoded = rt(new AggregateError([new TypeError('a'), new Error('b')], 'several failed'));
    expect(decoded).toBeInstanceOf(AggregateError);
    expect(decoded.message).toBe('several failed');
    expect(decoded.errors).toHaveLength(2);
    expect(decoded.errors[0]).toBeInstanceOf(TypeError);
  });

  test('an error with no cause does not grow one', () => {
    const decoded = rt(new Error('plain'));
    expect('cause' in decoded).toBe(false);
  });

  test('malformed payloads are decode errors, not raw constructor throws', () => {
    const generic = (name: string, ...rest: number[]): Uint8Array => new Uint8Array([
      0xd8, 0x1b, 0x80 | (1 + rest.length),
      0x60 | name.length, ...[...name].map((c) => c.charCodeAt(0)),
      ...rest,
    ]);
    // 27(["RegExp", 1, 2]) — arguments are not strings.
    expect(() => dec.decode(generic('RegExp', 0x01, 0x02))).toThrow(CborDecodeError);
    // 27(["Error", 1]) — the payload is not an object.
    expect(() => dec.decode(generic('Error', 0x01))).toThrow(CborDecodeError);
    // Tag 32 over a relative reference, which `new URL` refuses.
    expect(() => dec.decode(new Uint8Array([0xd8, 0x20, 0x62, 0x2f, 0x78]))).toThrow(CborDecodeError);
    // Tag 32 over a number.
    expect(() => dec.decode(new Uint8Array([0xd8, 0x20, 0x01]))).toThrow(CborDecodeError);
  });

  test('an unbuildable RegExp payload is a decode error', () => {
    // 27(["RegExp", "(", ""]) — an unbalanced group.
    const bytes = new Uint8Array([
      0xd8, 0x1b, 0x83,
      0x66, ...[...'RegExp'].map((c) => c.charCodeAt(0)),
      0x61, 0x28,
      0x60,
    ]);
    expect(() => dec.decode(bytes)).toThrow(CborDecodeError);
  });
});

describe('CBOR typed arrays, DataView and ArrayBuffer (tag 27, #1036)', () => {
  test('every typed-array kind round-trips as its own class, values intact', () => {
    const views: readonly ArrayBufferView[] = [
      new Int8Array([-1, 2]),
      new Uint8ClampedArray([0, 255]),
      new Int16Array([-300, 300]),
      new Uint16Array([0, 65535]),
      new Int32Array([-70000, 70000]),
      new Uint32Array([0, 4294967295]),
      new Float32Array([1.5, -2.5]),
      new Float64Array([1.5, -0]),
      new BigInt64Array([-5n, 5n]),
      new BigUint64Array([0n, 18446744073709551615n]),
    ];

    for (const view of views) {
      const decoded = rt(view);
      expect(decoded.constructor.name).toBe(view.constructor.name);
      expect(decoded).toEqual(view);
    }
    // -0 inside a typed array is bit-exact, since the array travels as bytes.
    expect(Object.is((rt(new Float64Array([-0])))[0], -0)).toBe(true);
  });

  test('DataView and ArrayBuffer round-trip too', () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const decodedBuffer = rt(buffer);
    expect(decodedBuffer).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(decodedBuffer)).toEqual(new Uint8Array([1, 2, 3, 4]));

    const view = new DataView(new Uint8Array([0, 0, 0, 7]).buffer);
    const decodedView = rt(view);
    expect(decodedView).toBeInstanceOf(DataView);
    expect(decodedView.getUint32(0, false)).toBe(7);
  });

  // The reason `Uint8Array` is matched before `ArrayBuffer.isView`: it keeps
  // the bare byte string, which is the whole size argument for CBOR.
  test('Uint8Array keeps its bare byte string — no tag, no wrapper', () => {
    expect(Array.from(enc.encode(new Uint8Array([1, 2, 3])))).toEqual([0x43, 1, 2, 3]);
    expect(rt(new Uint8Array([1, 2, 3]))).toBeInstanceOf(Uint8Array);
    // Uint8ClampedArray is NOT a Uint8Array subclass, so it keeps its class.
    expect(rt(new Uint8ClampedArray([1]))).toBeInstanceOf(Uint8ClampedArray);
  });

  test('a view over part of a buffer carries only its own bytes', () => {
    const backing = new Uint8Array([9, 9, 1, 0, 9, 9]).buffer;
    const decoded = rt(new Uint16Array(backing, 2, 1));
    expect(decoded).toBeInstanceOf(Uint16Array);
    expect(decoded.length).toBe(1);
    expect(decoded[0]).toBe(1); // little-endian 0x0001
  });

  test('a truncated or unknown binary payload is a decode error', () => {
    const generic = (name: string, ...rest: number[]): Uint8Array => new Uint8Array([
      0xd8, 0x1b, 0x82,
      0x60 | name.length, ...[...name].map((c) => c.charCodeAt(0)),
      ...rest,
    ]);
    // 27(["Int32Array", h'000000']) — three bytes is not a whole element.
    expect(() => dec.decode(generic('Int32Array', 0x43, 0, 0, 0))).toThrow(CborDecodeError);
    // 27(["Float64Array", 1]) — the argument is not a byte string.
    expect(() => dec.decode(generic('Float64Array', 0x01))).toThrow(CborDecodeError);
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

  // The property the depth accounting exists for: whatever the encoder is
  // willing to write, the decoder is willing to read.  It has to hold per
  // container kind, because they do not all cost the same number of decode
  // levels — a Set spends two (the tag, then the array) where a Map spends
  // one.  Anything that gets this wrong writes unreadable snapshots.
  test('encoder ceiling == decoder ceiling, for every container kind', () => {
    const wrappers: ReadonlyArray<readonly [string, (inner: unknown) => unknown]> = [
      ['array', (inner) => [inner]],
      ['object', (inner) => ({ v: inner })],
      ['map', (inner) => new Map([['v', inner]])],
      ['set', (inner) => new Set([inner])],
    ];

    for (const [kind, wrap] of wrappers) {
      const nested = (levels: number): unknown => {
        let out: unknown = 'leaf';
        for (let i = 0; i < levels; i++) out = wrap(out);
        return out;
      };

      let deepest = 0;
      let deepestBytes = new Uint8Array();
      for (let levels = 1; levels <= 300; levels++) {
        try {
          deepestBytes = enc.encode(nested(levels));
          deepest = levels;
        } catch {
          break;
        }
      }

      expect(`${kind}: ${deepest > 0}`).toBe(`${kind}: true`);
      // The deepest the encoder accepted really does decode …
      expect(() => dec.decode(deepestBytes)).not.toThrow();
      // … and one level further is refused before any bytes are produced.
      expect(() => enc.encode(nested(deepest + 1))).toThrow(CborEncodeError);
    }
  });

  // The leaf-shaped rich types are where this is easiest to get wrong: they
  // sit two decode levels below where they start (tag, argument array, body)
  // but never recurse, so no child check fires to catch an overflow.  Each
  // one has to police the levels it occupies itself.
  test('a rich type that never recurses still cannot overflow the decoder', () => {
    const leaves: ReadonlyArray<readonly [string, unknown]> = [
      ['empty Set', new Set()],
      ['empty Map', new Map()],
      ['empty BidirectionalMap', new BidirectionalMap()],
      ['RegExp', /x/g],
      ['Error', new Error('x')],
      ['Date', new Date(0)],
      ['bigint', 2n ** 70n],
      ['URL', new URL('https://example.test/')],
    ];

    for (const [kind, leaf] of leaves) {
      for (let levels = 250; levels <= 260; levels++) {
        let value: unknown = leaf;
        for (let i = 0; i < levels; i++) value = [value];

        let bytes: Uint8Array;
        try {
          bytes = enc.encode(value);
        } catch {
          continue; // Refused up front — nothing to read back.
        }
        // Whatever it agreed to write, it must be able to read.
        let outcome = 'decodes';
        try {
          dec.decode(bytes);
        } catch {
          outcome = 'UNREADABLE';
        }
        expect(`${kind} at ${levels}: ${outcome}`).toBe(`${kind} at ${levels}: decodes`);
      }
    }
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
