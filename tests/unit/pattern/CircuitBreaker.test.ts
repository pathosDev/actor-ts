import { describe, expect, test } from 'bun:test';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerTimeoutError,
} from '../../../src/pattern/CircuitBreaker.js';
import { CircuitBreakerOptions } from '../../../src/pattern/CircuitBreakerOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { sleep } from '../../util/AwaitCondition.js';

describe('CircuitBreaker — basics', () => {
  test('starts closed and passes through successful calls', async () => {
    const breaker = new CircuitBreaker({ maxFailures: 3, resetTimeoutMs: 50 });
    expect(breaker.state).toBe('closed');
    const value = await breaker.call(async () => 42);
    expect(value).toBe(42);
    expect(breaker.state).toBe('closed');
  });

  test('opens after maxFailures consecutive failures', async () => {
    const breaker = new CircuitBreaker({ maxFailures: 2, resetTimeoutMs: 1_000 });
    for (let i = 0; i < 2; i++) {
      try { await breaker.call(async () => { throw new Error('boom'); }); }
      catch { /* expected */ }
    }
    expect(breaker.state).toBe('open');
  });

  test('open breaker rejects immediately with CircuitBreakerOpenError', async () => {
    const breaker = new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 1_000 });
    try { await breaker.call(async () => { throw new Error('x'); }); } catch { /* */ }
    let caught: unknown = null;
    try { await breaker.call(async () => 'never called'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CircuitBreakerOpenError);
  });

  test('half-opens after resetTimeoutMs; a success closes it', async () => {
    const breaker = new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 40 });
    try { await breaker.call(async () => { throw new Error('x'); }); } catch { /* */ }
    expect(breaker.state).toBe('open');

    // The elapsed time IS the assertion: 60 ms outlasts the 40 ms reset timeout,
    // which is the only thing that makes the next call half-open rather than
    // rejected.  The breaker has no timer and no event — it compares clocks on
    // `call()`, so there is nothing to poll for.
    await sleep(60);
    // First call after reset should move to half-open as part of .call().
    const value = await breaker.call(async () => 'ok');
    expect(value).toBe('ok');
    expect(breaker.state).toBe('closed');
  });

  test('half-open failure re-opens the breaker', async () => {
    const breaker = new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 30 });
    try { await breaker.call(async () => { throw new Error('x'); }); } catch { /* */ }
    // The elapsed time IS the assertion: 50 ms outlasts the 30 ms reset timeout, so
    // the failing call below is a half-open trial rather than a rejection.
    await sleep(50);
    try { await breaker.call(async () => { throw new Error('still flaky'); }); } catch { /* */ }
    expect(breaker.state).toBe('open');
  });
});

describe('CircuitBreaker — call timeout', () => {
  test('callTimeoutMs converts slow calls into failures', async () => {
    const breaker = new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 1_000, callTimeoutMs: 20 });
    let caught: unknown = null;
    try { await breaker.call(() => new Promise(() => { /* never resolves */ })); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CircuitBreakerTimeoutError);
    expect(breaker.state).toBe('open');
  });
});

describe('CircuitBreaker — filtering', () => {
  test('isFailure=false skips the failure count', async () => {
    const breaker = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000,
      isFailure: (err) => !(err.message === 'expected'),
    });
    try { await breaker.call(async () => { throw new Error('expected'); }); } catch { /* */ }
    expect(breaker.state).toBe('closed'); // error was not counted
  });

  test('onStateChange fires for transitions', async () => {
    const breaker = new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 20 });
    const states: string[] = [];
    breaker.onStateChange((s) => states.push(s));

    try { await breaker.call(async () => { throw new Error('x'); }); } catch { /* */ }
    // The elapsed time IS the assertion: 30 ms outlasts the 20 ms reset timeout, so
    // the exact transition sequence below includes 'half-open'.
    await sleep(30);
    await breaker.call(async () => 'ok'); // half-open → closed

    expect(states).toEqual(['open', 'half-open', 'closed']);
  });
});

// Options plumbing: builder parity + OptionsError validation, replacing the
// old bare-Error maxFailures/resetTimeoutMs guards and covering the
// previously-unvalidated callTimeoutMs and missing required fields.
describe('CircuitBreaker — options validation', () => {
  test('builder form is equivalent to a plain object', async () => {
    const breaker = new CircuitBreaker(CircuitBreakerOptions.create()
      .withMaxFailures(1)
      .withResetTimeoutMs(1_000));
    try { await breaker.call(async () => { throw new Error('x'); }); } catch { /* */ }
    expect(breaker.state).toBe('open');
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

  test('rejects a backoffFactor below 1 or non-finite with OptionsError', () => {
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10, backoffFactor: 0.5 }))
      .toThrow(OptionsError);
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10, backoffFactor: 0 }))
      .toThrow(/backoffFactor/);
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10, backoffFactor: Infinity }))
      .toThrow(/backoffFactor/);
    // 1 is the neutral value and has to stay legal — it is what reference.conf
    // publishes.
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10, backoffFactor: 1 }))
      .not.toThrow();
  });

  test('rejects a randomFactor outside [0, 1] with OptionsError', () => {
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10, randomFactor: -0.1 }))
      .toThrow(OptionsError);
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10, randomFactor: 1.5 }))
      .toThrow(/randomFactor/);
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10, randomFactor: 1 }))
      .not.toThrow();
  });

  test('rejects a non-positive maxResetTimeoutMs, and one below resetTimeoutMs', () => {
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10, maxResetTimeoutMs: 0 }))
      .toThrow(/maxResetTimeoutMs/);
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10, maxResetTimeoutMs: Infinity }))
      .toThrow(/maxResetTimeoutMs/);
    // The cross-field rule: a ceiling under the base window would silently
    // shorten the very first open, so it is refused rather than applied.
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 5_000, maxResetTimeoutMs: 1_000 }))
      .toThrow(/maxResetTimeoutMs/);
    // And against the EFFECTIVE ceiling, so an unset one is checked too — the
    // built-in ceiling is 60 s, and this window is longer.
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 300_000 }))
      .toThrow(/maxResetTimeoutMs/);
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 300_000, maxResetTimeoutMs: 600_000 }))
      .not.toThrow();
  });

  test('rejects an ignoredErrorNames member that is not a non-empty string', () => {
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10, ignoredErrorNames: [''] }))
      .toThrow(/ignoredErrorNames\[0\]/);
    expect(() => new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 10,
      ignoredErrorNames: ['Ok', 7 as unknown as string],
    })).toThrow(/ignoredErrorNames\[1\]/);
    // `[]` is the neutral value and the one reference.conf publishes, so
    // `nonEmptyArray` would have been the wrong rule.
    expect(() => new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 10, ignoredErrorNames: [] }))
      .not.toThrow();
  });
});

/**
 * The reopen window is no longer a constant, so it is asserted through
 * `nextProbeAt` rather than by outlasting it with `sleep`.  A growing window
 * measured that way gets slower and flakier with every cycle; this reads the
 * schedule the breaker just computed, with no timer and no wall-clock wait.
 */
describe('CircuitBreaker — reopen backoff', () => {
  /**
   * Force one more open cycle and bracket the delay it scheduled.
   *
   * `nextProbeAt` is `Date.now() + delay` sampled somewhere between the two
   * readings here, so the true delay lies in `[low, high]` and the width of
   * that interval is the wall time of one synchronous `setState`.  The width
   * is asserted too — without it a slow clock would widen the bracket until it
   * admitted the wrong answer, which is a guard that stops guarding.
   */
  function scheduleNextOpen(breaker: CircuitBreaker): { low: number; high: number } {
    if (breaker.state === 'open') breaker.setState('half-open');
    const before = Date.now();
    breaker.setState('open');
    const after = Date.now();
    return { low: breaker.nextProbeAt - after, high: breaker.nextProbeAt - before };
  }

  function expectDelay(scheduled: { low: number; high: number }, expected: number): void {
    expect(scheduled.low).toBeLessThanOrEqual(expected);
    expect(scheduled.high).toBeGreaterThanOrEqual(expected);
    expect(scheduled.high - scheduled.low).toBeLessThanOrEqual(50);
  }

  test('backoffFactor 1 keeps the flat window every earlier release had', () => {
    const breaker = new CircuitBreaker({ maxFailures: 1, resetTimeoutMs: 1_000 });
    expectDelay(scheduleNextOpen(breaker), 1_000);
    expectDelay(scheduleNextOpen(breaker), 1_000);
    expectDelay(scheduleNextOpen(breaker), 1_000);
  });

  test('the window grows by backoffFactor once per consecutive open', () => {
    const breaker = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000, backoffFactor: 2, maxResetTimeoutMs: 60_000,
    });
    expectDelay(scheduleNextOpen(breaker), 1_000);
    expect(breaker.consecutiveOpens).toBe(1);
    expectDelay(scheduleNextOpen(breaker), 2_000);
    expectDelay(scheduleNextOpen(breaker), 4_000);
    expect(breaker.consecutiveOpens).toBe(3);
  });

  test('maxResetTimeoutMs is the ceiling the growth stops at', () => {
    const breaker = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000, backoffFactor: 10, maxResetTimeoutMs: 5_000,
    });
    expectDelay(scheduleNextOpen(breaker), 1_000);
    expectDelay(scheduleNextOpen(breaker), 5_000);  // 10_000, clamped
    expectDelay(scheduleNextOpen(breaker), 5_000);  // 100_000, clamped
  });

  test('closing resets the exponent, so a recovered dependency starts over', () => {
    const breaker = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000, backoffFactor: 4, maxResetTimeoutMs: 60_000,
    });
    expectDelay(scheduleNextOpen(breaker), 1_000);
    expectDelay(scheduleNextOpen(breaker), 4_000);

    breaker.setState('half-open');
    breaker.setState('closed');
    expect(breaker.consecutiveOpens).toBe(0);

    expectDelay(scheduleNextOpen(breaker), 1_000);
  });

  test('a failing half-open probe is what grows the window in normal operation', async () => {
    const breaker = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 0, backoffFactor: 2, maxResetTimeoutMs: 60_000,
    });
    // resetTimeoutMs 0 means the next call always probes, so three failures
    // walk the state machine open -> half-open -> open twice with no waiting.
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(breaker.call(async () => { throw new Error('still down'); }))
        .rejects.toThrow('still down');
    }
    expect(breaker.state).toBe('open');
    expect(breaker.consecutiveOpens).toBe(3);
  });

  test('randomFactor spreads the window around the computed base', () => {
    // `random()` maps [0, 1) onto a multiplier of [1 - randomFactor,
    // 1 + randomFactor); two exact points pin that affine map, and a third
    // catches a sign or a halving error.
    const lower = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000, randomFactor: 0.5, random: () => 0,
    });
    expectDelay(scheduleNextOpen(lower), 500);

    const middle = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000, randomFactor: 0.5, random: () => 0.5,
    });
    expectDelay(scheduleNextOpen(middle), 1_000);

    const upper = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000, randomFactor: 0.5, random: () => 0.75,
    });
    expectDelay(scheduleNextOpen(upper), 1_250);
  });

  test('jitter applies to the grown window, not to the base one', () => {
    const breaker = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000, backoffFactor: 2,
      maxResetTimeoutMs: 60_000, randomFactor: 0.5, random: () => 0,
    });
    expectDelay(scheduleNextOpen(breaker), 500);    // 1_000 grown by 2^0, then halved
    expectDelay(scheduleNextOpen(breaker), 1_000);  // 2_000 grown by 2^1, then halved
  });
});

describe('CircuitBreaker — ignored error names', () => {
  /** Throw `name` from a breaker call and hand back the error it rejected with. */
  async function callThrowing(breaker: CircuitBreaker, name: string): Promise<Error> {
    const thrown = new Error(`${name} happened`);
    thrown.name = name;
    let caught: unknown;
    try { await breaker.call(async () => { throw thrown; }); } catch (e) { caught = e; }
    expect(caught).toBe(thrown);
    return thrown;
  }

  test('a listed name never counts, and still rejects to the caller', async () => {
    const breaker = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000, ignoredErrorNames: ['ValidationError'],
    });
    await callThrowing(breaker, 'ValidationError');
    await callThrowing(breaker, 'ValidationError');
    expect(breaker.state).toBe('closed');
  });

  test('an unlisted name still opens the breaker', async () => {
    const breaker = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000, ignoredErrorNames: ['ValidationError'],
    });
    await callThrowing(breaker, 'SocketError');
    expect(breaker.state).toBe('open');
  });

  test('the list wins over isFailure, whichever way isFailure votes', async () => {
    // The precedence #864 pins: the name list is the operator's half of the
    // classifier and arrives from a config file, so a compiled predicate must
    // not be able to overrule it — otherwise the leaf goes inert for exactly
    // the deployments that set it.
    const listedButCounted = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000,
      ignoredErrorNames: ['ValidationError'],
      isFailure: () => true,
    });
    await callThrowing(listedButCounted, 'ValidationError');
    expect(listedButCounted.state).toBe('closed');

    // And in the other direction: for an UNlisted name isFailure still decides.
    const unlistedAndExcused = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000,
      ignoredErrorNames: ['ValidationError'],
      isFailure: () => false,
    });
    await callThrowing(unlistedAndExcused, 'SocketError');
    expect(unlistedAndExcused.state).toBe('closed');
  });

  test('CircuitBreakerTimeoutError is listable, and then a slow call is free', async () => {
    const breaker = new CircuitBreaker({
      maxFailures: 1, resetTimeoutMs: 1_000, callTimeoutMs: 20,
      ignoredErrorNames: ['CircuitBreakerTimeoutError'],
    });
    let caught: unknown = null;
    try { await breaker.call(() => new Promise(() => { /* never resolves */ })); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CircuitBreakerTimeoutError);
    // Surprising, coherent, and documented: a call that blew its own deadline
    // does not count against the breaker.
    expect(breaker.state).toBe('closed');
  });
});
