import { describe, expect, test } from 'bun:test';
import { parseDuration } from '../../../src/config/Duration.js';

describe('parseDuration', () => {
  test('pass-through for plain numbers (ms)', () => {
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(123)).toBe(123);
  });

  test('rejects non-finite numbers', () => {
    expect(() => parseDuration(Number.NaN)).toThrow();
    expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow();
  });

  test('bare numeric strings → ms', () => {
    expect(parseDuration('1000')).toBe(1000);
    expect(parseDuration('1.5')).toBeCloseTo(1.5);
  });

  test('supports short units', () => {
    expect(parseDuration('100ms')).toBe(100);
    expect(parseDuration('1s')).toBe(1_000);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  test('supports long units (singular and plural)', () => {
    expect(parseDuration('500 milliseconds')).toBe(500);
    expect(parseDuration('2 seconds')).toBe(2_000);
    expect(parseDuration('3 minutes')).toBe(180_000);
    expect(parseDuration('4 hours')).toBe(4 * 3_600_000);
    expect(parseDuration('1 day')).toBe(86_400_000);
  });

  test('is case-insensitive', () => {
    expect(parseDuration('1 Second')).toBe(1_000);
    expect(parseDuration('5 MINUTES')).toBe(300_000);
  });

  test('handles fractional values', () => {
    expect(parseDuration('1.5s')).toBe(1_500);
    expect(parseDuration('2.5 minutes')).toBe(150_000);
  });

  test('handles negative values', () => {
    expect(parseDuration('-500ms')).toBe(-500);
  });

  test('rejects empty strings', () => {
    expect(() => parseDuration('')).toThrow(/Invalid duration/);
  });

  test('rejects unknown units', () => {
    expect(() => parseDuration('5 lightyears')).toThrow(/Unknown duration unit/);
  });

  // #785.  The unit table used to be a plain object literal, so
  // `UNIT_MS['constructor']` resolved through `Object.prototype` to the
  // `Object` function, the `undefined` guard never fired, and the result was a
  // silent `NaN` instead of the loud error every other bad unit produces.
  // Asserting the *unknown-unit* message, not merely that it throws: a fix
  // that only rejected the non-finite result would throw "Invalid duration"
  // here and leave the lookup itself resolving through the prototype.
  test('the unit lookup is own-property-only', () => {
    expect(() => parseDuration('1constructor')).toThrow(
      /Unknown duration unit "constructor" in 1constructor/,
    );
    expect(() => parseDuration('1 CONSTRUCTOR')).toThrow(/Unknown duration unit/);
    // The rest of `Object.prototype` cannot reach the lookup at all — they are
    // mixed-case and do not survive the lowercasing — but they must stay
    // rejected for the reason the guard is positive rather than a blocklist.
    for (const member of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
      expect(() => parseDuration(`1${member}`)).toThrow();
    }
    // `__proto__` never gets that far: the unit pattern has no underscore.
    expect(() => parseDuration('1__proto__')).toThrow(/Invalid duration/);
  });

  // The own-key half of the same guard: a null-prototype table plus a positive
  // `Object.hasOwn` check must leave every declared unit answering as before.
  // Mixed-case spellings are in the list deliberately — the guard sees the
  // lowercased unit, and one written against the raw capture instead rejects
  // every capitalised unit in the file.
  test('every declared unit still resolves', () => {
    const declared: ReadonlyArray<readonly [string, number]> = [
      ['1ns', 1e-6], ['1nanosecond', 1e-6], ['1NANOSECONDS', 1e-6],
      ['1us', 1e-3], ['1μs', 1e-3], ['1micros', 1e-3], ['1Microseconds', 1e-3],
      ['1ms', 1], ['1millis', 1], ['1MS', 1],
      ['1s', 1_000], ['1sec', 1_000], ['1Seconds', 1_000],
      ['1m', 60_000], ['1min', 60_000], ['1MINUTES', 60_000],
      ['1h', 3_600_000], ['1hr', 3_600_000], ['1Hours', 3_600_000],
      ['1d', 86_400_000], ['1day', 86_400_000], ['1DAYS', 86_400_000],
    ];
    for (const [input, expected] of declared) {
      expect(parseDuration(input)).toBeCloseTo(expected, 9);
    }
  });

  // #785, second half.  The finite check used to guard only a numeric
  // argument, so anything the arithmetic produced was returned unexamined.
  test('never returns a non-finite duration', () => {
    const overflowing = '9'.repeat(400);
    expect(() => parseDuration(overflowing)).toThrow(/Invalid duration/);
    expect(() => parseDuration(`${'9'.repeat(305)}d`)).toThrow(/Invalid duration/);
  });

  test('rejects malformed strings', () => {
    expect(() => parseDuration('abc')).toThrow(/Invalid duration/);
    expect(() => parseDuration('5.5.5s')).toThrow();
  });

  test('supports nano and micro units (fractional ms)', () => {
    expect(parseDuration('1_000_000ns'.replace(/_/g, ''))).toBe(1);
    expect(parseDuration('1000μs')).toBe(1);
  });
});
