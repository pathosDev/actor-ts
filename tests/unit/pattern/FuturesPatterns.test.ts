import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Props } from '../../../src/Props.js';
import { after, pipeTo, retry, Success, Failure } from '../../../src/pattern/index.js';
import { TestKit } from '../../../src/testkit/TestKit.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('pipeTo', () => {
  test('resolves pipe the value as Success by default', async () => {
    const kit = TestKit.create('pipe-s', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe();
    const p = Promise.resolve(42);
    pipeTo(p, probe);
    const got = await probe.receiveOne(200);
    expect(got).toBeInstanceOf(Success);
    expect((got as Success<number>).value).toBe(42);
    await kit.system.terminate();
  });

  test('rejections pipe as Failure', async () => {
    const kit = TestKit.create('pipe-f', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe();
    pipeTo(Promise.reject(new Error('boom')), probe);
    const got = await probe.receiveOne(200);
    expect(got).toBeInstanceOf(Failure);
    expect((got as Failure).cause.message).toBe('boom');
    await kit.system.terminate();
  });

  test('wrap=false sends raw value, drops rejections', async () => {
    const kit = TestKit.create('pipe-raw', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe<unknown>();
    pipeTo(Promise.resolve({ ok: 1 }), probe, { wrap: false });
    const got = await probe.receiveOne(200);
    expect(got).toEqual({ ok: 1 });

    pipeTo(Promise.reject(new Error('ignored')), probe, { wrap: false });
    await probe.expectNoMessage(60);
    await kit.system.terminate();
  });

  test('delivers through an actor with sender attribution', async () => {
    const kit = TestKit.create('pipe-sender', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = kit.createTestProbe();

    class Holder extends Actor<Success<string>> {
      override onReceive(m: Success<string>): void {
        probe.tell({ value: m.value, sender: this.sender.map((s) => s.path.name).toNullable() });
      }
    }
    const holder = kit.system.actorOf(Props.create(() => new Holder()));
    pipeTo(Promise.resolve('hello'), holder, { sender: probe });

    const got = await probe.receiveOne(200) as { value: string; sender: string | null };
    expect(got.value).toBe('hello');
    expect(got.sender).toBe(probe.path.name);
    await kit.system.terminate();
  });
});

describe('after', () => {
  test('resolves with the factory value after the delay', async () => {
    const start = Date.now();
    const v = await after(30, () => Promise.resolve('done'));
    const elapsed = Date.now() - start;
    expect(v).toBe('done');
    expect(elapsed).toBeGreaterThanOrEqual(25); // ~30ms, tolerate scheduling jitter
  });

  test('propagates rejection from the factory', async () => {
    let caught: unknown = null;
    try {
      await after(10, () => Promise.reject(new Error('later-fail')));
    } catch (e) { caught = e; }
    expect((caught as Error).message).toBe('later-fail');
  });

  test('cancel() aborts before firing', async () => {
    const p = after(200, () => Promise.resolve('never'));
    p.cancel();
    let caught: unknown = null;
    try { await p; } catch (e) { caught = e; }
    expect((caught as Error).message).toContain('cancelled');
  });
});

describe('retry', () => {
  test('returns first success within attempts', async () => {
    let calls = 0;
    const v = await retry(async () => {
      calls++;
      if (calls < 3) throw new Error('nope');
      return 'win';
    }, { attempts: 5, delayMs: 1 });
    expect(v).toBe('win');
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
    const delays: number[] = [];
    const start = Date.now();
    let calls = 0;
    try {
      await retry(async () => {
        calls++;
        delays.push(Date.now() - start);
        throw new Error('fail');
      }, { attempts: 3, delayMs: 20, factor: 2, maxDelayMs: 30 });
    } catch { /* ignore */ }
    expect(calls).toBe(3);
    // Gaps should be ~20ms, ~30ms (capped by maxDelayMs instead of 40ms).
    const gap1 = delays[1]! - delays[0]!;
    const gap2 = delays[2]! - delays[1]!;
    expect(gap1).toBeGreaterThanOrEqual(18);
    expect(gap2).toBeGreaterThanOrEqual(25);
    expect(gap2).toBeLessThan(40);
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
    const v = await after(20, () => retry(task, { attempts: 3, delayMs: 1 }));
    expect(v).toBe('ok');
    expect(calls).toBe(2);
    // sleep used indirectly
    await sleep(5);
  });
});
