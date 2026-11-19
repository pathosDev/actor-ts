/**
 * The two codecs held against each other on input neither encoder wrote (#1369).
 *
 * `RichTypeParity.test.ts` and `SerializationProperties.test.ts` compare CBOR
 * and the JSON tree on values an encoder produced, where both start from a
 * structure it guaranteed.  Here each side decodes what an attacker would send
 * — arbitrary and mutated CBOR bytes, tag-dense JSON documents — under a random
 * allow-list, and the other side must accept what it accepted, and build the
 * same value.  A route's `EntityOptions.withTags` is promised to mean the same
 * thing whichever format its body arrives in (#967), and this is that promise
 * stated over inputs nobody enumerated.
 *
 * Accept/reject cannot be compared on the *same bytes*: the formats share no
 * syntax, so a byte string valid in one is noise in the other.  The comparison
 * runs through the value instead — decoded by one codec, re-encoded by the
 * other's encoder, decoded by the other's decoder under the same list.
 *
 * Two kinds of value are left out, each for a stated reason:
 *
 *  - one the JSON encoder refuses — an object property holding `undefined`,
 *    which the JSON tree's data model has no slot for and its encoder rejects
 *    by design, while CBOR carries it as simple value 23;
 *  - an Invalid Date.  Both decoders build one from a malformed date (`0("x")`,
 *    `{"__date__":"x"}`), but the CBOR encoder writes it as `1(NaN)`, and the
 *    CBOR decoder then charges that NaN to `number` — so under a list naming
 *    `date` without `number` the JSON side accepts what the CBOR side refuses,
 *    and the JSON encoder refuses an Invalid Date outright.  Tracked as an open
 *    point of #1836 rather than asserted here.
 *
 * Values are compared by their CBOR encoding, which is deterministic and keys
 * a `Map` by structure; `toEqual` compares object keys of a `Map` by identity
 * and an Invalid Date never equals itself.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { CborDecoder, CborEncoder } from '../../../src/serialization/CborCodec.js';
import { CborSerializer } from '../../../src/serialization/CborSerializer.js';
import { JsonSerializer } from '../../../src/serialization/JsonSerializer.js';
import {
  admittedTagsArbitrary,
  byteReplacementsArbitrary,
  containsNode,
  jsonTreeDocumentArbitrary,
  outcomeOf,
  richValueArbitrary,
  withBytesReplaced,
} from '../../util/DecoderFuzz.js';

const isInvalidDate = (node: unknown): boolean => node instanceof Date && Number.isNaN(node.getTime());

/** The bytes two values must share to count as the same — see the header. */
const canonical = (value: unknown): number[] => [...new CborEncoder().encode(value)];

/**
 * Weighted towards real encodings: uniform noise rarely decodes at all, so it
 * would leave the comparison with almost nothing to compare.
 */
const cborInput = fc.oneof(
  { arbitrary: fc.uint8Array({ maxLength: 48 }), weight: 1 },
  { arbitrary: richValueArbitrary().map((value) => new CborEncoder().encode(value)), weight: 3 },
  {
    arbitrary: fc.tuple(richValueArbitrary(), byteReplacementsArbitrary(2))
      .map(([value, replacements]) => withBytesReplaced(new CborEncoder().encode(value), replacements)),
    weight: 2,
  },
);

describe('CBOR and the JSON tree agree on what they accept', () => {
  test('property: whatever CBOR accepts under a list, the JSON tree accepts under it too, as the same value', () => {
    fc.assert(fc.property(cborInput, admittedTagsArbitrary(), (bytes, tags) => {
      const fromCbor = outcomeOf(() => new CborDecoder({}, { tags }).decode(bytes));
      if (fromCbor.kind === 'threw' || containsNode(fromCbor.value, isInvalidDate)) return;
      const asJson = outcomeOf(() => new JsonSerializer().toBinary(fromCbor.value));
      if (asJson.kind === 'threw') return;
      const fromJson = outcomeOf(() => new JsonSerializer({}, { tags }).fromBinary(asJson.value as Uint8Array, ''));
      expect(fromJson.kind).toBe('decoded');
      expect(canonical((fromJson as { value: unknown }).value)).toEqual(canonical(fromCbor.value));
    }));
  });

  test('property: whatever the JSON tree accepts under a list, CBOR accepts under it too, as the same value', () => {
    fc.assert(fc.property(jsonTreeDocumentArbitrary(), admittedTagsArbitrary(), (document, tags) => {
      const fromJson = outcomeOf(() =>
        new JsonSerializer({}, { tags }).fromBinary(new TextEncoder().encode(JSON.stringify(document)), ''));
      if (fromJson.kind === 'threw' || containsNode(fromJson.value, isInvalidDate)) return;
      const asCbor = new CborSerializer().toBinary(fromJson.value);
      const fromCbor = outcomeOf(() => new CborSerializer({}, { tags }).fromBinary(asCbor, ''));
      expect(fromCbor.kind).toBe('decoded');
      expect(canonical((fromCbor as { value: unknown }).value)).toEqual(canonical(fromJson.value));
    }));
  });
});
