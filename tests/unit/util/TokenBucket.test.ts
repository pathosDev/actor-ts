/**
 * Pure tests for `TokenBucket`.  Time is injected so the suite never
 * has to `await sleep(...)` — every refill happens by advancing the
 * mock clock and re-querying the bucket.
 */
import { describe, expect, test } from 'bun:test';
import { TokenBucket } from '../../../src/util/TokenBucket.js';

/** Helper: a mutable mock clock starting at a fixed wall-clock instant. */
function mockClock(start: number = 1_000_000): { now: () => number; advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance(ms: number): void { t += ms; },
  };
}

describe('TokenBucket', () => {
  test('starts full and lets a burst of `burst` messages through immediately', () => {
    const c = mockClock();
    const bucket = new TokenBucket({ qps: 10, burst: 5, now: c.now });
    // 5 burst tokens → 5 immediate consumes succeed, the 6th fails.
    for (let i = 0; i < 5; i++) {
      expect(bucket.tryConsume(1)).toBe(true);
    }
    expect(bucket.tryConsume(1)).toBe(false);
  });

  test('refills tokens at qps rate over wall-clock time', () => {
    const c = mockClock();
    const bucket = new TokenBucket({ qps: 10, burst: 5, now: c.now });
    // Drain the bucket.
    while (bucket.tryConsume(1)) { /* drain */ }
    expect(bucket.tryConsume(1)).toBe(false);

    // 100 ms at 10 qps = 1 token earned.
    c.advance(100);
    expect(bucket.tryConsume(1)).toBe(true);
    expect(bucket.tryConsume(1)).toBe(false);

    // 500 ms more at 10 qps = 5 tokens earned, capped at burst (5).
    c.advance(500);
    for (let i = 0; i < 5; i++) {
      expect(bucket.tryConsume(1)).toBe(true);
    }
    expect(bucket.tryConsume(1)).toBe(false);
  });

  test('partial consumption is all-or-nothing', () => {
    const c = mockClock();
    const bucket = new TokenBucket({ qps: 10, burst: 5, now: c.now });
    // Try to consume 7 from a 5-burst bucket → fail, no partial deduct.
    expect(bucket.tryConsume(7)).toBe(false);
    // Bucket still has the original 5 tokens.
    for (let i = 0; i < 5; i++) {
      expect(bucket.tryConsume(1)).toBe(true);
    }
  });

  test('default burst equals qps when omitted', () => {
    const c = mockClock();
    const bucket = new TokenBucket({ qps: 7, now: c.now });
    // Default burst = qps = 7.
    for (let i = 0; i < 7; i++) {
      expect(bucket.tryConsume(1)).toBe(true);
    }
    expect(bucket.tryConsume(1)).toBe(false);
  });

  test('timeUntilNext reports 0 when tokens are available, ms otherwise', () => {
    const c = mockClock();
    const bucket = new TokenBucket({ qps: 10, burst: 5, now: c.now });
    expect(bucket.timeUntilNext(1)).toBe(0); // bucket starts full

    while (bucket.tryConsume(1)) { /* drain */ }
    // 0 tokens, qps=10 → 1 token in 100 ms.
    expect(bucket.timeUntilNext(1)).toBe(100);
    // Need 3 tokens → 300 ms.
    expect(bucket.timeUntilNext(3)).toBe(300);

    // After 50 ms, 0.5 tokens earned → still need 50 ms for the first
    // whole token.
    c.advance(50);
    expect(bucket.timeUntilNext(1)).toBe(50);
  });

  test('rejects qps and burst values that aren\'t finite positive numbers', () => {
    expect(() => new TokenBucket({ qps: 0 })).toThrow(/qps/);
    expect(() => new TokenBucket({ qps: -1 })).toThrow(/qps/);
    expect(() => new TokenBucket({ qps: NaN })).toThrow(/qps/);
    expect(() => new TokenBucket({ qps: 10, burst: 0 })).toThrow(/burst/);
    expect(() => new TokenBucket({ qps: 10, burst: -2 })).toThrow(/burst/);
  });

  test('resetToFull restores capacity and resets the refill clock', () => {
    const c = mockClock();
    const bucket = new TokenBucket({ qps: 10, burst: 5, now: c.now });
    while (bucket.tryConsume(1)) { /* drain */ }
    expect(bucket.currentTokens()).toBe(0);
    bucket.resetToFull();
    expect(bucket.currentTokens()).toBe(5);
  });

  test('currentTokens reflects elapsed time since the last refill', () => {
    const c = mockClock();
    const bucket = new TokenBucket({ qps: 100, burst: 10, now: c.now });
    while (bucket.tryConsume(1)) { /* drain */ }
    expect(bucket.currentTokens()).toBe(0);
    c.advance(50); // 50 ms × 100 qps / 1000 = 5 tokens earned.
    expect(bucket.currentTokens()).toBeCloseTo(5);
    c.advance(1_000); // way past capacity → cap at burst.
    expect(bucket.currentTokens()).toBe(10);
  });
});
