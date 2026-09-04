import { describe, expect, test } from 'bun:test';
import { parseSize } from '../../../src/config/Size.js';

describe('parseSize', () => {
  test('pass-through for plain numbers', () => {
    expect(parseSize(0)).toBe(0);
    expect(parseSize(1024)).toBe(1024);
  });

  test('bare numeric strings → bytes', () => {
    expect(parseSize('1024')).toBe(1024);
  });

  test('single-letter units are binary (IEC)', () => {
    expect(parseSize('1K')).toBe(1024);
    expect(parseSize('1M')).toBe(1024 ** 2);
    expect(parseSize('1G')).toBe(1024 ** 3);
    expect(parseSize('1T')).toBe(1024 ** 4);
  });

  test('KiB/MiB/GiB are binary', () => {
    expect(parseSize('1KiB')).toBe(1024);
    expect(parseSize('2 MiB')).toBe(2 * 1024 ** 2);
    expect(parseSize('1GiB')).toBe(1024 ** 3);
  });

  test('KB/MB/GB are decimal', () => {
    expect(parseSize('1KB')).toBe(1000);
    expect(parseSize('1MB')).toBe(1_000_000);
    expect(parseSize('1GB')).toBe(1_000_000_000);
  });

  test('long forms work (singular/plural, case-insensitive)', () => {
    expect(parseSize('1 kilobyte')).toBe(1000);
    expect(parseSize('2 MEGABYTES')).toBe(2_000_000);
    expect(parseSize('3 gibibytes')).toBe(3 * 1024 ** 3);
  });

  test('bytes unit is recognised', () => {
    expect(parseSize('128 bytes')).toBe(128);
    expect(parseSize('5B')).toBe(5);
  });

  test('fractional values round to nearest byte', () => {
    expect(parseSize('1.5 K')).toBe(1536);
  });

  test('rejects empty / malformed / unknown units', () => {
    expect(() => parseSize('')).toThrow(/Invalid size/);
    expect(() => parseSize('abc')).toThrow(/Invalid size/);
    expect(() => parseSize('1 weirds')).toThrow(/Unknown size unit/);
  });

  test('rejects non-finite numbers', () => {
    expect(() => parseSize(Number.NaN)).toThrow();
  });

  // #785 — the twin of the same defect in `parseDuration`.  `BYTE_UNITS` was a
  // plain object literal, so `'constructor'` resolved to the `Object` function
  // through the prototype chain and the unknown-unit error never fired; the
  // `NaN` that came back then disables a cap, because `limit > NaN` is false.
  // The assertion names the unknown-unit message on purpose: a fix that only
  // rejected the non-finite result would throw "Invalid size" instead.
  test('the unit lookup is own-property-only', () => {
    expect(() => parseSize('1constructor')).toThrow(
      /Unknown size unit "constructor" in 1constructor/,
    );
    expect(() => parseSize('1 CONSTRUCTOR')).toThrow(/Unknown size unit/);
    for (const member of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
      expect(() => parseSize(`1${member}`)).toThrow();
    }
    // `__proto__` never reaches the lookup: the unit pattern has no underscore.
    expect(() => parseSize('1__proto__')).toThrow(/Invalid size/);
  });

  // The own-key half: every declared unit must answer exactly as before.
  // Mixed-case spellings are in the list deliberately — the guard sees the
  // lowercased unit, and one written against the raw capture instead rejects
  // `1KiB` and every other capitalised unit the docs use.
  test('every declared unit still resolves', () => {
    const declared: ReadonlyArray<readonly [string, number]> = [
      ['1B', 1], ['1byte', 1], ['1Bytes', 1],
      ['1K', 1024], ['1KiB', 1024], ['1kibibytes', 1024],
      ['1KB', 1000], ['1kilobytes', 1000],
      ['1M', 1024 ** 2], ['1MiB', 1024 ** 2], ['1mebibytes', 1024 ** 2],
      ['1MB', 1e6], ['1MEGABYTES', 1e6],
      ['1G', 1024 ** 3], ['1GiB', 1024 ** 3], ['1gigabytes', 1e9],
      ['1T', 1024 ** 4], ['1TiB', 1024 ** 4], ['1terabytes', 1e12],
      ['1P', 1024 ** 5], ['1PiB', 1024 ** 5], ['1petabytes', 1e15],
    ];
    for (const [input, expected] of declared) {
      expect(parseSize(input)).toBe(expected);
    }
  });

  // #785, second half — the finite check used to guard only a numeric
  // argument, so anything the arithmetic produced was returned unexamined.
  test('never returns a non-finite size', () => {
    expect(() => parseSize('9'.repeat(400))).toThrow(/Invalid size/);
    expect(() => parseSize(`${'9'.repeat(300)}pb`)).toThrow(/Invalid size/);
  });
});
