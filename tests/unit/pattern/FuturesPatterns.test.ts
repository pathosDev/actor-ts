import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { after, pipeTo, retry, Success, Failure } from '../../../src/pattern/index.js';
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

  test('an omitted maxDelayMs clamps to the 32-bit timer limit', async () => {
    // The `Number.POSITIVE_INFINITY` branch (#771), which no other test in
    // this block reaches: with no cap and `factor > 1` the computed delay
    // crosses 2_147_483_647 ms, where `setTimeout` coerces its argument to a
    // 32-bit signed integer and fires after 1 ms instead — inverting the
    // backoff into a hot loop against the dependency that is already down.
    // The `sleep` seam records the number `retry` asked for, which is exactly
    // the value that would otherwise reach the timer.
    const requestedDelays: number[] = [];
    try {
      await retry(async () => { throw new Error('fail'); }, {
        attempts: 4,
        delayMs: 1_000,
        factor: 10_000,
        sleep: (ms) => { requestedDelays.push(ms); return Promise.resolve(); },
      });
    } catch { /* expected */ }
    // 1e3, 1e7, then 1e11 — the third would overflow, and lands on the clamp.
    expect(requestedDelays).toEqual([1_000, 10_000_000, 2_147_483_647]);
    for (const ms of requestedDelays) expect(ms).toBeLessThanOrEqual(2_147_483_647);
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

  test('randomFactor must be in [0, 1]', async () => {
    let caught: unknown = null;
    try {
      await retry(async () => 1, { attempts: 2, delayMs: 1, randomFactor: 1.5 });
    } catch (e) { caught = e; }
    expect((caught as Error).message).toContain('randomFactor must be in [0, 1]');
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
