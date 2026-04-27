import { afterEach, describe, expect, test } from 'bun:test';
import {
  detectRuntime,
  hasBun,
  hasDeno,
  highResNow,
  setRuntimeOverride,
} from '../../../src/runtime/detect.js';

afterEach(() => setRuntimeOverride(null));

describe('runtime/detect', () => {
  test('detectRuntime returns bun under a real Bun process', () => {
    // The test suite runs under `bun:test`, so real detection must be 'bun'.
    expect(detectRuntime()).toBe('bun');
    expect(hasBun()).toBe(true);
    expect(hasDeno()).toBe(false);
  });

  test('setRuntimeOverride forces the detected runtime (for tests)', () => {
    setRuntimeOverride('node');
    expect(detectRuntime()).toBe('node');
    setRuntimeOverride('deno');
    expect(detectRuntime()).toBe('deno');
    setRuntimeOverride(null);
    expect(detectRuntime()).toBe('bun');
  });

  test('highResNow returns a monotonically increasing number', () => {
    const a = highResNow();
    // Busy-wait a touch so the subsequent call is guaranteed to differ even
    // on low-resolution fallbacks.
    for (let i = 0; i < 1_000; i++) Math.sin(i);
    const b = highResNow();
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');
    expect(b).toBeGreaterThanOrEqual(a);
  });

  test('highResNow output scale is nanoseconds (~1e9 per second)', async () => {
    const a = highResNow();
    await new Promise((r) => setTimeout(r, 10));
    const b = highResNow();
    const delta = b - a;
    // 10ms ≈ 1e7 ns.  Allow a wide band to tolerate scheduler jitter.
    expect(delta).toBeGreaterThan(1_000_000);
    expect(delta).toBeLessThan(1_000_000_000);
  });
});
