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
});
