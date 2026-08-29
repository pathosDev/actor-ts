import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { CborDecoder, CborEncoder } from '../../../src/serialization/CborCodec.js';
import {
  decodeJsonTree,
  encodeJsonTree,
  FRAMING_TAGS,
  TYPE_TAGS,
} from '../../../src/serialization/JsonTree.js';
import { BidirectionalMap } from '../../../src/util/BidirectionalMap.js';
import { BidirectionalMultiMap } from '../../../src/util/BidirectionalMultiMap.js';

/**
 * Round-trip properties for the two rich-type codecs (#543).
 *
 * `RichTypeParity.test.ts` pins one or two hand-picked values per type tag and
 * is the drift guard between the two codecs.  This file states the same claims
 * over a generated value space instead: every type, nested inside every
 * container, at arbitrary depth, in combinations nobody would think to write
 * down.  The two are complements — the fixture table is what fails when a tag
 * is added and forgotten, and this is what fails when a tag is carried but
 * mishandled three levels inside a `Map` key.
 *
 * THE GENERATOR DELIBERATELY EXCLUDES FOUR CLASSES OF INPUT.  Three are
 * documented, intended divergences, where including the input would make the
 * suite a false defect report against working code.  The fourth is a live bug,
 * and is called out as such below rather than quietly filtered — an exclusion
 * nobody can find later is indistinguishable from an axis nobody tested.
 *
 *  1. `undefined` as an OBJECT PROPERTY value.  Under `'omit'` the property is
 *     dropped, matching `JSON.stringify`, so that pre-tag persisted rows stay
 *     byte-identical; under `'reject'` encoding throws outright.  Either way
 *     decode cannot restore a property encode never wrote
 *     (`src/serialization/JsonTree.ts:111-119`).  `undefined` in a VALUE
 *     position — an array slot, a `Set` member, a `Map` key or value — IS
 *     generated, because preserving it via `__undefined__` is precisely what
 *     that tag exists for.
 *  2. Shared references.  Two siblings pointing at one object come back as two
 *     objects, exactly as `JSON.stringify` duplicates them
 *     (`src/serialization/JsonTree.ts:138-143`).  Nothing here builds a shared
 *     reference — fast-check hands out a fresh value per slot — so this is an
 *     exclusion by construction rather than a filter, and cycles are impossible
 *     for the same reason.
 *  3. Values whose encoding is defined by something other than their contents:
 *     objects carrying a `toJSON` method, and `Number`/`String`/`Boolean`
 *     wrapper objects.  Both are honoured the way `JSON.stringify` honours
 *     them, so they round-trip to what they collapse to, not to themselves.
 *  4. Sub-second `Date`s, but ONLY on the paths that touch CBOR — see
 *     {@link cborSafeDateArbitrary}.  This one is an open defect, not a
 *     property of the format.
 *
 * `numRuns` is held low on purpose.  The value space is wide rather than deep,
 * so counterexamples surface in the first few dozen runs; the whole file is
 * part of `bun test` on every commit and is not worth ten seconds there.
 */

const RUNS = 120;

const cborEncoder = new CborEncoder();
const cborDecoder = new CborDecoder();

/**
 * The persistence `PayloadCodec` policy, and the one the parity suite compares
 * under — `'reject'` cannot carry the `__undefined__` fixtures at all.
 */
const viaJsonTree = (value: unknown): unknown =>
  decodeJsonTree(encodeJsonTree(value, { undefinedValues: 'omit' }));
const viaCbor = (value: unknown): unknown => cborDecoder.decode(cborEncoder.encode(value));

/* ------------------------------ Generators ------------------------------- */

const ERROR_CONSTRUCTORS = [
  Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError,
] as const;

/** `u` and `v` are mutually exclusive; every source below is `u`-safe. */
const REGEXP_FLAGS = ['g', 'i', 'm', 's', 'u', 'y'] as const;
const REGEXP_SOURCES = ['abc', '^$', 'a+b*', '\\d{2,3}', '[a-z]+', '(x|y)', '\\s'] as const;

/**
 * Full millisecond precision.  The JSON tree carries a `Date` as
 * `toISOString()`, which is exact, so this is the honest space there.  An
 * invalid `Date` is out: `toISOString()` throws on one, which is a rejection
 * property rather than a round-trip property.
 */
const anyDateArbitrary = fc.date({ noInvalidDate: true });

/**
 * Whole seconds only — the space CBOR round-trips today, and a deliberate
 * narrowing rather than the real claim.
 *
 * `CborEncoder` writes a `Date` as `getTime() / 1000` in a float64 tag-1 value
 * (`src/serialization/CborCodec.ts:139`) and `applyTag` rebuilds it as
 * `new Date(inner * 1000)` (`:758`).  Dividing and re-multiplying by 1000 is
 * not the identity in binary floating point, and the `Date` constructor
 * truncates toward zero, so the error is systematic: a post-1970 timestamp
 * lands up to a millisecond EARLY and a pre-1970 one up to a millisecond LATE.
 * Sampled at 4000 values per era, roughly 0.9 % of dates in 2000-2050 drift —
 * e.g. `2004-02-29T10:34:03.570Z` decodes as `…03.569Z`.  Whole seconds are
 * exact, which is why they are what is generated here.
 *
 * This is not a limitation of CBOR — RFC 8949 tag 1 permits any float, and the
 * JSON tree keeps the millisecond — so the two codecs are NOT interchangeable
 * for sub-second dates, which is exactly the guarantee `RichTypeParity`
 * exists to hold.  Its two `Date` fixtures happen to survive.  Widening this
 * arbitrary back to {@link anyDateArbitrary} is the regression test for the
 * fix; it fails today.
 */
const cborSafeDateArbitrary = fc
  .integer({ min: -4_000_000_000, max: 4_000_000_000 })
  .map((seconds) => new Date(seconds * 1000));

const errorArbitrary = fc
  .tuple(fc.constantFrom(...ERROR_CONSTRUCTORS), fc.string({ maxLength: 20 }))
  .map(([Constructor, message]) => new Constructor(message));

const aggregateErrorArbitrary = fc
  .tuple(fc.array(errorArbitrary, { maxLength: 3 }), fc.string({ maxLength: 20 }))
  .map(([errors, message]) => new AggregateError(errors, message));

const regexpArbitrary = fc
  .tuple(
    fc.constantFrom(...REGEXP_SOURCES),
    fc.uniqueArray(fc.constantFrom(...REGEXP_FLAGS), { maxLength: REGEXP_FLAGS.length }),
  )
  .map(([source, flags]) => new RegExp(source, flags.join('')));

/**
 * Built from a copied buffer so the view owns it exactly.  A view at a
 * non-zero `byteOffset` is a different question — `rebuildBinaryView`
 * normalises to an offset-0 allocation, so such a view round-trips to an
 * equal-bytes view rather than to itself, which would be a property about
 * `slice()` rather than about the codecs.
 */
const binaryViewArbitrary = fc.oneof(
  fc.int8Array({ maxLength: 6 }),
  fc.uint8ClampedArray({ maxLength: 6 }),
  fc.int16Array({ maxLength: 4 }),
  fc.uint16Array({ maxLength: 4 }),
  fc.int32Array({ maxLength: 3 }),
  fc.uint32Array({ maxLength: 3 }),
  fc.bigInt64Array({ maxLength: 2 }),
  fc.bigUint64Array({ maxLength: 2 }),
  fc.float32Array({ maxLength: 3, noNaN: true, noDefaultInfinity: true }),
  fc.float64Array({ maxLength: 3, noNaN: true, noDefaultInfinity: true }),
  fc.uint8Array({ maxLength: 6 }).map((bytes) => new DataView(bytes.slice().buffer)),
  fc.uint8Array({ maxLength: 6 }).map((bytes) => bytes.slice().buffer),
);

const buildLeafArbitrary = (dates: fc.Arbitrary<Date>): fc.Arbitrary<unknown> => fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  // The `__number__` tag's whole reason to exist: plain JSON turns these into
  // `null` / `0`.  `-0` is included because `toStrictEqual` distinguishes it.
  fc.constantFrom(NaN, Infinity, -Infinity, -0),
  fc.string({ maxLength: 20 }),
  fc.bigInt(),
  dates,
  fc.uint8Array({ maxLength: 8 }),
  binaryViewArbitrary,
  regexpArbitrary,
  fc.webUrl().map((href) => new URL(href)),
  errorArbitrary,
  aggregateErrorArbitrary,
);

/**
 * Object keys.  Reserved tag names are in the pool deliberately: a plain user
 * object whose sole key is a tag is what `__literal__` escapes, and generating
 * it here means the escape is exercised by the ordinary round-trip properties
 * rather than only by the dedicated one at the bottom.
 *
 * `__proto__` is NOT here — at nine characters it is out of the random pool's
 * reach anyway, and it needs an own-property construction that `fc.dictionary`
 * does not promise.  It gets its own property test instead.
 */
const RESERVED_TAG_NAMES: readonly string[] = [...TYPE_TAGS, ...FRAMING_TAGS];

const propertyKeyArbitrary = fc.oneof(
  fc.string({ minLength: 1, maxLength: 8 }),
  fc.constantFrom(...RESERVED_TAG_NAMES),
);

/**
 * Keys of keyed containers are primitives, and that is a constraint of the
 * ASSERTION rather than of the codecs.
 *
 * `toStrictEqual` matches `Map` keys structurally, so it cannot pair up two
 * distinct-but-structurally-equal object keys that map to different values:
 * `new Map([[[], a], [[], b]])` compares unequal to a hand-built twin with the
 * same entries in the same order, with no codec involved at all (Bun 1.3.1).
 * With primitive keys the ambiguity cannot arise, because the container itself
 * collapses two equal keys into one entry under SameValueZero.  Object keys
 * are not left untested — they get their own property below, at one entry per
 * container, where no pairing choice exists.
 *
 * `-0` is filtered for a second, unrelated reason: every keyed container
 * normalises it to `+0` on insert, so a `-0` key is not a value any of them
 * can hold.  `BidirectionalMap` normalises it on only one side — `forward`
 * holds the key as `+0` while `reverse` keeps the raw `-0` as a value, so
 * `getKey(v)` returns `-0` for a map whose forward key is `+0` — an asymmetry
 * that exists before anything is encoded, and that a round-trip through the
 * forward entries necessarily resolves to `+0`.
 */
const buildKeyArbitrary = (allowUndefined: boolean): fc.Arbitrary<unknown> => {
  const primitives = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.constantFrom(NaN, Infinity, -Infinity),
    fc.string({ maxLength: 20 }),
    fc.bigInt(),
  ).filter((candidate) => !Object.is(candidate, -0));
  return allowUndefined ? fc.oneof(primitives, fc.constant(undefined)) : primitives;
};

type RichValueTree = {
  value: unknown;
  slot: unknown;
  array: unknown[];
  object: Record<string, unknown>;
  set: Set<unknown>;
  map: Map<unknown, unknown>;
  bidirectionalMap: BidirectionalMap<unknown, unknown>;
  bidirectionalMultiMap: BidirectionalMultiMap<unknown, unknown>;
};

type RichValueOptions = {
  /**
   * `false` yields values containing no `undefined` anywhere — the space on
   * which the `'omit'` and `'reject'` policies must agree, which is the only
   * way to state that property without re-implementing the walker's notion of
   * "contains an undefined".
   */
  readonly allowUndefinedInValuePositions: boolean;
  readonly dates: fc.Arbitrary<Date>;
};

function buildRichValueArbitrary(options: RichValueOptions): fc.Arbitrary<unknown> {
  const leafArbitrary = buildLeafArbitrary(options.dates);
  const keyArbitrary = buildKeyArbitrary(options.allowUndefinedInValuePositions);
  return fc.letrec<RichValueTree>((tie) => ({
    value: fc.oneof(
      { maxDepth: 3 },
      leafArbitrary,
      tie('array'),
      tie('object'),
      tie('set'),
      tie('map'),
      tie('bidirectionalMap'),
      tie('bidirectionalMultiMap'),
    ),
    slot: options.allowUndefinedInValuePositions
      ? fc.oneof(tie('value'), fc.constant(undefined))
      : tie('value'),
    array: fc.array(tie('slot'), { maxLength: 4 }),
    // Spread so the model is a plain `Object.prototype`-backed object, which
    // is what the decoded side always is — `toStrictEqual` compares prototypes.
    object: fc
      .dictionary(propertyKeyArbitrary, tie('value'), { maxKeys: 4 })
      .map((entries) => ({ ...entries })),
    // Members, not keys: a `Set`'s members ARE its values, so two equal
    // members leave nothing to pair up wrongly and arbitrary values are safe.
    set: fc.array(tie('slot'), { maxLength: 4 }).map((members) => new Set(members)),
    map: fc
      .array(fc.tuple(keyArbitrary, tie('slot')), { maxLength: 4 })
      .map((entries) => new Map(entries)),
    // The VALUE is a key too: `set(k, v)` writes `reverse[v] = k`, so an
    // object on either side would reintroduce the pairing ambiguity.
    bidirectionalMap: fc
      .array(fc.tuple(keyArbitrary, keyArbitrary), { maxLength: 4 })
      .map((entries) => new BidirectionalMap(entries)),
    // Both halves are key positions here: the relation is stored as
    // `Map<L, Set<R>>` in one direction and `Map<R, Set<L>>` in the other.
    bidirectionalMultiMap: fc
      .array(fc.tuple(keyArbitrary, keyArbitrary), { maxLength: 4 })
      .map((pairs) => new BidirectionalMultiMap(pairs)),
  })).value;
}

/** Full-precision dates: for the properties that never touch CBOR. */
const richValueArbitrary = buildRichValueArbitrary({
  allowUndefinedInValuePositions: true,
  dates: anyDateArbitrary,
});

/** Whole-second dates: for every property that does. */
const cborSafeValueArbitrary = buildRichValueArbitrary({
  allowUndefinedInValuePositions: true,
  dates: cborSafeDateArbitrary,
});

const totalValueArbitrary = buildRichValueArbitrary({
  allowUndefinedInValuePositions: false,
  dates: anyDateArbitrary,
});

const cborSafeLeafArbitrary = buildLeafArbitrary(cborSafeDateArbitrary);

/* ------------------------------- Properties ------------------------------- */

describe('Serialization properties — each codec round-trips what it encodes', () => {
  test('the JSON tree restores every generated value', () => {
    fc.assert(
      fc.property(richValueArbitrary, (value) => {
        expect(viaJsonTree(value)).toStrictEqual(value);
      }),
      { numRuns: RUNS },
    );
  });

  test('CBOR restores every generated value', () => {
    fc.assert(
      fc.property(cborSafeValueArbitrary, (value) => {
        expect(viaCbor(value)).toStrictEqual(value);
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * The JSON tree is not the wire format — `JSON.stringify` of it is, for
   * every journal, snapshot and durable-state row.  A tree that is correct in
   * memory but contains something `JSON.stringify` mangles (a `bigint`, a
   * non-finite number, a lone surrogate) would pass the property above and
   * still lose data in a store, so the text hop is stated separately.
   */
  test('the encoded tree survives the JSON text hop the stores actually take', () => {
    fc.assert(
      fc.property(richValueArbitrary, (value) => {
        const tree = encodeJsonTree(value, { undefinedValues: 'omit' });
        expect(decodeJsonTree(JSON.parse(JSON.stringify(tree)))).toStrictEqual(value);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('Serialization properties — object keys survive as keys', () => {
  /**
   * The coverage the primitive-key restriction gives up, bought back at one
   * entry per container — where `toStrictEqual` has only one possible pairing
   * and its structural key matching cannot go wrong.
   *
   * Worth stating separately because an object key is the case where encode
   * and decode must agree about a key's ENCODING rather than its identity: the
   * decoded key is necessarily a different object, so the entry is only found
   * again if both sides walked the key the same way.
   */
  /** Genuine object keys only — a primitive key is the case the suite above covers. */
  const objectKeyArbitrary = cborSafeValueArbitrary.filter(
    (candidate) => typeof candidate === 'object' && candidate !== null,
  );

  test('a single object key round-trips through every keyed container', () => {
    fc.assert(
      fc.property(objectKeyArbitrary, cborSafeValueArbitrary, (key, value) => {
        for (const container of [
          new Map([[key, value]]),
          new BidirectionalMap([[key, value]]),
          new BidirectionalMultiMap([[key, value]]),
        ]) {
          expect(viaJsonTree(container)).toStrictEqual(container);
          expect(viaCbor(container)).toStrictEqual(container);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('Serialization properties — the two codecs stay interchangeable', () => {
  /**
   * The generated-space form of what `RichTypeParity.test.ts` asserts over its
   * fixture table.  The seams that make this matter are the serialization
   * extension default, a store's `withSerializer`, and HTTP content
   * negotiation: a value written by one codec and read back through the other
   * must be the same value.
   */
  test('a value decodes identically whichever codec carried it', () => {
    fc.assert(
      fc.property(cborSafeValueArbitrary, (value) => {
        expect(viaCbor(value)).toStrictEqual(viaJsonTree(value));
      }),
      { numRuns: RUNS },
    );
  });
});

describe('Serialization properties — encoding is stable under re-encoding', () => {
  /**
   * Decoding and re-encoding must land on the same tree.  A store that reads a
   * row, hands the value to an actor and persists it again unchanged has to
   * produce the same bytes, or a snapshot would drift from the events that
   * built it.  This is also the tightest guard on the `__literal__` escape:
   * an escape applied on the way out but not recognised on the way back in
   * would nest one wrapper deeper on every pass, and nothing else here notices.
   */
  test('re-encoding a decoded value reproduces the same tree', () => {
    fc.assert(
      fc.property(richValueArbitrary, (value) => {
        const first = encodeJsonTree(value, { undefinedValues: 'omit' });
        const second = encodeJsonTree(decodeJsonTree(first), { undefinedValues: 'omit' });
        expect(second).toStrictEqual(first);
      }),
      { numRuns: RUNS },
    );
  });

  test('re-encoding a decoded value reproduces the same CBOR bytes', () => {
    fc.assert(
      fc.property(cborSafeValueArbitrary, (value) => {
        const first = cborEncoder.encode(value);
        const second = cborEncoder.encode(cborDecoder.decode(first));
        expect(second).toStrictEqual(first);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('Serialization properties — the undefined policies differ only on undefined', () => {
  /**
   * `'reject'` is the HTTP marshalling contract and `'omit'` is the
   * persistence one.  They are meant to diverge on exactly one input class —
   * an `undefined` — so on values that contain none they must be the same
   * function, including never throwing.
   */
  test("'reject' and 'omit' agree on every value that holds no undefined", () => {
    fc.assert(
      fc.property(totalValueArbitrary, (value) => {
        expect(encodeJsonTree(value, { undefinedValues: 'reject' }))
          .toStrictEqual(encodeJsonTree(value, { undefinedValues: 'omit' }));
      }),
      { numRuns: RUNS },
    );
  });
});

describe('Serialization properties — user data cannot forge a tag', () => {
  /**
   * The escape hatch, stated over every reserved tag at once.  Long-lived
   * rows make this the difference between data and a type change on recovery:
   * a stored `{ __set__: [1, 2] }` that a user wrote as a plain object must
   * come back a plain object, not a `Set`.
   *
   * Both directions of the walk are covered — `RESERVED_TAGS` includes the
   * framing tags, so `__literal__` itself is fed in as user data too.
   */
  test('an object whose sole key is a reserved tag comes back as plain data', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RESERVED_TAG_NAMES),
        cborSafeValueArbitrary,
        (tag, payload) => {
          const source = { [tag]: payload };
          expect(viaJsonTree(source)).toStrictEqual(source);
          expect(viaCbor(source)).toStrictEqual(source);
        },
      ),
      { numRuns: RUNS },
    );
  });

  /**
   * `object[key] = value` invokes the inherited `__proto__` setter instead of
   * creating an own property, so a hostile row could otherwise change the
   * prototype of the object the decoder builds.  The claim is narrow and
   * absolute: the key survives as ordinary data, and nothing anywhere gains a
   * property from it.
   */
  test('a __proto__ key stays own data and never reaches the prototype', () => {
    fc.assert(
      fc.property(cborSafeLeafArbitrary, (payload) => {
        const source: Record<string, unknown> = {};
        Object.defineProperty(source, '__proto__', {
          value: payload, enumerable: true, writable: true, configurable: true,
        });

        for (const decoded of [viaJsonTree(source), viaCbor(source)]) {
          const out = decoded as Record<string, unknown>;
          expect(Object.hasOwn(out, '__proto__')).toBe(true);
          expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toStrictEqual(payload);
          expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
        }
        expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });
});
