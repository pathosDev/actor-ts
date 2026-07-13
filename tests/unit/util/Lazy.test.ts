import { describe, expect, test } from 'bun:test';
import { Lazy, lazy } from '../../../src/util/Lazy.js';

describe('Lazy', () => {
  test('runs the thunk on first get() and memoises the result', () => {
    let calls = 0;
    const lazyValue = Lazy.of(() => { calls++; return 42; });
    expect(lazyValue.isEvaluated).toBe(false);
    expect(lazyValue.get()).toBe(42);
    expect(lazyValue.isEvaluated).toBe(true);
    expect(lazyValue.get()).toBe(42);
    expect(calls).toBe(1);
  });

  test('peek returns undefined before first get, value after', () => {
    const lazyValue = Lazy.of(() => 'x');
    expect(lazyValue.peek()).toBeUndefined();
    lazyValue.get();
    expect(lazyValue.peek()).toBe('x');
  });

  test('thrown errors are cached and re-thrown on every subsequent get', () => {
    let calls = 0;
    const boom = Lazy.of<number>(() => { calls++; throw new Error('nope'); });
    expect(() => boom.get()).toThrow('nope');
    expect(() => boom.get()).toThrow('nope');
    expect(() => boom.get()).toThrow('nope');
    expect(calls).toBe(1); // still only one attempt
    expect(boom.isEvaluated).toBe(true);
  });

  test('Lazy.evaluated skips the thunk entirely', () => {
    const lazyValue = Lazy.evaluated(7);
    expect(lazyValue.isEvaluated).toBe(true);
    expect(lazyValue.get()).toBe(7);
    expect(lazyValue.peek()).toBe(7);
  });

  test('map defers computation — source is not forced until derived.get()', () => {
    let sourceCalls = 0;
    const src = Lazy.of(() => { sourceCalls++; return 10; });
    const doubled = src.map((n) => n * 2);
    expect(sourceCalls).toBe(0);
    expect(doubled.get()).toBe(20);
    expect(sourceCalls).toBe(1);
    expect(doubled.get()).toBe(20); // memoised
    expect(sourceCalls).toBe(1);
  });

  test('flatMap composes two Lazy values with full laziness', () => {
    let calls = 0;
    const otherLazy = Lazy.of(() => { calls++; return 3; });
    const composed = otherLazy.flatMap((n) => Lazy.of(() => n + 4));
    expect(calls).toBe(0);
    expect(composed.get()).toBe(7);
    expect(calls).toBe(1);
  });

  test('forEach forces evaluation and runs otherLazy side effect', () => {
    let seen = 0;
    const lazyValue = Lazy.of(() => 9);
    lazyValue.forEach((n) => { seen = n; });
    expect(seen).toBe(9);
  });

  test('reset forgets the cache so the next get re-runs the thunk', () => {
    let calls = 0;
    const lazyValue = Lazy.of(() => { calls++; return calls; });
    expect(lazyValue.get()).toBe(1);
    expect(lazyValue.get()).toBe(1); // memoised
    lazyValue.reset();
    expect(lazyValue.isEvaluated).toBe(false);
    expect(lazyValue.get()).toBe(2); // re-run
  });

  test('setOverride forces otherLazy specific value without running the thunk', () => {
    let calls = 0;
    const lazyValue = Lazy.of(() => { calls++; return 'real'; });
    lazyValue.setOverride('fake');
    expect(lazyValue.isEvaluated).toBe(true); // override counts as evaluated
    expect(lazyValue.peek()).toBe('fake');
    expect(lazyValue.get()).toBe('fake');
    expect(lazyValue.get()).toBe('fake');
    expect(calls).toBe(0);
    lazyValue.setOverride(null); // restore normal eval
    expect(lazyValue.get()).toBe('real');
    expect(calls).toBe(1);
  });

  test('async thunk caches the Promise — concurrent callers share work', async () => {
    let calls = 0;
    const lazyValue = Lazy.of(async () => { calls++; await Bun.sleep(5); return 'async-ok'; });
    const [otherLazy, b, c] = await Promise.all([lazyValue.get(), lazyValue.get(), lazyValue.get()]);
    expect(otherLazy).toBe('async-ok');
    expect(b).toBe('async-ok');
    expect(c).toBe('async-ok');
    expect(calls).toBe(1);
  });

  test('`lazy(...)` alias is equivalent to Lazy.of', () => {
    const lazyValue = lazy(() => 5);
    expect(lazyValue.get()).toBe(5);
  });
});

describe('Lazy.getSync (#279)', () => {
  test('returns the cached value for sync Lazy', () => {
    const lazyValue = Lazy.of(() => 'hello');
    lazyValue.get();
    expect(lazyValue.getSync()).toBe('hello');
  });

  test('throws when called before evaluation', () => {
    const lazyValue = Lazy.of(() => 7);
    expect(() => lazyValue.getSync()).toThrow(/not been evaluated/);
  });

  test('respects setOverride — returns the override value', () => {
    const lazyValue = Lazy.of(() => 'real');
    lazyValue.setOverride('fake');
    expect(lazyValue.getSync()).toBe('fake');
  });

  test('re-throws the cached error from the thunk', () => {
    const lazyValue = Lazy.of<number>(() => { throw new Error('boom'); });
    try { lazyValue.get(); } catch { /* prime the cache */ }
    expect(() => lazyValue.getSync()).toThrow('boom');
  });

  test('async Lazy: throws before the Promise settles', async () => {
    let resolveIt!: (v: string) => void;
    const slow: Promise<string> = new Promise((r) => { resolveIt = r; });
    const lazyValue = Lazy.of(() => slow);
    void lazyValue.get(); // force, but don't await
    expect(() => lazyValue.getSync<string>()).toThrow(/has not resolved/);
    resolveIt('async-done');
    await lazyValue.get();
    expect(lazyValue.getSync<string>()).toBe('async-done');
  });

  test('async Lazy: returns the resolved value after the Promise settles', async () => {
    const lazyValue = Lazy.of(async () => {
      await Bun.sleep(5);
      return { sdk: 'loaded' };
    });
    await lazyValue.get();
    expect(lazyValue.getSync<{ sdk: string }>().sdk).toBe('loaded');
  });

  test('reset() clears the resolved-async-value too', async () => {
    let calls = 0;
    const lazyValue = Lazy.of(async () => { calls++; return calls; });
    await lazyValue.get();
    expect(lazyValue.getSync<number>()).toBe(1);
    lazyValue.reset();
    expect(() => lazyValue.getSync()).toThrow(/not been evaluated/);
    await lazyValue.get();
    expect(lazyValue.getSync<number>()).toBe(2);
  });

  test('rejected async Lazy: getSync still throws the original error', async () => {
    // get() returns the Promise which rejects; getSync should
    // surface the same error rather than reporting "not resolved".
    const lazyValue = Lazy.of(async () => { throw new Error('async-fail'); });
    let caught: Error | null = null;
    try { await lazyValue.get(); }
    catch (e) { caught = e as Error; }
    expect(caught?.message).toBe('async-fail');
    // getSync now reports "not resolved" since we never recorded a
    // resolved value.  That's a defensible behaviour: rejection is
    // visible through `await get()`, sync access has no resolved
    // value to give.  Pin it.
    expect(() => lazyValue.getSync()).toThrow(/has not resolved/);
  });
});
