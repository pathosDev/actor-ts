/**
 * The series key is injective — as a property, not as a list of separators
 * (#1513).
 *
 * The first version of the key joined `k=v` pairs with `\x1f`, and a label
 * *value* is deliberately unrestricted — so `{ a: 'x\x1fb=y' }` and
 * `{ a: 'x', b: 'y' }` spelled the same string and the second caller silently
 * got the first one's series.  `Metrics.test.ts` keeps that reported pair as a
 * regression example, and a table of five further separator characters beside
 * it.
 *
 * A table of characters is not the property.  A `k=v` join on any character
 * outside that table passes every one of those rows and reintroduces the
 * aliasing verbatim — measured: with `seriesKey` replaced by a join on `\x02`,
 * `bun test tests/unit/metrics tests/unit/worker/MetricsRelay.test.ts` was
 * 271 pass / 0 fail, and `counter('hits_total', { a: 'x\x02b=y' }).inc(6)`
 * beside `counter('hits_total', { a: 'x', b: 'y' }).inc(7)` collapsed to one
 * series reading 13.  Lengthening the table moves the hole one character over;
 * it never closes it.
 *
 * So these do not name a separator at all.  The binding assertion **searches
 * for the collision**: it takes the encoding of `{ a: 'x', b: 'y' }` and asks,
 * for every split point of that string, whether putting the tail into a single
 * label value reproduces it exactly.  If any split does, a one-key tuple
 * spells a two-key one and the encoding is not injective — and the loop never
 * looks at the separator, so it holds for a separator of any character and of
 * any *length*.  An earlier draft of this file cross-multiplied the characters
 * the encoding introduces, which was still a list: it called a join on `\r\n`
 * injective.  The search does not.
 *
 * The characters the encoding introduces are still computed, but only to seed
 * the alphabet the properties draw values from, so those stay pointed at the
 * encoding rather than at a fixed idea of what it looks like.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  DefaultMetricsRegistry,
  seriesKey,
  type Labels,
} from '../../../src/metrics/Metrics.js';

/* ------------------- asking the encoding for its separators ------------- */

/** An encoding of a label tuple — `seriesKey`, or a wrong one under test. */
type TupleEncoding = (labels: Labels) => string;

/**
 * Two probe tuples whose characters are **disjoint**, which is what keeps the
 * discovery below from missing a delimiter.
 *
 * A character the encoder introduces is invisible to subtraction if it also
 * appears in the probe's own input.  With two probes sharing no character, one
 * hidden inside the first probe's alphabet is exposed by the second and the
 * other way round, so none can hide from both — not even the absurd ones, a
 * delimiter that is the letter `a`.
 */
const PROBE_TUPLES: ReadonlyArray<Labels> = [
  { aa: 'xx', bb: 'yy' },
  { mm: '00', nn: '11' },
];

/**
 * Every character `encode` puts into its output that did not come from the
 * tuple — its separators, delimiters and quoting, whatever they happen to be.
 * `JSON.stringify` over sorted pairs answers `[`, `"`, `,`, `]`; a `k=v` join
 * on `\x02` answers `=` and `\x02`.
 *
 * This **is not the guard** — {@link findAliasingValue} is, and it needs no
 * alphabet.  What this is for is the two properties below: their values are
 * drawn from the characters the encoding actually treats as structural, so
 * fast-check spends its draws where a collision could be rather than on
 * payloads the encoding has no opinion about.  An encoding that changed its
 * delimiters would move the properties' alphabet with it, in the same commit.
 */
function charactersIntroducedBy(encode: TupleEncoding): ReadonlySet<string> {
  const introduced = new Set<string>();
  for (const probe of PROBE_TUPLES) {
    const fromInput = new Set<string>();
    for (const [key, value] of Object.entries(probe)) {
      for (const character of key) fromInput.add(character);
      for (const character of String(value)) fromInput.add(character);
    }
    for (const character of encode(probe)) {
      if (!fromInput.has(character)) introduced.add(character);
    }
  }
  return introduced;
}

/**
 * Search for a one-key tuple that encodes to the same string as the two-key
 * tuple `{ a: 'x', b: 'y' }` — the reported aliasing, looked for rather than
 * guessed at.
 *
 * This is the assertion that binds the family, and it names no separator at
 * all.  Any encoding that lays a tuple out as text puts the second pair
 * somewhere inside its output; if a *value* can be made to contain that
 * suffix, the one-key tuple spells the two-key one.  So: take the two-key
 * encoding, and for every split point ask whether putting the tail into a
 * single value reproduces it exactly.
 *
 * Being a search rather than a table is what makes it total.  It does not
 * need to know the separator, and — the reason it replaced a cross-product of
 * discovered characters — it does not need the separator to be *one*
 * character: a join on `\r\n`, on `', '`, or on any string at all is found by
 * the same loop, because the loop never looks at the separator.
 *
 * Both key positions are tried, so an encoding that emits its pairs in some
 * order other than sorted is covered too.
 *
 * Returns the colliding value, or `null` when no split point produces one.
 */
function findAliasingValue(encode: TupleEncoding): string | null {
  const target = encode({ a: 'x', b: 'y' });
  for (const key of ['a', 'b']) {
    for (let split = 0; split <= target.length; split++) {
      const value = target.slice(split);
      if (encode({ [key]: value }) === target) return value;
    }
  }
  return null;
}

/** The characters the shipped encoding introduces, computed once. */
const INTRODUCED_CHARACTERS = [...charactersIntroducedBy(seriesKey)];

/**
 * Structural equality of two tuples **as the exposition renders them** —
 * deliberately not written as a string comparison.
 *
 * A canonical form built by joining or stringifying would be a second copy of
 * the encoding under test, and a test that compares an implementation against
 * a restatement of itself can only ever agree with it.  Comparing the sorted
 * pair lists element by element cannot alias, because nothing is concatenated.
 *
 * `String(value)` is applied because the key is injective on what is
 * *rendered*: `{ code: 500 }` and `{ code: '500' }` are both `code="500"` in
 * the body, so they are one series there and have to be one series here.
 */
function rendersAsTheSameTuple(left: Labels, right: Labels): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => {
    const rightKey = rightKeys[index]!;
    return key === rightKey && String(left[key]) === String(right[rightKey]);
  });
}

describe('seriesKey — the separator family, not a list of separators (#1513)', () => {
  test('the discovery finds something at all, so nothing below is vacuous', () => {
    // Every assertion in this block iterates the discovered set. An empty one
    // would make all of them pass without testing anything, which is the exact
    // failure mode this block exists to replace.
    expect(INTRODUCED_CHARACTERS.length).toBeGreaterThan(0);
    // The shipped encoding is JSON over sorted pairs, so these are its
    // structural characters. Named for the reader, asserted so that an
    // encoding change has to come past this line.
    expect([...INTRODUCED_CHARACTERS].sort()).toEqual(['"', ',', '[', ']']);
  });

  test('no value can spell a second pair — searched for, not guessed at', () => {
    expect(
      findAliasingValue(seriesKey),
      'a single label value reproduces the encoding of a two-label tuple, which '
      + 'is the #1513 aliasing exactly',
    ).toBeNull();
  });

  test('the search discriminates — it catches a `k=v` join on any separator', () => {
    // The guard on the guard. Without this, `findAliasingValue` could be
    // answering `null` because it is broken rather than because the encoding
    // is sound, and the row above would be the green that hides it.
    //
    // The list is deliberately awkward. `Z` and `a` are letters, and `a` is
    // also a character of the probe tuple, so a discovery-by-subtraction
    // scheme would miss it. U+2028 is a line terminator. `\r\n` and `', '`
    // are two characters long, which is what retired the cross-product of
    // discovered single characters this replaced — it would have called every
    // one of those encodings injective.
    //
    // U+2028 is built with `fromCharCode` rather than spelled: a raw one ends
    // a line for some source parsers, and an editing tool that resolved the
    // escape into the raw byte is how this file first failed to compile.
    const separators = ['\x1f', '\x02', '\x00', '|', ',', 'Z', 'a',
      String.fromCharCode(0x2028), '\r\n', ', '];
    for (const separator of separators) {
      const join: TupleEncoding = (labels) => Object.keys(labels).sort()
        .map((key) => `${key}=${String(labels[key])}`)
        .join(separator);
      expect(
        findAliasingValue(join),
        `a k=v join on ${JSON.stringify(separator)} was not caught`,
      ).toBe(`x${separator}b=y`);
    }
  });

  test('the search does not cry wolf over an encoding that is merely unusual', () => {
    // The other half of discrimination: a guard that answered "collision" for
    // everything would also make the row above green. These three are odd but
    // injective — length-prefixed pairs, a JSON object, and a percent-escaped
    // join — and none of them may be reported.
    const lengthPrefixed: TupleEncoding = (labels) => Object.keys(labels).sort()
      .map((key) => `${key.length}:${key}${String(labels[key]).length}:${String(labels[key])}`)
      .join('');
    const asObject: TupleEncoding = (labels) => JSON.stringify(
      Object.fromEntries(Object.keys(labels).sort().map((key) => [key, String(labels[key])])),
    );
    const percentEscaped: TupleEncoding = (labels) => Object.keys(labels).sort()
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(labels[key]))}`)
      .join('&');
    for (const encode of [lengthPrefixed, asObject, percentEscaped]) {
      expect(findAliasingValue(encode)).toBeNull();
    }
  });

  test('property: folding a pair into a value never collides, for any key or value', () => {
    // The exhaustive test above fixes the tuple at `a/b/x/y`. This one keeps
    // the separators derived and lets fast-check choose the names and the
    // payloads, so an encoding that happens to survive that one tuple and not
    // others is still caught.
    const identifier = fc.constantFrom('a', 'b', 'route', 'node');
    const payload = fc.string({
      unit: fc.constantFrom(...INTRODUCED_CHARACTERS, '=', 'x', 'y', '\\', '\x1f'),
      maxLength: 6,
    });
    fc.assert(fc.property(
      fc.constantFrom(...INTRODUCED_CHARACTERS),
      fc.constantFrom(...INTRODUCED_CHARACTERS),
      identifier, identifier, payload, payload,
      (separator, assignment, firstKey, secondKey, firstValue, secondValue) => {
        // Same key twice is a one-pair tuple on both sides, not a fold.
        if (firstKey === secondKey) return true;
        const unfolded: Labels = { [firstKey]: firstValue, [secondKey]: secondValue };
        const folded: Labels = {
          [firstKey]: `${firstValue}${separator}${secondKey}${assignment}${secondValue}`,
        };
        return seriesKey(unfolded) !== seriesKey(folded);
      },
    ));
  });

  test('property: distinct rendered tuples get distinct keys, and equal ones equal keys', () => {
    // The law in full, in both directions. The reverse half is load-bearing on
    // its own: an encoding that mixed the *unsorted* key order in, or that
    // distinguished `500` from `'500'`, would satisfy injectivity and still be
    // wrong, because the exposition cannot tell either pair apart.
    const identifier = fc.constantFrom('a', 'b', 'code');
    const value = fc.oneof(
      fc.string({
        unit: fc.constantFrom(...INTRODUCED_CHARACTERS, '=', 'x', 'y', '\x1f', '\x00'),
        maxLength: 5,
      }),
      fc.constantFrom<Labels[string]>(500, '500', true, 'true', 0, ''),
    );
    const tuple = fc.dictionary(identifier, value, { maxKeys: 3 });
    fc.assert(fc.property(tuple, tuple, (left, right) => (
      rendersAsTheSameTuple(left, right) === (seriesKey(left) === seriesKey(right))
    )));
  });

  test('the registry keeps a folded tuple apart from the pair it spells', () => {
    // The same family one layer up, because the aliasing that was reported was
    // never visible as a string — it was one series where there should have
    // been two. `seriesKey` could be inlined or renamed tomorrow and this
    // would still hold the behaviour.
    for (const separator of INTRODUCED_CHARACTERS) {
      const registry = new DefaultMetricsRegistry();
      registry.counter('hits_total', { a: `x${separator}b=y` }).inc(6);
      registry.counter('hits_total', { a: 'x', b: 'y' }).inc(7);
      const series = registry.collect().filter((sample) => sample.name === 'hits_total');
      expect(
        series,
        `a value carrying ${JSON.stringify(separator)} merged onto the two-label tuple`,
      ).toHaveLength(2);
      // Not merely two of something: the merge added the counts together, so
      // a reading of 13 is the shape of the defect.
      expect(series.map((sample) => sample.value).sort()).toEqual([6, 7]);
    }
  });
});

