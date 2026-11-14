/**
 * Text nobody chose, fed to `parseHocon` (#1369).
 *
 * `HoconProperties.test.ts` renders a model into HOCON and holds the parser to
 * what the model meant — every input there is valid.  These properties feed it
 * what a renderer would never write: arbitrary characters (weighted towards
 * the ones HOCON gives meaning to), valid documents with characters inserted,
 * deleted or replaced, every prefix of a valid document, and nesting far past
 * anything a configuration needs.  Whatever arrives, the parser returns an
 * object or throws its own error — an `Error` whose message begins
 * `HOCON parse error at line …`, which is what names the line and column to
 * an operator — and never a `RangeError` out of its own recursion.
 *
 * The parser has no error class of its own; the prefix is its contract, and
 * `Config` reports it as it stands.  The deep run is
 * `tests/nightly/DecoderFuzzDeep.nightly.ts`.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { MAX_HOCON_NESTING_DEPTH } from '../../../src/config/Constants.js';
import { parseHocon, type ConfigObject, type ConfigValue } from '../../../src/config/HoconParser.js';
import { hoconDocumentArbitrary, hoconViolations, outcomeOf } from '../../util/DecoderFuzz.js';

/** Characters HOCON gives meaning to, plus a few ordinary ones, so random text reaches past the first token. */
const SIGNIFICANT = '{}[]=:,."\\$?#/ \n\t\rab01-+e_u'.split('');
const hoconish = fc.string({ unit: fc.constantFrom(...SIGNIFICANT), maxLength: 80 });

/** One edit to a document: insert, delete or replace the character at a position. */
const edit = fc.tuple(fc.constantFrom('insert', 'delete', 'replace'), fc.nat(), fc.constantFrom(...SIGNIFICANT));
function edited(text: string, edits: ReadonlyArray<readonly [string, number, string]>): string {
  let out = text;
  for (const [kind, position, character] of edits) {
    const at = out.length === 0 ? 0 : position % out.length;
    if (kind === 'insert') out = out.slice(0, at) + character + out.slice(at);
    else if (kind === 'delete') out = out.slice(0, at) + out.slice(at + 1);
    else out = out.slice(0, at) + character + out.slice(at + 1);
  }
  return out;
}

/** The three ways a document nests: lists, objects under a key, and a dotted path expression. */
function nestedDocument(shape: 'list' | 'object' | 'path', depth: number): string {
  if (shape === 'list') return `a = ${'['.repeat(depth)}1${']'.repeat(depth)}`;
  if (shape === 'object') return `${'a { '.repeat(depth)}b = 1${' }'.repeat(depth)}`;
  return `${'a.'.repeat(depth)}b = 1`;
}

describe('parseHocon over arbitrary text', () => {
  test('property: arbitrary text parses or throws a HOCON parse error', () => {
    fc.assert(fc.property(fc.oneof(hoconish, fc.string({ unit: 'binary', maxLength: 40 })), (text) => {
      expect(hoconViolations(text)).toEqual([]);
    }));
  });

  test('property: a valid document with characters inserted, deleted or replaced parses or throws a HOCON parse error', () => {
    fc.assert(fc.property(hoconDocumentArbitrary(), fc.array(edit, { minLength: 1, maxLength: 3 }), (text, edits) => {
      expect(hoconViolations(text)).toEqual([]);
      expect(outcomeOf(() => parseHocon(text)).kind).toBe('decoded');
      expect(hoconViolations(edited(text, edits))).toEqual([]);
    }));
  });

  test('property: every prefix of a valid document parses or throws a HOCON parse error', () => {
    fc.assert(fc.property(hoconDocumentArbitrary(), (text) => {
      const wrong: string[] = [];
      for (let end = 0; end < text.length; end++) {
        wrong.push(...hoconViolations(text.slice(0, end)).map((violation) => `prefix of ${end}: ${violation}`));
      }
      expect(wrong).toEqual([]);
    }));
  });
});

describe('parseHocon nesting', () => {
  test('nesting 50 000 deep is a HOCON parse error, not a stack overflow (#1369)', () => {
    // The property's counterexamples, one per shape.  Lists and objects went
    // through the parser's recursion; a dotted path also built its object one
    // `slice` per segment, so 40 000 segments took seconds before it overflowed.
    for (const shape of ['list', 'object', 'path'] as const) {
      expect(hoconViolations(nestedDocument(shape, 50_000))).toEqual([]);
      expect(outcomeOf(() => parseHocon(nestedDocument(shape, 50_000))).kind).toBe('threw');
    }
  });

  test('property: nesting up to the ceiling parses, and past it is refused, however deep', () => {
    fc.assert(fc.property(
      fc.constantFrom('list', 'object', 'path'),
      fc.oneof(fc.integer({ min: 1, max: MAX_HOCON_NESTING_DEPTH + 2 }), fc.integer({ min: 1, max: 60_000 })),
      (shape, depth) => {
        const text = nestedDocument(shape, depth);
        expect(hoconViolations(text)).toEqual([]);
        // `depth` containers under the root key `a` (or `depth` path segments
        // before `b`) put the innermost value at level depth + 1.
        expect(outcomeOf(() => parseHocon(text)).kind).toBe(depth + 1 > MAX_HOCON_NESTING_DEPTH ? 'threw' : 'decoded');
      },
    ), { numRuns: 60 });
  });

  /**
   * The ceiling bounds one path from the root, not a total across siblings.
   * The cases above only pin it from above (too deep is refused); these pin it
   * from below.  A level a finished subtree failed to give back would add up
   * over its siblings, and a document far wider than the ceiling, though
   * shallow, would be refused — which only a large file, never a deep one,
   * shows.
   */
  const SIBLINGS = 1_000;
  const siblingText = (index: number): string => `k${index} { a.b = [1, [2]], c { d = x } }`;
  const siblingValue: ConfigObject = { a: { b: [1, [2]] }, c: { d: 'x' } };
  const siblingsExpected = (): ConfigObject =>
    Object.fromEntries(Array.from({ length: SIBLINGS }, (_, index) => [`k${index}`, siblingValue]));

  test('a document far wider than the ceiling, but shallow, parses to its value', () => {
    const text = Array.from({ length: SIBLINGS }, (_, index) => siblingText(index)).join('\n');
    expect(parseHocon(text)).toEqual(siblingsExpected());
  });

  test('a path exactly at the ceiling is accepted after many sibling subtrees, and one level more is not', () => {
    const siblings = Array.from({ length: SIBLINGS }, (_, index) => siblingText(index)).join('\n');
    // `MAX - 1` segments of `a.` and then `b`: the value sits at level MAX.
    const atCeiling = `${siblings}\n${'a.'.repeat(MAX_HOCON_NESTING_DEPTH - 1)}b = 1`;
    let expected: ConfigValue = 1;
    expected = { b: expected };
    for (let level = 1; level < MAX_HOCON_NESTING_DEPTH; level++) expected = { a: expected };
    expect(parseHocon(atCeiling)).toEqual({ ...siblingsExpected(), ...(expected as ConfigObject) });
    // Inside a list inside the siblings' own nesting, too: depth is given back
    // after a list as well as after an object.
    const listThenCeiling = `${siblings}\nlists = [[[1]], [[2]]]\n${'a.'.repeat(MAX_HOCON_NESTING_DEPTH - 1)}b = 1`;
    expect(outcomeOf(() => parseHocon(listThenCeiling)).kind).toBe('decoded');
    const pastCeiling = `${siblings}\n${'a.'.repeat(MAX_HOCON_NESTING_DEPTH)}b = 1`;
    expect(hoconViolations(pastCeiling)).toEqual([]);
    expect(outcomeOf(() => parseHocon(pastCeiling)).kind).toBe('threw');
  });
});
