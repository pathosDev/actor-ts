import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { after, pipeTo, retry, Success, Failure } from '../../../src/pattern/index.js';
import type { RetryOptions } from '../../../src/pattern/index.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { minimumElapsedMs } from '../../util/TimerTolerance.js';
import { sleep } from '../../util/AwaitCondition.js';

describe('pipeTo', () => {
  test('resolves pipe the value as Success by default', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('pipe-s', kitOptions);
    const probe = kit.createTestProbe();
    const promise = Promise.resolve(42);
    pipeTo(promise, probe);
    const got = await probe.receiveOne(200);
    expect(got).toBeInstanceOf(Success);
    expect((got as Success<number>).value).toBe(42);
    await kit.system.terminate();
  });

  test('rejections pipe as Failure', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('pipe-f', kitOptions);
    const probe = kit.createTestProbe();
    pipeTo(Promise.reject(new Error('boom')), probe);
    const got = await probe.receiveOne(200);
    expect(got).toBeInstanceOf(Failure);
    expect((got as Failure).cause.message).toBe('boom');
    await kit.system.terminate();
  });

  test('wrap=false sends raw value, drops rejections', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('pipe-raw', kitOptions);
    const probe = kit.createTestProbe();
    pipeTo(Promise.resolve({ ok: 1 }), probe, { wrap: false });
    const got = await probe.receiveOne(200);
    expect(got).toEqual({ ok: 1 });

    pipeTo(Promise.reject(new Error('ignored')), probe, { wrap: false });
    await probe.expectNoMessage(60);
    await kit.system.terminate();
  });

  test('delivers through an actor with sender attribution', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('pipe-sender', kitOptions);
    const probe = kit.createTestProbe();

    class Holder extends Actor<Success<string>> {
      override onReceive(m: Success<string>): void {
        probe.tell({ value: m.value, sender: this.sender.map((s) => s.path.name).toNullable() });
      }
    }
    const holder = kit.system.spawnAnonymous(Holder);
    pipeTo(Promise.resolve('hello'), holder, { sender: probe });

    const got = await probe.receiveOne(200) as { value: string; sender: string | null };
    expect(got.value).toBe('hello');
    expect(got.sender).toBe(probe.path.name);
    await kit.system.terminate();
  });
});

describe('after', () => {
  test('resolves with the factory value after the delay', async () => {
    const delayMs = 30;
    let invoked = false;
    const start = performance.now();
    const promise = after(delayMs, () => { invoked = true; return Promise.resolve('done'); });
    // The deterministic half of the contract: the factory waits for the
    // timer instead of running on the way in.
    expect(invoked).toBe(false);
    const value = await promise;
    const elapsed = performance.now() - start;
    expect(invoked).toBe(true);
    expect(value).toBe('done');
    // Only claims "a real timer elapsed" — see TimerTolerance for why a
    // bound anywhere near 30 ms flakes (#477).
    expect(elapsed).toBeGreaterThanOrEqual(minimumElapsedMs(delayMs));
  });

  test('propagates rejection from the factory', async () => {
    let caught: unknown = null;
    try {
      await after(10, () => Promise.reject(new Error('later-fail')));
    } catch (e) { caught = e; }
    expect((caught as Error).message).toBe('later-fail');
  });

  test('cancel() aborts before firing', async () => {
    const promise = after(200, () => Promise.resolve('never'));
    promise.cancel();
    let caught: unknown = null;
    try { await promise; } catch (e) { caught = e; }
    expect((caught as Error).message).toContain('cancelled');
  });
});

describe('retry', () => {
  test('returns first success within attempts', async () => {
    let calls = 0;
    const value = await retry(async () => {
      calls++;
      if (calls < 3) throw new Error('nope');
      return 'win';
    }, { attempts: 5, delayMs: 1 });
    expect(value).toBe('win');
    expect(calls).toBe(3);
  });

  test('throws the last error when attempts exhausted', async () => {
    let calls = 0;
    let caught: unknown = null;
    try {
      await retry(async () => {
        calls++;
        throw new Error(`fail-${calls}`);
      }, { attempts: 3, delayMs: 1 });
    } catch (e) { caught = e; }
    expect(calls).toBe(3);
    expect((caught as Error).message).toBe('fail-3');
  });

  test('shouldRetry=false short-circuits', async () => {
    let calls = 0;
    class FatalError extends Error {}
    let caught: unknown = null;
    try {
      await retry(async () => {
        calls++;
        throw new FatalError('stop');
      }, { attempts: 5, delayMs: 1, shouldRetry: (err) => !(err instanceof FatalError) });
    } catch (e) { caught = e; }
    expect(calls).toBe(1);
    expect(caught).toBeInstanceOf(FatalError);
  });

  test('exponential backoff respects maxDelayMs', async () => {
    // Virtual time, via the `sleep` seam.  On the wall clock a 30ms timer
    // lands anywhere between ~19ms and ~200ms (#477), so no tolerance can
    // both survive the jitter and still tell a delay capped at 30ms apart
    // from an uncapped 40ms one.  ManualScheduler fires each sleep
    // synchronously, so the schedule is exact and the test costs no time.
    const scheduler = new ManualScheduler();
    const attemptTimes: number[] = [];
    let calls = 0;
    try {
      await retry(async () => {
        calls++;
        attemptTimes.push(scheduler.now());
        throw new Error('fail');
      }, {
        attempts: 3,
        delayMs: 20,
        factor: 2,
        maxDelayMs: 30,
        sleep: (ms) => new Promise<void>((resolve) => {
          scheduler.scheduleOnceFunction(ms, resolve);
          scheduler.advance(ms);
        }),
      });
    } catch { /* ignore */ }
    expect(calls).toBe(3);
    // Waits of 20ms, then 40ms (20 × 2) clamped to maxDelayMs = 30.
    expect(attemptTimes).toEqual([0, 20, 50]);
  });

  test('onAttempt hook fires for each failure', async () => {
    const errors: string[] = [];
    try {
      await retry(async () => { throw new Error('x'); }, {
        attempts: 3, delayMs: 1,
        onAttempt: (err, n) => errors.push(`${n}:${err.message}`),
      });
    } catch { /* ignore */ }
    expect(errors).toEqual(['1:x', '2:x', '3:x']);
  });

  test('attempts must be >= 1', async () => {
    let caught: unknown = null;
    try {
      await retry(async () => 1, { attempts: 0 });
    } catch (e) { caught = e; }
    expect((caught as Error).message).toContain('>= 1');
  });

  /**
   * `NaN` is the fifth route into the same family, and the only one that
   * never reaches the loop body at all (#1509).
   *
   * `NaN < 1` is false, so the refusal above is skipped; `attempt <= max` is
   * then false on the very first iteration, so the loop never runs; and
   * control falls through to the line that rethrows `lastError`, which is
   * still `undefined`.  The caller gets a bare `Error` whose entire message
   * is the string `"undefined"`, from a call that never touched the
   * dependency — measured at the unrepaired tip: `calls=0 -> Error:
   * undefined`.  That is worse than the delay knobs' failure, not better:
   * there the work at least happened, here `retry` reports a failure it
   * never attempted, and the diagnostic names neither the option nor the
   * value.
   *
   * `Number.isNaN` rather than `!Number.isFinite`, deliberately, and this is
   * the whole of the difference: `attempts: Number.POSITIVE_INFINITY` is a
   * working "retry until it succeeds" idiom — measured, `calls=4 -> resolved
   * ok` against a factory that fails three times — and refusing it would
   * narrow an accepted input domain for no defect.  Same shape as the
   * `maxDelayMs` guard, which keeps `Infinity` legal for the same kind of
   * reason.
   */
  test('a NaN attempts is refused rather than reported as `Error: undefined`', async () => {
    let calls = 0;
    let caught: unknown = null;
    try {
      await retry(async () => { calls++; return 1; }, { attempts: Number.NaN });
    } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(OptionsError);
    expect((caught as OptionsError).field).toBe('attempts');
    expect((caught as OptionsError).options).toBe('retry');
    // The value is in the diagnostic, rendered the way every other refused
    // option renders one.
    expect((caught as Error).message).toContain('NaN');
    expect(calls).toBe(0);

    // The edge the refusal must not take with it: an unbounded attempt count
    // is a legal schedule, and it retries until the factory stops failing.
    let unboundedCalls = 0;
    const value = await retry(async () => {
      unboundedCalls++;
      if (unboundedCalls <= 3) throw new Error('down');
      return 'ok';
    }, { attempts: Number.POSITIVE_INFINITY, delayMs: 0, sleep: () => Promise.resolve() });
    expect(value).toBe('ok');
    expect(unboundedCalls).toBe(4);
  });

  test('an omitted maxDelayMs caps every delay at the built-in ceiling', async () => {
    // `maxDelayMs` defaults to 60 000 rather than to infinity (#771).  The
    // same configuration that used to climb until the timer clamp caught it
    // now flattens at one minute, and the assertion is the whole schedule
    // rather than "some finite number" — 60 000 is a *default*, so nothing
    // else in the tree states it.
    const requestedDelays: number[] = [];
    try {
      await retry(async () => { throw new Error('fail'); }, {
        attempts: 4,
        delayMs: 1_000,
        factor: 10_000,
        sleep: (ms) => { requestedDelays.push(ms); return Promise.resolve(); },
      });
    } catch { /* expected */ }
    // 1e3, then 1e7 and 1e11 both cut down to the 60 s ceiling.
    expect(requestedDelays).toEqual([1_000, 60_000, 60_000]);
  });

  test('maxDelayMs: Infinity restores the uncapped schedule, still clamped to the 32-bit timer limit', async () => {
    // The escape hatch back to the pre-#771 default, and the reason the hard
    // clamp survives the finite default rather than being replaced by it:
    // with no cap and `factor > 1` the computed delay crosses 2_147_483_647
    // ms, where `setTimeout` coerces its argument to a 32-bit signed integer
    // and fires after 1 ms instead — inverting the backoff into a hot loop
    // against the dependency that is already down.  The `sleep` seam records
    // the number `retry` asked for, which is exactly the value that would
    // otherwise reach the timer.
    const requestedDelays: number[] = [];
    try {
      await retry(async () => { throw new Error('fail'); }, {
        attempts: 4,
        delayMs: 1_000,
        factor: 10_000,
        maxDelayMs: Number.POSITIVE_INFINITY,
        sleep: (ms) => { requestedDelays.push(ms); return Promise.resolve(); },
      });
    } catch { /* expected */ }
    // 1e3, 1e7, then 1e11 — the third would overflow, and lands on the clamp.
    expect(requestedDelays).toEqual([1_000, 10_000_000, 2_147_483_647]);
    for (const ms of requestedDelays) expect(ms).toBeLessThanOrEqual(2_147_483_647);
  });

  test('randomFactor: 1 over an infinite maxDelayMs jitters the timer ceiling, never Infinity', async () => {
    // The second half of #771, and the one the clamp's original placement
    // left open: it ran *after* the jitter only, so with
    // `maxDelayMs: Number.POSITIVE_INFINITY` the jitter multiplied an
    // infinite base.  `randomFactor: 1` is the only width whose lower edge is
    // a multiplier of exactly zero, and `Infinity × 0` is `NaN`, which
    // `Math.max`, `Math.min` and finally `delay > 0` all carry silently — so
    // the sleep is skipped altogether and `retry` busy-loops.  Clamping
    // *before* the jitter too makes the base finite, and a finite base cannot
    // produce `NaN`.
    //
    // The `NaN` itself is deliberately not the assertion: at a multiplier of
    // zero a finite base yields a legitimate delay of 0, so the skipped sleep
    // looks identical either way.  What separates the two trees is every
    // *other* draw — a jittered fraction of the ceiling, versus the ceiling
    // flat, because `Infinity × anything positive` is `Infinity` again.
    //
    // `delayMs × factor^n` has to overflow the double, not the timer, for the
    // base to reach `Infinity` at all, hence the outsized numbers.
    const randomDraws = [0, 0.25, 1];
    let draw = 0;
    const requestedDelays: number[] = [];
    try {
      await retry(async () => { throw new Error('fail'); }, {
        attempts: 4,
        delayMs: 1e308,
        factor: 1e10,
        maxDelayMs: Number.POSITIVE_INFINITY,
        randomFactor: 1,
        random: () => randomDraws[draw++] ?? 0,
        sleep: (ms) => { requestedDelays.push(ms); return Promise.resolve(); },
      });
    } catch { /* expected */ }
    // Draw 0 → multiplier 0 → a delay of 0, which is not slept on.  Draw 0.25
    // → multiplier 0.5 → half the ceiling; draw 1 → multiplier 2 → the
    // ceiling.  Against an infinite base both of the latter would be the
    // ceiling flat.
    expect(requestedDelays).toEqual([2_147_483_647 / 2, 2_147_483_647]);
    for (const ms of requestedDelays) expect(Number.isNaN(ms)).toBe(false);
  });

  test('randomFactor jitters the delay from the injected random source', async () => {
    // Two runs differing only in the random source must produce different
    // schedules — the herd-synchronisation half of #771.  `random` is the
    // same escape hatch `exponentialBackoff` exposes, so this asserts the
    // exact schedule rather than a statistical property.
    const scheduleWith = async (random: () => number, randomFactor?: number): Promise<number[]> => {
      const requestedDelays: number[] = [];
      try {
        await retry(async () => { throw new Error('fail'); }, {
          attempts: 3,
          delayMs: 100,
          factor: 2,
          randomFactor,
          random,
          sleep: (ms) => { requestedDelays.push(ms); return Promise.resolve(); },
        });
      } catch { /* expected */ }
      return requestedDelays;
    };

    // random() = 0 maps to the -randomFactor edge, 1 to the +randomFactor one.
    expect(await scheduleWith(() => 0, 0.5)).toEqual([50, 100]);
    expect(await scheduleWith(() => 1, 0.5)).toEqual([150, 300]);
    expect(await scheduleWith(() => 0.5, 0.5)).toEqual([100, 200]);
    // Omitting randomFactor leaves the schedule deterministic even with a
    // random source in hand — the contract every caller written before this
    // option had.
    expect(await scheduleWith(() => 1)).toEqual([100, 200]);
  });

  /**
   * The zero-jitter fast path (`Retry.applyJitter`) returns `base` without
   * consulting `random` at all, and that is the half of it a schedule
   * assertion cannot see: `1 + (r × 2 − 1) × 0` is `1` for every `r`, so the
   * delays come out identical either way.  The observable difference is the
   * *draw*, and it matters because `random` is an injection point — a caller
   * threading one deterministic source through several primitives has its
   * sequence shifted by every draw somebody takes without needing it, and
   * `randomFactor` defaults to `0`, so that is the path every pre-existing
   * caller of `retry` is on.
   */
  test('a zero randomFactor takes no draw from the injected random source', async () => {
    let draws = 0;
    const requestedDelays: number[] = [];
    const counting = (): number => { draws++; return 1; };
    try {
      await retry(async () => { throw new Error('fail'); }, {
        attempts: 3,
        delayMs: 100,
        factor: 2,
        random: counting,
        sleep: (ms) => { requestedDelays.push(ms); return Promise.resolve(); },
      });
    } catch { /* expected */ }
    // Two delays were computed, so the jitter helper ran twice and declined
    // to draw both times.
    expect(requestedDelays).toEqual([100, 200]);
    expect(draws).toBe(0);
  });

  /**
   * Both edges of the interval the message names, not just the upper one.
   *
   * A **negative** `randomFactor` is the half that had no test, and it is the
   * dangerous one: the multiplier is `1 + (r × 2 − 1) × randomFactor`, so a
   * factor below `-1` drives it under zero, the floor in `applyJitter` turns
   * that into `0`, and `if (delay > 0)` then skips the sleep entirely.  The
   * result is `retry` hammering a dependency that is already failing — the
   * same busy-loop the 32-bit timer clamp exists to prevent (#771), arrived at
   * from the other direction.
   */
  test('randomFactor must be in [0, 1] — both edges', async () => {
    const rejectedBy = async (randomFactor: number): Promise<string> => {
      try {
        await retry(async () => 1, { attempts: 2, delayMs: 1, randomFactor });
        return 'not rejected';
      } catch (e) { return (e as Error).message; }
    };

    expect(await rejectedBy(1.5)).toContain('randomFactor must be in [0, 1] (got 1.5)');
    expect(await rejectedBy(-0.2)).toContain('randomFactor must be in [0, 1] (got -0.2)');
    // The value that actually zeroes the delay, spelled out: without the
    // lower-bound check this one retries with no wait at all.
    expect(await rejectedBy(-5)).toContain('randomFactor must be in [0, 1] (got -5)');

    // The closed interval is closed: both endpoints are accepted, so the
    // guard cannot be tightened into rejecting the documented extremes.
    expect(await retry(async () => 'ok', { attempts: 2, delayMs: 1, randomFactor: 0 })).toBe('ok');
    expect(await retry(async () => 'ok', { attempts: 2, delayMs: 1, randomFactor: 1 })).toBe('ok');
  });

  /**
   * The rest of the schedule is validated too, and for the same reason as
   * `randomFactor` (#771, #1509).
   *
   * `attempts` and `randomFactor` were checked; `delayMs`, `factor` and
   * `maxDelayMs` were not, and every malformed value of the three lands on the
   * same outcome — `if (delay > 0)` is false and the wait is skipped
   * altogether, so `retry` busy-loops against a dependency that is already
   * failing.  Measured with the `sleep` seam on four attempts before the
   * guards existed: `{delayMs: 0, factor: Infinity}` asked for no sleep at
   * all, `{delayMs: -1000}` and `{delayMs: NaN}` the same, `{delayMs: 1000,
   * factor: -2}` asked for `[1000, 4000]` — one wait short, with the sign
   * swallowed by the even power — and `{maxDelayMs: NaN}` for nothing.
   *
   * That is "a misconfiguration degrades to no wait at all", which is the
   * failure direction the whole clamp exists to invert, arrived at through the
   * options rather than through the arithmetic.  The page says an overflowing
   * configuration degrades to "waits ~24.9 days ... rather than to waits not
   * at all"; these shapes are the second one.
   *
   * The third column is the field the error has to name.  The structured field
   * is what a caller can branch on, and getting it wrong would leave a
   * diagnostic that says the right thing about the wrong knob.
   */
  const malformedSchedules: readonly (readonly [string, Partial<RetryOptions>, string])[] = [
    ['a negative delayMs', { delayMs: -1_000 }, 'delayMs'],
    ['a NaN delayMs', { delayMs: Number.NaN }, 'delayMs'],
    ['an infinite delayMs', { delayMs: Number.POSITIVE_INFINITY }, 'delayMs'],
    ['a zero factor', { delayMs: 1_000, factor: 0 }, 'factor'],
    ['a negative factor', { delayMs: 1_000, factor: -2 }, 'factor'],
    ['an infinite factor', { delayMs: 0, factor: Number.POSITIVE_INFINITY }, 'factor'],
    ['a NaN factor', { delayMs: 1_000, factor: Number.NaN }, 'factor'],
    ['a NaN maxDelayMs', { delayMs: 1_000, maxDelayMs: Number.NaN }, 'maxDelayMs'],
    ['a negative maxDelayMs', { delayMs: 1_000, maxDelayMs: -5 }, 'maxDelayMs'],
    // The fourth knob, and the one the range check alone could not see.
    // `NaN < 0` and `NaN > 1` are both false, so `randomFactor` was the one
    // member of the table's own family that walked straight past its guard
    // and into the loop: measured at the unrepaired tip with four attempts,
    // `randomFactor: NaN` gave `factoryCalls=4 sleeps=[]` against a control
    // of `factoryCalls=4 sleeps=[1000,2000,4000]` — no wait at all, which is
    // the hot loop the whole table exists to rule out.  It needs no typo:
    // an absent configuration field arrives as `undefined` and any
    // arithmetic over it as `NaN`, which is the arrival path the guards
    // above were added for (#1509).
    ['a NaN randomFactor', { delayMs: 1_000, randomFactor: Number.NaN }, 'randomFactor'],
    // Already refused by `> 1` before the finiteness check existed — kept as
    // the control that says the repair did not simply move where the
    // infinite edge is caught.
    [
      'an infinite randomFactor',
      { delayMs: 1_000, randomFactor: Number.POSITIVE_INFINITY },
      'randomFactor',
    ],
  ];

  for (const [label, shape, field] of malformedSchedules) {
    test(`refuses ${label} before the first attempt`, async () => {
      const requestedDelays: number[] = [];
      let factoryCalls = 0;
      let caught: unknown = null;
      try {
        await retry(async () => { factoryCalls++; throw new Error('fail'); }, {
          attempts: 4,
          sleep: (ms) => { requestedDelays.push(ms); return Promise.resolve(); },
          ...shape,
        });
      } catch (e) { caught = e; }

      // `OptionsError`, like every other refused argument in the tree — a
      // caller can discriminate it from the error the factory itself threw,
      // which a bare `Error` from here is indistinguishable from.
      expect(caught).toBeInstanceOf(OptionsError);
      expect((caught as OptionsError).options).toBe('retry');
      expect((caught as OptionsError).field).toBe(field);
      // Refused at entry, not on the first delay: the factory has side effects
      // by definition, and a misconfigured schedule must not get to run one
      // before it is reported.
      expect(factoryCalls).toBe(0);
      expect(requestedDelays).toEqual([]);
    });
  }

  test('the legal extremes of the schedule stay legal', async () => {
    // Each of these sits on an edge one of the guards above could swallow if
    // it were written one comparison too wide: `delayMs: 0` is the documented
    // default, `maxDelayMs: Infinity` is the documented opt-out of the
    // ceiling, and `factor: 1` is the documented constant schedule.
    const requestedDelays: number[] = [];
    const sleep = (ms: number): Promise<void> => { requestedDelays.push(ms); return Promise.resolve(); };

    expect(await retry(async () => 'ok', { attempts: 2, delayMs: 0, sleep })).toBe('ok');
    expect(await retry(async () => 'ok', {
      attempts: 2,
      delayMs: 1,
      maxDelayMs: Number.POSITIVE_INFINITY,
      sleep,
    })).toBe('ok');
    expect(await retry(async () => 'ok', { attempts: 2, delayMs: 1, factor: 1, sleep })).toBe('ok');
    expect(await retry(async () => 'ok', { attempts: 2, delayMs: 1, maxDelayMs: 0, sleep })).toBe('ok');

    // An explicitly-`undefined` knob is "not set", not "set to something
    // malformed", and must still fall through to its default.  Every guard
    // above reads the value *after* the `??`, which is what keeps the two
    // apart — a check written against `options.randomFactor` directly would
    // refuse this and every caller that omits the field entirely, since the
    // two are indistinguishable at the property.
    const unset: Partial<RetryOptions> = {
      delayMs: undefined,
      factor: undefined,
      maxDelayMs: undefined,
      randomFactor: undefined,
    };
    expect(await retry(async () => 'ok', { attempts: 2, sleep, ...unset })).toBe('ok');
  });
});

describe('composition', () => {
  test('after + retry = delayed, retrying operation', async () => {
    let calls = 0;
    const task = (): Promise<string> => {
      calls++;
      if (calls < 2) return Promise.reject(new Error('wait'));
      return Promise.resolve('ok');
    };
    // Wait 20ms before starting, then retry up to 3 times.
    const value = await after(20, () => retry(task, { attempts: 3, delayMs: 1 }));
    expect(value).toBe('ok');
    expect(calls).toBe(2);
    // sleep used indirectly
    await sleep(5);
  });
});
