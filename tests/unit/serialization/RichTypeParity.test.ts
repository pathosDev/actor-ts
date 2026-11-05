import { describe, expect, test } from 'bun:test';
import { CborDecodeError, CborDecoder, CborEncodeError, CborEncoder } from '../../../src/serialization/CborCodec.js';
import { CborSerializer } from '../../../src/serialization/CborSerializer.js';
import { MAX_BIGNUM_BYTES } from '../../../src/serialization/Constants.js';
import { decodeJsonTree, encodeJsonTree, TYPE_TAGS } from '../../../src/serialization/JsonTree.js';
import { JsonSerializer } from '../../../src/serialization/JsonSerializer.js';
import { SerializationError } from '../../../src/serialization/Serializer.js';
import { BidirectionalMap } from '../../../src/util/BidirectionalMap.js';
import { BidirectionalMultiMap } from '../../../src/util/BidirectionalMultiMap.js';

/**
 * The two rich-type paths, held against each other.
 *
 * `JsonTree` and `CborCodec` are interchangeable at three seams — the
 * serialization extension default, a store's `withSerializer`, and HTTP
 * content negotiation — and they had drifted: CBOR flattened `Map`, `Set` and
 * `BidirectionalMap` to `{}` and lost every entry, silently (#1036).  This
 * file exists so that cannot happen again, whichever side gains a type next.
 *
 * The comparison runs the JSON tree under the `'omit'` policy because that is
 * what the persistence `PayloadCodec` uses — the default for every journal,
 * snapshot and durable-state store, and the path the issue was actually
 * about.
 */

const cborEncoder = new CborEncoder();
const cborDecoder = new CborDecoder();

const viaJsonTree = (value: unknown): unknown =>
  decodeJsonTree(encodeJsonTree(value, { undefinedValues: 'omit' }));
const viaCbor = (value: unknown): unknown => cborDecoder.decode(cborEncoder.encode(value));

type ParityFixture = {
  /** The `JsonTree` type tag this fixture covers. */
  readonly tag: string;
  readonly values: readonly unknown[];
  /** Class identity and anything `toStrictEqual` is too lax about. */
  readonly check?: (decoded: unknown) => void;
};

const FIXTURES: readonly ParityFixture[] = [
  {
    tag: '__date__',
    values: [new Date('2024-03-15T10:20:30.456Z'), new Date(0)],
    check: (decoded) => expect(decoded).toBeInstanceOf(Date),
  },
  {
    tag: '__bytes__',
    values: [new Uint8Array([1, 2, 3]), new Uint8Array()],
    check: (decoded) => expect(decoded).toBeInstanceOf(Uint8Array),
  },
  {
    tag: '__map__',
    values: [
      new Map<unknown, unknown>([['ada', 1], ['grace', { rank: 2 }]]),
      new Map<unknown, unknown>([[1, 'number key'], [new Date(0), 'date key']]),
      new Map(),
    ],
    check: (decoded) => expect(decoded).toBeInstanceOf(Map),
  },
  {
    tag: '__set__',
    values: [new Set([1, 'two', { three: true }]), new Set()],
    check: (decoded) => expect(decoded).toBeInstanceOf(Set),
  },
  {
    tag: '__bidirectionalmap__',
    values: [new BidirectionalMap<unknown, unknown>([['ada', 1], ['grace', 2]]), new BidirectionalMap()],
    check: (decoded) => expect(decoded).toBeInstanceOf(BidirectionalMap),
  },
  {
    tag: '__bidirectionalmultimap__',
    values: [
      new BidirectionalMultiMap<unknown, unknown>([['ada', 1], ['ada', 2], ['grace', 2]]),
      new BidirectionalMultiMap(),
    ],
    check: (decoded) => expect(decoded).toBeInstanceOf(BidirectionalMultiMap),
  },
  {
    tag: '__bigint__',
    values: [0n, 42n, -42n, 2n ** 70n, -(2n ** 70n)],
    check: (decoded) => expect(typeof decoded).toBe('bigint'),
  },
  {
    tag: '__number__',
    values: [NaN, Infinity, -Infinity, -0, 0],
    check: (decoded) => expect(typeof decoded).toBe('number'),
  },
  {
    // Only value positions: an `undefined` OBJECT PROPERTY is the one place
    // the two deliberately disagree, pinned in its own test below.
    tag: '__undefined__',
    values: [[1, undefined, 3], new Set([undefined]), new Map([['k', undefined]])],
  },
  {
    tag: '__regexp__',
    values: [/order-\d+/gi, /^$/],
    check: (decoded) => expect(decoded).toBeInstanceOf(RegExp),
  },
  {
    tag: '__url__',
    values: [new URL('https://example.com/a?b=1#c')],
    check: (decoded) => expect(decoded).toBeInstanceOf(URL),
  },
  {
    tag: '__error__',
    values: [
      new Error('plain'),
      new TypeError('bad shape', { cause: new RangeError('too deep') }),
      new AggregateError([new TypeError('a'), new Error('b')], 'several failed'),
    ],
    check: (decoded) => expect(decoded).toBeInstanceOf(Error),
  },
  {
    tag: '__typedarray__',
    values: [
      new Int8Array([-1, 2]),
      new Uint16Array([0, 65535]),
      new Float64Array([1.5, -0]),
      new BigInt64Array([-5n, 5n]),
      new DataView(new Uint8Array([0, 0, 0, 7]).buffer),
      new Uint8Array([1, 2, 3, 4]).buffer,
    ],
  },
];

describe('Rich-type parity — the two codecs agree on every JSON-tree type', () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.tag} decodes identically through both codecs`, () => {
      for (const value of fixture.values) {
        const json = viaJsonTree(value);
        const cbor = viaCbor(value);
        expect(cbor).toStrictEqual(json);
        fixture.check?.(json);
        fixture.check?.(cbor);
      }
    });
  }

  test('-0 keeps its sign in both, which toStrictEqual alone would not catch', () => {
    expect(Object.is(viaJsonTree(-0), -0)).toBe(true);
    expect(Object.is(viaCbor(-0), -0)).toBe(true);
    expect(Object.is(viaJsonTree(0), -0)).toBe(false);
    expect(Object.is(viaCbor(0), -0)).toBe(false);
  });

  test('a nested, actor-state-shaped value survives both paths the same way', () => {
    const state = {
      seats: new BidirectionalMap<string, number>([['ada', 1]]),
      seen: new Set([new Date('2024-01-01T00:00:00Z')]),
      totals: new Map<string, unknown>([['eur', 12n], ['ratio', NaN]]),
      pattern: /seat-\d+/g,
      source: new URL('https://example.test/seating'),
      lastFailure: new TypeError('nope', { cause: new Error('root') }),
      readings: new Float32Array([1.5, 2.5]),
      blob: new Uint8Array([7, 8]),
    };
    expect(viaCbor(state)).toStrictEqual(viaJsonTree(state));
  });
});

describe('Rich-type parity — the tag tables cannot drift', () => {
  /**
   * The guard.  A new value type means a new entry in `TYPE_TAGS`, which
   * means this fails until a fixture exists — and a fixture cannot pass
   * until the CBOR side carries the type too.  There is deliberately no
   * exclusion list: framing tags live in `FRAMING_TAGS` instead, so nothing
   * here needs an escape hatch to append the next forgotten type to.
   */
  test('every JSON-tree type tag has a parity fixture', () => {
    expect(FIXTURES.map((fixture) => fixture.tag).sort()).toEqual([...TYPE_TAGS].sort());
  });

  test('no fixture is registered twice', () => {
    expect(new Set(FIXTURES.map((fixture) => fixture.tag)).size).toBe(FIXTURES.length);
  });
});

describe('Rich-type parity — both codecs refuse the same values', () => {
  const unserializable: ReadonlyArray<readonly [string, unknown]> = [
    ['a function', (): number => 1],
    ['a symbol', Symbol('x')],
    ['a Promise', Promise.resolve(1)],
    ['a WeakMap', new WeakMap()],
    ['a WeakSet', new WeakSet()],
  ];

  for (const [what, value] of unserializable) {
    test(`${what} is refused by both`, () => {
      expect(() => encodeJsonTree(value)).toThrow();
      expect(() => cborEncoder.encode(value)).toThrow();
      // And nested, not just at the root.
      expect(() => encodeJsonTree({ field: value })).toThrow();
      expect(() => cborEncoder.encode({ field: value })).toThrow();
    });
  }

  test('a cycle is refused by both', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node['self'] = node;
    expect(() => encodeJsonTree(node)).toThrow();
    expect(() => cborEncoder.encode(node)).toThrow();
  });

  test('a shared reference is a DAG, not a cycle, in both', () => {
    const shared = { id: 7 };
    expect(viaCbor({ left: shared, right: shared }))
      .toStrictEqual(viaJsonTree({ left: shared, right: shared }));
  });
});

/**
 * CBOR caps a bignum's magnitude at `MAX_BIGNUM_BYTES`.  A tag 2 carries `n`
 * and a tag 3 carries `-1 - n`, so the integers it takes run from `-2^bits` to
 * `2^bits - 1`, and the JSON tree holds its `__bigint__` values to the same
 * range (#967) — on both sides.  The two encoders refuse what the two decoders
 * refuse, so nothing is written that cannot be read back.  The decoders are
 * fed payloads built by hand, the way a peer could send them, so their own
 * refusal is pinned rather than hidden behind the encoder's.
 */
describe('Rich-type parity — both codecs take the same bigint range', () => {
  const bits = MAX_BIGNUM_BYTES * 8;
  const limit = 1n << BigInt(bits);
  const widestDigits = (limit - 1n).toString().length;

  /** A tag 2 / tag 3 bignum written out by hand, at any width. */
  const cborBignum = (value: bigint): Uint8Array => {
    const magnitude = value < 0n ? -1n - value : value;
    const hex = magnitude.toString(16);
    const even = hex.length % 2 === 0 ? hex : `0${hex}`;
    const bytes: number[] = [];
    for (let index = 0; index < even.length; index += 2) {
      bytes.push(Number.parseInt(even.slice(index, index + 2), 16));
    }
    // Every case here is 1024 or 1025 bytes: major type 2, two-byte length.
    expect(bytes.length).toBeGreaterThanOrEqual(0x100);
    const tag = value < 0n ? 0xc3 : 0xc2;
    return Uint8Array.from([tag, 0x59, bytes.length >> 8, bytes.length & 0xff, ...bytes]);
  };

  /** Whether the encoder wrote it.  Only its own refusal type counts as a refusal. */
  const writes = (encode: () => unknown, refusal: new (...args: never[]) => Error): boolean => {
    try {
      encode();
      return true;
    } catch (e) {
      if (e instanceof refusal) return false;
      throw e;
    }
  };

  /** Whether the decoder gave the value back.  Only its own refusal type counts. */
  const reads = (
    decode: () => unknown,
    refusal: new (...args: never[]) => Error,
    value: bigint,
  ): boolean => {
    let decoded: unknown;
    try {
      decoded = decode();
    } catch (e) {
      if (e instanceof refusal) return false;
      throw e;
    }
    expect(decoded).toBe(value);
    return true;
  };

  const cases: ReadonlyArray<readonly [string, bigint, boolean]> = [
    [`2^${bits} - 1, the largest`, limit - 1n, true],
    [`-2^${bits}, the smallest`, -limit, true],
    [`2^${bits}, one past the largest`, limit, false],
    [`-2^${bits} - 1, one past the smallest`, -limit - 1n, false],
    [`10^${widestDigits} - 1, no longer than the largest`, 10n ** BigInt(widestDigits) - 1n, false],
  ];

  for (const [what, value, accepted] of cases) {
    test(`${what}: ${accepted ? 'written and read' : 'refused'} by both codecs, on both sides`, () => {
      expect(writes(() => encodeJsonTree(value), SerializationError)).toBe(accepted);
      expect(writes(() => cborEncoder.encode(value), CborEncodeError)).toBe(accepted);
      expect(reads(() => decodeJsonTree({ __bigint__: value.toString() }), SerializationError, value))
        .toBe(accepted);
      expect(reads(() => cborDecoder.decode(cborBignum(value)), CborDecodeError, value)).toBe(accepted);
      if (accepted) {
        expect(viaJsonTree(value)).toBe(value);
        expect(viaCbor(value)).toBe(value);
      }
    });
  }
});

describe('Rich-type parity — through the public serializers', () => {
  const json = new JsonSerializer();
  const cbor = new CborSerializer();

  // `JsonSerializer` uses the 'reject' policy, so the `__undefined__` fixture
  // cannot go through it — that one is covered by the walker comparison above.
  for (const fixture of FIXTURES.filter((entry) => entry.tag !== '__undefined__')) {
    test(`${fixture.tag} survives a serializer round-trip on both`, () => {
      for (const value of fixture.values) {
        const throughJson = json.fromBinary(json.toBinary(value), '');
        const throughCbor = cbor.fromBinary(cbor.toBinary(value), '');
        expect(throughCbor).toStrictEqual(throughJson);
        fixture.check?.(throughCbor);
      }
    });
  }
});

describe('Rich-type parity — the divergences that are deliberate', () => {
  /**
   * Written down rather than smoothed over.  CBOR has a native `undefined`
   * and no legacy rows to stay byte-identical with, so it keeps the key; the
   * JSON tree's 'omit' policy exists precisely to keep pre-tag rows
   * unchanged, so it drops it.  Note that Bun's `toEqual` ignores `undefined`
   * properties — only `toStrictEqual` and an `in` check see this at all.
   */
  test('an undefined object property: CBOR keeps the key, the JSON tree drops it', () => {
    const source = { a: undefined, b: 1 };

    const cbor = viaCbor(source) as Record<string, unknown>;
    expect('a' in cbor).toBe(true);
    expect(cbor['a']).toBeUndefined();

    const json = viaJsonTree(source) as Record<string, unknown>;
    expect('a' in json).toBe(false);

    // Under `JsonSerializer`'s 'reject' policy it is an error outright, which
    // makes CBOR the more permissive of the two.
    expect(() => encodeJsonTree(source)).toThrow();
    expect(() => cborEncoder.encode(source)).not.toThrow();
  });
});
