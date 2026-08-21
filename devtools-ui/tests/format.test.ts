import { describe, expect, test } from 'bun:test';

import { formatCount } from '../src/core/format.js';

/**
 * `formatCount` had no test until #553, which is how it came to produce two
 * different strings on the two runners this repository uses.
 *
 * It grouped by rewriting the comma out of `toLocaleString('en-US')` — but the
 * separator that call returns comes from the host's ICU data, and the Node that
 * runs the Vitest suite already returns a THIN SPACE (U+2009) there.  So the
 * rewrite hit nothing, the thin space survived, and a UI assertion written
 * against the Bun output failed against a string that looked identical in a
 * terminal.  These tests pin the codepoint, not just the shape.
 */

const SPACE = ' ';

describe('formatCount', () => {
  test('groups thousands with a plain ASCII space', () => {
    expect(formatCount(1000)).toBe(`1${SPACE}000`);
    expect(formatCount(1204)).toBe(`1${SPACE}204`);
    expect(formatCount(1_234_567)).toBe(`1${SPACE}234${SPACE}567`);
  });

  test('uses no separator below a thousand', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(7)).toBe('7');
    expect(formatCount(999)).toBe('999');
  });

  test('the separator is U+0020 and nothing else', () => {
    // The assertion the old implementation would have failed under Node: a
    // thin space renders identically and compares unequal.
    const separators = [...formatCount(1_234_567)].filter((c) => !/\d/.test(c));
    expect(separators).toEqual([SPACE, SPACE]);
    expect(separators.map((c) => c.codePointAt(0))).toEqual([0x20, 0x20]);
  });

  test('rounds rather than truncating, and keeps a sign', () => {
    expect(formatCount(1000.6)).toBe(`1${SPACE}001`);
    expect(formatCount(-1234)).toBe(`-1${SPACE}234`);
  });

  test('says so when there is no number to show', () => {
    expect(formatCount(Number.NaN)).toBe('—');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
