/**
 * Documents nobody chose, fed to the JSON-tree decoder (#1369).
 *
 * `decodeJsonTree` is the walker behind every JSON body, every cluster frame
 * and every journal row, and until now it only ever met documents its own
 * encoder wrote or one crafted case at a time.  These properties feed it JSON
 * dense in tag keys and in the shapes tag bodies take — entry pairs,
 * `{ source, flags }`, `{ name, message, cause }`, base64, digit runs — and
 * feed `JsonSerializer.fromBinary` arbitrary bytes, so the whole path from
 * bytes to value is covered.  Whatever arrives:
 *
 *  - the decoder returns a value or throws `SerializationError` (a refused tag
 *    is its subclass `RefusedTagError`), never a `SyntaxError` out of a
 *    `RegExp`, a `RangeError` out of a typed-array constructor or a stack
 *    overflow;
 *  - what it builds stays inside the allow-list and keeps `Object.prototype`;
 *  - what it builds is no larger than the text it was built from;
 *  - every recursion site is charged against the depth ceiling, whichever tag
 *    it passes through.
 *
 * `JsonTreeTagAllowList.test.ts` already holds the identity under `tags: []`
 * and the refusal of each tag by name; nothing here repeats that.  The deep
 * run is `tests/nightly/DecoderFuzzDeep.nightly.ts`.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import type { JsonTreeTagName } from '../../../src/serialization/Constants.js';
import { decodeJsonTree } from '../../../src/serialization/JsonTree.js';
import { JsonSerializer } from '../../../src/serialization/JsonSerializer.js';
import { SerializationError } from '../../../src/serialization/Serializer.js';
import {
  admittedTagsArbitrary,
  builtSize,
  byteReplacementsArbitrary,
  foreignError,
  jsonTreeDocumentArbitrary,
  outcomeOf,
  richValueArbitrary,
  unadmittedClassesIn,
  withBytesReplaced,
} from '../../util/DecoderFuzz.js';

/** Everything wrong with an outcome of decoding `size` units of input under `tags`, or `[]`. */
function violations(
  decode: () => unknown,
  tags: readonly JsonTreeTagName[] | undefined,
  size: number,
): string[] {
  const outcome = outcomeOf(decode);
  const foreign = foreignError(outcome, [SerializationError]);
  if (foreign !== null) return [foreign];
  if (outcome.kind === 'threw') return [];
  const out = unadmittedClassesIn(outcome.value, tags === undefined ? undefined : new Set(tags));
  const built = builtSize(outcome.value);
  if (built > size) out.push(`built ${built} units out of ${size}`);
  return out;
}

/**
 * Tag nesting the walker recurses through, one shape per recursion site: a
 * set member, a map key and a map value, an error's cause and its aggregate
 * errors, the literal escape, and a plain array — each wrapping the next.
 */
const WRAPPERS: ReadonlyArray<readonly [name: string, wrap: (inner: unknown) => unknown]> = [
  ['array', (inner) => [inner]],
  ['object', (inner) => ({ a: inner })],
  ['set', (inner) => ({ __set__: [inner] })],
  ['map key', (inner) => ({ __map__: [[inner, 1]] })],
  ['map value', (inner) => ({ __map__: [[1, inner]] })],
  ['bidirectional map', (inner) => ({ __bidirectionalmap__: [[inner, 1]] })],
  ['multi-map', (inner) => ({ __bidirectionalmultimap__: [[1, [inner]]] })],
  ['error cause', (inner) => ({ __error__: { name: 'Error', message: '', cause: inner } })],
  ['aggregate errors', (inner) => ({ __error__: { name: 'AggregateError', message: '', errors: [inner] } })],
  ['literal', (inner) => ({ __literal__: { a: inner } })],
];

describe('decodeJsonTree over arbitrary documents', () => {
  test('property: a tag-dense document decodes or throws SerializationError, within the list and the input size', () => {
    fc.assert(fc.property(
      jsonTreeDocumentArbitrary(), admittedTagsArbitrary(), fc.constantFrom(undefined, 3),
      (document, tags, maxNestingDepth) => {
        const size = JSON.stringify(document).length;
        expect(violations(() => decodeJsonTree(document, { tags, maxNestingDepth }), tags, size)).toEqual([]);
      },
    ));
  });

  test('property: nesting through each tag alone and through any mix is charged against the ceiling, however deep', () => {
    // Each wrapper on its own as well as mixed: a site that forgot to charge
    // its level hides behind its neighbours in a mix, and shows alone.
    const patterns = fc.oneof(
      fc.integer({ min: 0, max: WRAPPERS.length - 1 }).map((index) => [index]),
      fc.array(fc.integer({ min: 0, max: WRAPPERS.length - 1 }), { minLength: 2, maxLength: 12 }),
    );
    const depths = fc.oneof(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 20_000 }));
    fc.assert(fc.property(patterns, depths, (pattern, depth) => {
      // Built inside out, iteratively: a recursive builder would overflow
      // before the decoder was ever asked.
      let document: unknown = 0;
      for (let level = 0; level < depth; level++) document = WRAPPERS[pattern[level % pattern.length]!]![1](document);
      const outcome = outcomeOf(() => decodeJsonTree(document, { maxNestingDepth: 16 }));
      expect(foreignError(outcome, [SerializationError])).toBeNull();
      // Every wrapper costs at least one level, so 17 of them cannot fit.
      if (depth > 16) expect(outcome.kind).toBe('threw');
    }), { numRuns: 100 });
  });
});

describe('JsonSerializer.fromBinary over arbitrary bytes', () => {
  test('property: uniform bytes decode or throw SerializationError', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 64 }), admittedTagsArbitrary(), (bytes, tags) => {
      expect(violations(() => new JsonSerializer({}, { tags }).fromBinary(bytes, ''), tags, bytes.byteLength)).toEqual([]);
    }));
  });

  test('property: a valid encoding with bytes replaced decodes or throws SerializationError', () => {
    const encoded = richValueArbitrary().chain((value) => {
      const outcome = outcomeOf(() => new JsonSerializer().toBinary(value));
      // An object property holding `undefined` is refused by the encoder by
      // design, so such a value seeds nothing; its neighbours do.
      return fc.constant(outcome.kind === 'decoded' ? outcome.value as Uint8Array : new Uint8Array([0x7b, 0x7d]));
    });
    fc.assert(fc.property(encoded, byteReplacementsArbitrary(), admittedTagsArbitrary(), (bytes, replacements, tags) => {
      const input = withBytesReplaced(bytes, replacements);
      expect(violations(() => new JsonSerializer({}, { tags }).fromBinary(input, ''), tags, input.byteLength)).toEqual([]);
    }));
  });
});
