/**
 * Bytes nobody chose, fed to `CborDecoder` (#1369).
 *
 * Every other CBOR suite hands the decoder something an encoder wrote, or one
 * crafted sequence somebody thought of.  These properties hand it arbitrary
 * bytes and almost-valid ones — a real encoding with bytes flipped, cut short
 * at every offset, or a header whose length field claims anything up to
 * 2^64 - 1 — and hold it to three things whatever arrives:
 *
 *  - it returns a value or throws `CborDecodeError` / `RefusedTagError`, and
 *    nothing else: no `RangeError` out of a `DataView`, no `TypeError` out of a
 *    constructor, no stack overflow;
 *  - what it builds stays inside the tag allow-list it was given, and no object
 *    comes back re-parented through a `__proto__` key;
 *  - what it builds is no larger than the bytes that paid for it — nodes plus
 *    string and byte units never exceed the input length, so no length claim
 *    turns into an allocation the peer did not send.
 *
 * A decoder that hung would fail on bun's per-test timeout.
 *
 * The value round-trips `SerializationProperties.test.ts` and the allow-list
 * properties of `EntityCborAllowList.test.ts` start from a structure the
 * encoder guaranteed; nothing here does.  The deep run is
 * `tests/nightly/DecoderFuzzDeep.nightly.ts`.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { CborDecodeError, CborDecoder, CborEncoder } from '../../../src/serialization/CborCodec.js';
import type { JsonTreeTagName } from '../../../src/serialization/Constants.js';
import { RefusedTagError } from '../../../src/serialization/JsonTree.js';
import { DEFAULT_WIRE_ADMITTED_TAGS } from '../../../src/serialization/WireDecodeOptions.js';
import {
  admittedTagsArbitrary,
  builtSize,
  byteReplacementsArbitrary,
  foreignError,
  outcomeOf,
  richValueArbitrary,
  unadmittedClassesIn,
  withBytesReplaced,
} from '../../util/DecoderFuzz.js';

/** What may come out of a CBOR decode that refuses its input. */
const CBOR_ERRORS = [CborDecodeError, RefusedTagError];

/** Everything wrong with decoding `bytes` under `decoder`, or `[]`. */
function cborViolations(
  bytes: Uint8Array,
  decoder: CborDecoder,
  admitted: ReadonlySet<JsonTreeTagName> | undefined,
): string[] {
  const outcome = outcomeOf(() => decoder.decode(bytes));
  const foreign = foreignError(outcome, CBOR_ERRORS);
  if (foreign !== null) return [foreign];
  if (outcome.kind === 'threw') return [];
  const out = unadmittedClassesIn(outcome.value, admitted);
  const size = builtSize(outcome.value);
  if (size > bytes.byteLength) out.push(`built ${size} units out of ${bytes.byteLength} bytes`);
  return out;
}

/**
 * The four decoders every input meets: the codec's own round trip, the same
 * with the string ceiling switched off (so a length claim meets nothing but
 * the end-of-input check), the wire's list, and tight ceilings.
 */
function decodersUnder(tags: readonly JsonTreeTagName[] | undefined) {
  const admitted = tags === undefined ? undefined : new Set(tags);
  return [
    { decoder: new CborDecoder({}, { tags }), admitted },
    { decoder: new CborDecoder({ maxStringLength: 0 }, { tags }), admitted },
    { decoder: new CborDecoder({}, { tags: DEFAULT_WIRE_ADMITTED_TAGS }), admitted: new Set(DEFAULT_WIRE_ADMITTED_TAGS) },
    {
      decoder: new CborDecoder({ maxNestingDepth: 6, maxStringLength: 16 }, { tags: [] }),
      admitted: new Set<JsonTreeTagName>(),
    },
  ];
}

function violationsUnderEveryDecoder(bytes: Uint8Array, tags: readonly JsonTreeTagName[] | undefined): string[] {
  return decodersUnder(tags).flatMap(({ decoder, admitted }) => cborViolations(bytes, decoder, admitted));
}

/** A valid encoding of an arbitrary value — the seed of every structure-aware input. */
const encodedValue = richValueArbitrary().map((value) => new CborEncoder().encode(value));

/**
 * A header whose length field is the part under attack: a byte or text string,
 * an array, a map or a tag, with each width of length prefix (and the reserved
 * additional-info values 28–31) and a length from 0 to 2^64 - 1, followed by a
 * short random tail.  Optionally wrapped in a one-element array, so the claim
 * is also made one level down.
 */
const lengthClaim = fc.tuple(
  fc.constantFrom(2, 3, 4, 5, 6),
  fc.integer({ min: 24, max: 31 }),
  fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
  fc.uint8Array({ maxLength: 16 }),
  fc.boolean(),
).map(([major, additional, claim, tail, nested]) => {
  const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
  const prefix: number[] = [];
  for (let i = width - 1; i >= 0; i--) prefix.push(Number((claim >> BigInt(8 * i)) & 0xffn));
  return new Uint8Array([...(nested ? [0x81] : []), (major << 5) | additional, ...prefix, ...tail]);
});

describe('CborDecoder over arbitrary bytes', () => {
  test('property: uniform bytes decode or throw a CBOR error, within the allow-list and the input size', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 96 }), admittedTagsArbitrary(), (bytes, tags) => {
      expect(violationsUnderEveryDecoder(bytes, tags)).toEqual([]);
    }));
  });

  test('property: a valid encoding with bytes replaced still decodes or throws a CBOR error', () => {
    fc.assert(fc.property(encodedValue, byteReplacementsArbitrary(), admittedTagsArbitrary(), (bytes, replacements, tags) => {
      expect(violationsUnderEveryDecoder(withBytesReplaced(bytes, replacements), tags)).toEqual([]);
    }));
  });

  test('property: a length field claiming anything up to 2^64 - 1 is refused on what arrived', () => {
    fc.assert(fc.property(lengthClaim, admittedTagsArbitrary(), (bytes, tags) => {
      expect(violationsUnderEveryDecoder(bytes, tags)).toEqual([]);
    }));
  });

  test('property: every strict prefix of a valid encoding is a CborDecodeError, never a value', () => {
    // CBOR items are prefix-free: an item that decodes exactly to its last
    // byte cannot also end earlier, so a cut-short encoding must be refused —
    // a prefix that decoded would mean the decoder invented the missing bytes.
    fc.assert(fc.property(encodedValue, (bytes) => {
      expect(outcomeOf(() => new CborDecoder().decode(bytes)).kind).toBe('decoded');
      const wrong: string[] = [];
      for (let end = 0; end < bytes.byteLength; end++) {
        const outcome = outcomeOf(() => new CborDecoder().decode(bytes.subarray(0, end)));
        if (outcome.kind === 'decoded' || !(outcome.error instanceof CborDecodeError)) {
          wrong.push(`prefix of ${end}: ${outcome.kind === 'decoded' ? 'decoded' : foreignError(outcome, [])}`);
        }
      }
      expect(wrong).toEqual([]);
    }));
  });

  test('property: a claim nested past the depth ceiling is refused, however deep', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 20_000 }), fc.constantFrom(0x81, 0xa1, 0xd8), (depth, header) => {
      // One-element arrays, one-entry maps (keyed by the next level) and tags
      // with a one-byte number — the three containers the depth counter guards.
      const bytes = new Uint8Array(header === 0xd8 ? depth * 2 + 1 : depth + 1).fill(header);
      if (header === 0xd8) for (let i = 1; i < bytes.byteLength; i += 2) bytes[i] = 0x2a;
      bytes[bytes.byteLength - 1] = 0x00;
      expect(cborViolations(bytes, new CborDecoder(), undefined)).toEqual([]);
    }));
  });
});
