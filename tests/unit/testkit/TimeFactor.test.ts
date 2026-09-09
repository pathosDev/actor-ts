import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_TEST_TIME_FACTOR,
  TEST_TIME_FACTOR_VARIABLE,
  describeTimeFactor,
  resetTimeFactorForTest,
  scaledMs,
  testTimeFactor,
} from '../../../src/testkit/TimeFactor.js';

/**
 * #1376 — the one multiplier every testkit deadline goes through.
 *
 * Small surface, and every case here is about a way it could be wrong quietly.
 * A factor that silently fell back to 1 on a typo would hand somebody the run
 * they were trying to fix; a factor read twice could scale a deadline with one
 * value and check it against another; a factor that rounded down could take a
 * millisecond off a budget and turn a green run red for the one reason nobody
 * would look for.
 */

/** Set the variable for one case, and put the environment back afterwards. */
function withFactor(value: string | undefined, body: () => void): void {
  const previous = process.env[TEST_TIME_FACTOR_VARIABLE];
  if (value === undefined) delete process.env[TEST_TIME_FACTOR_VARIABLE];
  else process.env[TEST_TIME_FACTOR_VARIABLE] = value;
  resetTimeFactorForTest();
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env[TEST_TIME_FACTOR_VARIABLE];
    else process.env[TEST_TIME_FACTOR_VARIABLE] = previous;
    resetTimeFactorForTest();
  }
}

afterEach(() => { resetTimeFactorForTest(); });

describe('the factor is 1 unless somebody says otherwise', () => {
  test('an unset variable is no scaling', () => {
    withFactor(undefined, () => {
      expect(testTimeFactor()).toBe(DEFAULT_TEST_TIME_FACTOR);
      expect(scaledMs(3_000)).toBe(3_000);
    });
  });

  test('an empty variable is no scaling either', () => {
    // `ACTOR_TS_TEST_TIME_FACTOR=` in a workflow is how a variable ends up
    // present and empty, and it means "unset" rather than "zero".
    withFactor('', () => { expect(testTimeFactor()).toBe(DEFAULT_TEST_TIME_FACTOR); });
  });

  test('at the default the deadline is returned untouched, not recomputed', () => {
    withFactor(undefined, () => {
      expect(scaledMs(333)).toBe(333);
      expect(scaledMs(1)).toBe(1);
    });
  });
});

describe('a raised factor scales every deadline through it', () => {
  test('an integer factor multiplies', () => {
    withFactor('3', () => {
      expect(testTimeFactor()).toBe(3);
      expect(scaledMs(1_000)).toBe(3_000);
    });
  });

  test('a fractional factor is allowed, and rounds up', () => {
    // Up, not to nearest: every caller is a budget, and a deadline that came
    // out a millisecond short of what was asked for is the one rounding error
    // that can turn a green run red.
    withFactor('1.5', () => {
      expect(scaledMs(333)).toBe(500);
      expect(scaledMs(1)).toBe(2);
    });
  });

  test('a factor below 1 is allowed — a fast machine may tighten', () => {
    withFactor('0.5', () => { expect(scaledMs(1_000)).toBe(500); });
  });
});

describe('a malformed factor is refused, never ignored', () => {
  test.each([
    ['not a number', 'three'],
    ['zero, which would make every deadline zero', '0'],
    ['a negative factor', '-2'],
    ['an infinity', 'Infinity'],
  ])('%s throws', (_label, value) => {
    // Falling back to 1 would be the friendlier-looking choice and the wrong
    // one: the variable is set by somebody who wants slower deadlines, and
    // ignoring their typo hands them the failure they were trying to fix with
    // nothing anywhere saying the setting did not take.
    withFactor(value, () => {
      expect(() => testTimeFactor()).toThrow(TEST_TIME_FACTOR_VARIABLE);
    });
  });
});

describe('the factor is read once', () => {
  test('a change after the first read does not take effect', () => {
    // Not a limitation — the point. A deadline computed with one factor and
    // checked against another is worse than either, and this is the only
    // thing that stops it.
    withFactor('2', () => {
      expect(scaledMs(100)).toBe(200);
      process.env[TEST_TIME_FACTOR_VARIABLE] = '10';
      expect(scaledMs(100)).toBe(200);
    });
  });
});

describe('a failure message names the factor, and only when there is one', () => {
  test('the default says nothing', () => {
    // A message mentioning a factor nobody set sends the reader after a
    // setting that is not the cause.
    withFactor(undefined, () => { expect(describeTimeFactor()).toBe(''); });
  });

  test('a raised factor names itself and the variable that set it', () => {
    withFactor('3', () => {
      expect(describeTimeFactor()).toContain(TEST_TIME_FACTOR_VARIABLE);
      expect(describeTimeFactor()).toContain('3');
    });
  });
});
