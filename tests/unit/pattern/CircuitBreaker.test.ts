import { describe, expect, test } from 'bun:test';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerTimeoutError,
} from '../../../src/pattern/CircuitBreaker.js';
import { CircuitBreakerOptions } from '../../../src/pattern/CircuitBreakerOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('CircuitBreaker — basics', () => {
  test('starts closed and passes through successful calls', async () => {
    const cb = new CircuitBreaker({ maxFailures: 3, resetTimeoutMs: 50 });
    expect(cb.state).toBe('closed');
    const value = await cb.call(async () => 42);
    expect(value).toBe(42);
    expect(cb.state).toBe('closed');
  });

  test('opens after maxFailures consecutive failures', async () => {
    const cb = new CircuitBreaker({ maxFailures: 2, resetTimeoutMs: 1_000 });
    for (let i = 0; i < 2; i++) {
      try { await cb.call(async () => { throw new Error('boom'); }); }
      catch { /* expected */ }
    }
    expect(cb.state).toBe('open');
  });

  test('open breaker rejects immediately with CircuitBreakerOpenError', async () => {
    const cb = new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 1_000 });
    try { await cb.call(async () => { throw new Error('x'); }); } catch { /* */ }
    let caught: unknown = null;
    try { await cb.call(async () => 'never called'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CircuitBreakerOpenError);
  });

  test('half-opens after resetTimeoutMs; a success closes it', async () => {
    const cb = new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 40 });
    try { await cb.call(async () => { throw new Error('x'); }); } catch { /* */ }
    expect(cb.state).toBe('open');

    await sleep(60);
    // First call after reset should move to half-open as part of .call().
    const value = await cb.call(async () => 'ok');
    expect(value).toBe('ok');
    expect(cb.state).toBe('closed');
  });

  test('half-open failure re-opens the breaker', async () => {
    const cb = new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 30 });
    try { await cb.call(async () => { throw new Error('x'); }); } catch { /* */ }
    await sleep(50);
    try { await cb.call(async () => { throw new Error('still flaky'); }); } catch { /* */ }
    expect(cb.state).toBe('open');
  });
});

describe('CircuitBreaker — call timeout', () => {
  test('callTimeoutMs converts slow calls into failures', async () => {
    const cb = new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 1_000, callTimeoutMs: 20 });
    let caught: unknown = null;
    try { await cb.call(() => new Promise(() => { /* never resolves */ })); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CircuitBreakerTimeoutError);
    expect(cb.state).toBe('open');
  });
});

describe('CircuitBreaker — filtering', () => {
  test('isFailure=false skips the failure count', async () => {
    const cb = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000,
      isFailure: (err) => !(err.message === 'expected'),
    });
    try { await cb.call(async () => { throw new Error('expected'); }); } catch { /* */ }
    expect(cb.state).toBe('closed'); // error was not counted
  });

  test('onStateChange fires for transitions', async () => {
    const cb = new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 20 });
    const states: string[] = [];
    cb.onStateChange((s) => states.push(s));

    try { await cb.call(async () => { throw new Error('x'); }); } catch { /* */ }
    await sleep(30);
    await cb.call(async () => 'ok'); // half-open → closed

    expect(states).toEqual(['open', 'half-open', 'closed']);
  });
});

// Options plumbing: builder parity + OptionsError validation, replacing the
// old bare-Error maxFailures/resetTimeoutMs guards and covering the
// previously-unvalidated callTimeoutMs and missing required fields.
describe('CircuitBreaker — options validation', () => {
  test('builder form is equivalent to a plain object', async () => {
    const cb = new CircuitBreaker(CircuitBreakerOptions.create()
      .withMaxFailures(1)
      .withResetTimeoutMs(1_000));
    try { await cb.call(async () => { throw new Error('x'); }); } catch { /* */ }
    expect(cb.state).toBe('open');
  });

  test('rejects a non-positive / non-integer maxFailures with OptionsError', () => {
    expect(() => new CircuitBreaker({ maxFailures: 0, resetTimeoutMs: 10 })).toThrow(OptionsError);
    expect(() => new CircuitBreaker({ maxFailures: -1, resetTimeoutMs: 10 })).toThrow(/maxFailures/);
    expect(() => new CircuitBreaker({ maxFailures: 2.5, resetTimeoutMs: 10 })).toThrow(/maxFailures/);
  });

  test('rejects a negative / non-finite resetTimeoutMs with OptionsError', () => {
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: -1 })).toThrow(OptionsError);
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: Number.NaN })).toThrow(/resetTimeoutMs/);
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: Infinity })).toThrow(/resetTimeoutMs/);
  });

  test('rejects a non-positive callTimeoutMs with OptionsError (omit it to disable)', () => {
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10, callTimeoutMs: 0 })).toThrow(OptionsError);
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10, callTimeoutMs: -5 })).toThrow(/callTimeoutMs/);
  });

  test('rejects missing required fields with OptionsError (builder path)', () => {
    expect(() => new CircuitBreaker(CircuitBreakerOptions.create())).toThrow(OptionsError);
    expect(() => new CircuitBreaker(CircuitBreakerOptions.create().withMaxFailures(1))).toThrow(/resetTimeoutMs/);
  });

  test('accepts resetTimeoutMs 0 (immediate probe)', () => {
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 0 })).not.toThrow();
  });
});
