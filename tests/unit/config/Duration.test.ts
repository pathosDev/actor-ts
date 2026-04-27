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

  test('rejects malformed strings', () => {
    expect(() => parseDuration('abc')).toThrow(/Invalid duration/);
    expect(() => parseDuration('5.5.5s')).toThrow();
  });

  test('supports nano and micro units (fractional ms)', () => {
    expect(parseDuration('1_000_000ns'.replace(/_/g, ''))).toBe(1);
    expect(parseDuration('1000μs')).toBe(1);
  });
});
