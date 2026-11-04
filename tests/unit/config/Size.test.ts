import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
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

  test('a fraction with a unit is that many bytes when it comes to a whole number of them', () => {
    expect(parseSize('1.5 K')).toBe(1536);
    expect(parseSize('1.5K')).toBe(1536);
    expect(parseSize('8K')).toBe(8192);
    expect(parseSize('1420B')).toBe(1420);
    expect(parseSize('0.125K')).toBe(128);
    expect(parseSize('1.50K')).toBe(1536);
    expect(parseSize('1420.0B')).toBe(1420);
    // Trailing zeros change nothing, however many there are.
    expect(parseSize(`1.5${'0'.repeat(60)}K`)).toBe(1536);
  });

  // A size used to be rounded to the nearest byte, so a slip became another
  // size: `1420.5B` was 1421, and `0.4B` was 0, which several caps read as
  // "no cap" (#1728).
  test('a size that does not come to a whole number of bytes is refused, naming it', () => {
    for (const size of ['0.4B', '1420.5B', '1420.5 bytes', '1.1K', '511.6B']) {
      expect(() => parseSize(size)).toThrow(`Invalid size: ${size} is not a whole number of bytes`);
    }
  });

  // Whether a size is whole is a question about the decimal the operator
  // wrote, so it is answered exactly rather than on the double the quantity
  // parses to: that double misses in both directions.
  test('whole is decided on the decimal as written, not on its floating-point product', () => {
    // 1.001 × 1000 is 1000.9999999999999 in floating point, 2.01 × 1000 is
    // 2009.9999999999998; both sizes are whole.
    expect(parseSize('1.001KB')).toBe(1001);
    expect(parseSize('2.01KB')).toBe(2010);
    expect(parseSize('1.1KB')).toBe(1100);
    // 1.0000000000000001 parses to exactly 1, so its product is 1024; the size
    // is 1024.0000000000001024 bytes.
    expect(() => parseSize('1.0000000000000001K')).toThrow(/is not a whole number of bytes/);
    // 2^-50 written out is fifty decimals, and of a pebibyte it is one byte —
    // the longest fraction any unit can still make whole.  One digit more
    // cannot be.
    expect(parseSize('0.00000000000000088817841970012523233890533447265625PiB')).toBe(1);
    expect(() => parseSize('0.000000000000000888178419700125232338905334472656251PiB'))
      .toThrow(/is not a whole number of bytes/);
  });

  test('a number that is not a whole count of bytes is refused, as from code it is no size', () => {
    expect(() => parseSize(10.5)).toThrow('Invalid size: 10.5 is not a whole number of bytes');
    expect(() => parseSize(0.4)).toThrow('Invalid size: 0.4 is not a whole number of bytes');
    expect(parseSize(1420)).toBe(1420);
  });

  test('Config.getBytes refuses a fraction written with a unit, and hands a bare one on as it is', () => {
    // A bare number never reaches parseSize, so only a unit-less fraction
    // arrives at a whole-bytes check as a fraction.
    const config = Config.parseString('with-unit = 1420.5B\nbare = 1420.5');
    expect(() => config.getBytes('with-unit')).toThrow('Invalid size: 1420.5B is not a whole number of bytes');
    expect(config.getBytes('bare')).toBe(1420.5);
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
