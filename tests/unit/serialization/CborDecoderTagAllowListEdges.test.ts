/**
 * Edges of the CBOR decoder's tag allow-list (#967) that the round-trip
 * suites never reach, because the encoder never writes these byte sequences.
 * Found by the v0.19.0 mutation run (#1368, #1844 group C, C10–C12): each
 * case below is a mutant of `CborDecoder` that every existing test let
 * through.  The inputs are hand-written hex, since a foreign or hostile
 * writer is the only source of them.
 */
import { describe, expect, test } from 'bun:test';
import { CborDecodeError, CborDecoder } from '../../../src/serialization/CborCodec.js';
import { RefusedTagError } from '../../../src/serialization/JsonTree.js';

function hex(text: string): Uint8Array {
  const digits = text.replace(/\s+/g, '');
  return Uint8Array.from({ length: digits.length / 2 }, (_unused, index) => Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16));
}

/** The error a decode throws, or `undefined` when it returns. */
function decodeError(decoder: CborDecoder, bytes: Uint8Array): unknown {
  try {
    decoder.decode(bytes);
    return undefined;
  } catch (e) {
    return e;
  }
}

describe('CborDecoder tag allow-list edges', () => {
  test('a bignum answers for its own byte string only, not for the next one (C10)', () => {
    // `[2(h'01'), h'DEADBEEF']`: the bignum's body is a byte string the
    // `bigint` admission already answered for.  The flag that lets it past the
    // `bytes` check must be spent by that body, so the bare byte string after
    // it still needs `bytes` — which this list does not admit.
    const decoder = new CborDecoder({}, { tags: ['bigint'] });
    const error = decodeError(decoder, hex('82 c2 41 01 44 de ad be ef'));

    expect(error).toBeInstanceOf(RefusedTagError);
    expect((error as RefusedTagError).tag).toBe('bytes');
  });

  test('a typed array answers for one byte string of its body, not for a second one inside it (C10)', () => {
    // `27(["Int8Array", h'01', h'DEADBEEF'])`: the answered body is the whole
    // array, so the flag is still set while the array is read.  The first byte
    // string has to spend it; otherwise the second rides in on the same
    // admission — and `buildBinaryView` ignores the extra argument, so the
    // decode would succeed with no trace of what was let through.  (A
    // `Uint8Array` is a plain byte string on this wire, not a `27` kind, so it
    // cannot stand in here.)
    const decoder = new CborDecoder({}, { tags: ['typed-array'] });
    const error = decodeError(decoder, hex('d8 1b 83 69 49 6e 74 38 41 72 72 61 79 41 01 44 de ad be ef'));

    expect(error).toBeInstanceOf(RefusedTagError);
    expect((error as RefusedTagError).tag).toBe('bytes');
    // The well-formed body decodes under the same list.
    const single = new CborDecoder({}, { tags: ['typed-array'] }).decode(hex('d8 1b 82 69 49 6e 74 38 41 72 72 61 79 41 01'));
    expect(single).toBeInstanceOf(Int8Array);
  });

  test('a bignum alone still decodes under that list, and so does a byte string once bytes is admitted', () => {
    // The positive half: the refusal above is about the second byte string,
    // not about bignums or byte strings as such.
    expect(new CborDecoder({}, { tags: ['bigint'] }).decode(hex('c2 41 01'))).toBe(1n);
    const both = new CborDecoder({}, { tags: ['bigint', 'bytes'] }).decode(hex('82 c2 41 01 44 de ad be ef')) as unknown[];
    expect(both[0]).toBe(1n);
    expect(Array.from(both[1] as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  test('a major-type-0 integer above 2^53 decodes as that positive bigint (C11)', () => {
    // A plain uint64, which this encoder never writes (it emits bignum tags)
    // but another CBOR writer does.  Falling through to the negative-integer
    // arm would answer -(n) - 1.
    const decoder = new CborDecoder({}, { tags: ['bigint'] });
    expect(decoder.decode(hex('1b 00 20 00 00 00 00 00 00'))).toBe(9007199254740992n);
    expect(new CborDecoder().decode(hex('1b ff ff ff ff ff ff ff ff'))).toBe(18446744073709551615n);
  });

  test('a uint64 above 2^53 is refused when bigint is not admitted', () => {
    const error = decodeError(new CborDecoder({}, { tags: [] }), hex('1b 00 20 00 00 00 00 00 00'));
    expect(error).toBeInstanceOf(RefusedTagError);
  });

  describe('a malformed generic-object body is reported as malformed, not as a refused class (C12)', () => {
    // Under a list that admits no class, a `27(...)` body whose shape is not
    // `[text, ...]` must not be peeked as a class name: the decode fails
    // because the body is malformed, and says so.
    const restrictive = (): CborDecoder => new CborDecoder({}, { tags: ['bigint'] });

    test('a map body: 27({"RegExp": 1})', () => {
      const error = decodeError(restrictive(), hex('d8 1b a1 66 52 65 67 45 78 70 01'));
      expect(error).toBeInstanceOf(CborDecodeError);
      expect(error).not.toBeInstanceOf(RefusedTagError);
    });

    test("an array whose first element is a byte string: 27([h'526567457870'])", () => {
      // Admitting `bytes` keeps the body's own byte string from being refused
      // first, so the only refusal left to observe is the class name's.
      const decoder = new CborDecoder({}, { tags: ['bytes'] });
      const error = decodeError(decoder, hex('d8 1b 81 46 52 65 67 45 78 70'));
      expect(error).toBeInstanceOf(CborDecodeError);
      expect(error).not.toBeInstanceOf(RefusedTagError);
    });

    test('an empty array: 27([])', () => {
      const error = decodeError(restrictive(), hex('d8 1b 80'));
      expect(error).toBeInstanceOf(CborDecodeError);
      expect(error).not.toBeInstanceOf(RefusedTagError);
    });

    test('the same well-formed name is refused, so the cases above are not passing for want of a refusal', () => {
      // `27(["RegExp", "a", ""])` — a class this list does not admit.
      const error = decodeError(restrictive(), hex('d8 1b 83 66 52 65 67 45 78 70 61 61 60'));
      expect(error).toBeInstanceOf(RefusedTagError);
    });
  });
});
