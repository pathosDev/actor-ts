import { describe, expect, test } from 'bun:test';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerTimeoutError,
} from '../../../src/pattern/CircuitBreaker.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('CircuitBreaker — basics', () => {
  test('starts closed and passes through successful calls', async () => {
    const cb = new CircuitBreaker({ maxFailures: 3, resetTimeoutMs: 50 });
    expect(cb.state).toBe('closed');
    const v = await cb.call(async () => 42);
    expect(v).toBe(42);
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
    const v = await cb.call(async () => 'ok');
    expect(v).toBe('ok');
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

describe('CircuitBreaker — options validation', () => {
  test('maxFailures < 1 throws', () => {
    expect(() => new CircuitBreaker({ maxFailures: 0, resetTimeoutMs: 10 })).toThrow(/maxFailures/);
  });
  test('resetTimeoutMs < 0 throws', () => {
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: -1 })).toThrow(/resetTimeoutMs/);
  });
});
