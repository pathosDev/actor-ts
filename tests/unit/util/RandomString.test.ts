import { describe, expect, test } from 'bun:test';
import { randomHex, randomId, randomString, randomUuid, type RandomStringOptions } from '../../../src/util/RandomString.js';

/**
 * Every character-class combination that yields a non-empty alphabet, with the
 * pattern the result must match and the alphabet size — the size is what decides
 * how much rejection sampling has to discard, and 52 is the worst case.
 */
const COMBINATIONS: ReadonlyArray<{
  options: RandomStringOptions;
  pattern: RegExp;
  alphabetSize: number;
}> = [
  { options: {}, pattern: /^[0-9A-Za-z]+$/, alphabetSize: 62 },
  { options: { digits: false }, pattern: /^[A-Za-z]+$/, alphabetSize: 52 },
  { options: { upperCase: false }, pattern: /^[0-9a-z]+$/, alphabetSize: 36 },
  { options: { lowerCase: false }, pattern: /^[0-9A-Z]+$/, alphabetSize: 36 },
  { options: { upperCase: false, digits: false }, pattern: /^[a-z]+$/, alphabetSize: 26 },
  { options: { lowerCase: false, digits: false }, pattern: /^[A-Z]+$/, alphabetSize: 26 },
  { options: { lowerCase: false, upperCase: false }, pattern: /^[0-9]+$/, alphabetSize: 10 },
];

describe('randomString', () => {
  test('returns exactly the requested length, for every alphabet and every length', () => {
    // The headline guarantee.  Rejection sampling discards bytes, so an
    // implementation that draws `length` bytes once and keeps whatever survives
    // comes up short — the more so the worse the alphabet divides 256.  The
    // 52-character alphabet rejects 18.75 % of draws, which is why it is in the
    // table above and why this sweeps every length rather than a round number.
    for (const { options, pattern } of COMBINATIONS) {
      for (let length = 1; length <= 64; length++) {
        const value = randomString(length, options);
        expect(value, `length ${length} for ${JSON.stringify(options)}`).toHaveLength(length);
        expect(value).toMatch(pattern);
      }
    }
  });

  test('draws only from the enabled character classes', () => {
    for (const { options, pattern } of COMBINATIONS) {
      // 512 characters per combination: enough that a class leaking in through a
      // mis-sized alphabet shows up rather than hiding behind a lucky draw.
      expect(randomString(512, options)).toMatch(pattern);
    }
  });

  test('a length of zero is the empty string', () => {
    expect(randomString(0)).toBe('');
    expect(randomHex(0)).toBe('');
  });

  test('rejects a length that is not a non-negative integer', () => {
    expect(() => randomString(-1)).toThrow(RangeError);
    expect(() => randomString(1.5)).toThrow(RangeError);
    expect(() => randomString(Number.NaN)).toThrow(RangeError);
    expect(() => randomString(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  test('rejects an empty alphabet instead of looping forever', () => {
    // Without the guard there is nothing to draw from and the accept loop never
    // reaches `length` — the call would hang rather than fail.
    expect(() => randomString(8, { lowerCase: false, upperCase: false, digits: false }))
      .toThrow(RangeError);
  });

  test('does not favour the low end of the alphabet', () => {
    // `byte % 62` without rejection over-represents the first 8 of 62 characters
    // by ~1.6 %.  This is a smoke test with a deliberately wide band, not a
    // statistical proof: a tight chi-square here would be a flake waiting to
    // happen, and the rejection logic is what actually carries the property.
    const sample = randomString(60_000, {});
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const head = new Set(alphabet.slice(0, 8).split(''));
    const tail = new Set(alphabet.slice(-8).split(''));

    let headCount = 0;
    let tailCount = 0;
    for (const character of sample) {
      if (head.has(character)) headCount++;
      else if (tail.has(character)) tailCount++;
    }

    // Both buckets are 8/62 of the alphabet, so they should land near each other.
    // A biased implementation skews them apart systematically; ±15 % is far
    // outside sampling noise at this size but nowhere near a knife edge.
    expect(headCount / tailCount).toBeGreaterThan(0.85);
    expect(headCount / tailCount).toBeLessThan(1.15);
  });
});

describe('randomHex / randomId', () => {
  test('randomHex yields lowercase hex of the requested length', () => {
    for (const length of [1, 2, 12, 15, 16, 31, 32]) {
      const value = randomHex(length);
      expect(value, `length ${length}`).toHaveLength(length);
      expect(value).toMatch(/^[0-9a-f]+$/);
    }
  });

  test('randomId yields hex — the alphabet the framework names things with', () => {
    expect(randomId(12)).toMatch(/^[0-9a-f]{12}$/);
  });

  test('names do not repeat and do not run in sequence', () => {
    const names = Array.from({ length: 1000 }, () => randomId(12));
    expect(new Set(names).size).toBe(1000);

    // The decisive property: knowing one name must not yield the next.  The
    // format assertion already rules out a plain counter; this rules out one
    // rendered in hex.
    const asNumbers = names.map((name) => parseInt(name, 16));
    const consecutive = asNumbers.every((value, index) => index === 0 || value === asNumbers[index - 1]! + 1);
    expect(consecutive).toBe(false);
  });
});

describe('randomUuid (#1109)', () => {
  // Lowercase, `4` in the version position, `8|9|a|b` in the variant position.
  // Those six bits are the reason this delegates rather than dashing up a
  // `randomHex(32)`: a hex string is uniform there, a UUID is not, and a reader
  // that parses the version out is the one who finds out.
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test('is a well-formed lowercase v4 UUID', () => {
    for (let attempt = 0; attempt < 256; attempt++) {
      const value = randomUuid();
      expect(value, `attempt ${attempt}`).toMatch(UUID_V4);
      expect(value).toHaveLength(36);
    }
  });

  test('10 000 draws are 10 000 distinct values', () => {
    // The property the helper exists for.  Within one process this only rules
    // out a repeat; the cross-process half of the claim rests on the 122 random
    // bits, which no test can observe from here.
    const count = 10_000;
    const values = new Set(Array.from({ length: count }, () => randomUuid()));
    expect(values.size).toBe(count);
  });

  test('is not a sliced or dashed randomHex — the fixed fields are actually fixed', () => {
    // A dashed `randomHex(32)` passes a length check and a lowercase-hex check,
    // and fails here roughly 15 times in 16 per draw.  Asserting the two nibbles
    // separately from the regex keeps the failure message pointing at which one
    // went wrong.
    for (let attempt = 0; attempt < 256; attempt++) {
      const value = randomUuid();
      expect(value[14], `version nibble, attempt ${attempt}`).toBe('4');
      expect(['8', '9', 'a', 'b'], `variant nibble, attempt ${attempt}`).toContain(value[19]);
    }
  });
});
