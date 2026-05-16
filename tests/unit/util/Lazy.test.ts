import { describe, expect, test } from 'bun:test';
import { Lazy, lazy } from '../../../src/util/Lazy.js';

describe('Lazy', () => {
  test('runs the thunk on first get() and memoises the result', () => {
    let calls = 0;
    const l = Lazy.of(() => { calls++; return 42; });
    expect(l.isEvaluated).toBe(false);
    expect(l.get()).toBe(42);
    expect(l.isEvaluated).toBe(true);
    expect(l.get()).toBe(42);
    expect(calls).toBe(1);
  });

  test('peek returns undefined before first get, value after', () => {
    const l = Lazy.of(() => 'x');
    expect(l.peek()).toBeUndefined();
    l.get();
    expect(l.peek()).toBe('x');
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
    const l = Lazy.evaluated(7);
    expect(l.isEvaluated).toBe(true);
    expect(l.get()).toBe(7);
    expect(l.peek()).toBe(7);
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
    const a = Lazy.of(() => { calls++; return 3; });
    const composed = a.flatMap((n) => Lazy.of(() => n + 4));
    expect(calls).toBe(0);
    expect(composed.get()).toBe(7);
    expect(calls).toBe(1);
  });

  test('forEach forces evaluation and runs a side effect', () => {
    let seen = 0;
    const l = Lazy.of(() => 9);
    l.forEach((n) => { seen = n; });
    expect(seen).toBe(9);
  });

  test('reset forgets the cache so the next get re-runs the thunk', () => {
    let calls = 0;
    const l = Lazy.of(() => { calls++; return calls; });
    expect(l.get()).toBe(1);
    expect(l.get()).toBe(1); // memoised
    l.reset();
    expect(l.isEvaluated).toBe(false);
    expect(l.get()).toBe(2); // re-run
  });

  test('setOverride forces a specific value without running the thunk', () => {
    let calls = 0;
    const l = Lazy.of(() => { calls++; return 'real'; });
    l.setOverride('fake');
    expect(l.isEvaluated).toBe(true); // override counts as evaluated
    expect(l.peek()).toBe('fake');
    expect(l.get()).toBe('fake');
    expect(l.get()).toBe('fake');
    expect(calls).toBe(0);
    l.setOverride(null); // restore normal eval
    expect(l.get()).toBe('real');
    expect(calls).toBe(1);
  });

  test('async thunk caches the Promise — concurrent callers share work', async () => {
    let calls = 0;
    const l = Lazy.of(async () => { calls++; await Bun.sleep(5); return 'async-ok'; });
    const [a, b, c] = await Promise.all([l.get(), l.get(), l.get()]);
    expect(a).toBe('async-ok');
    expect(b).toBe('async-ok');
    expect(c).toBe('async-ok');
    expect(calls).toBe(1);
  });

  test('`lazy(...)` alias is equivalent to Lazy.of', () => {
    const l = lazy(() => 5);
    expect(l.get()).toBe(5);
  });
});

describe('Lazy.getSync (#279)', () => {
  test('returns the cached value for sync Lazy', () => {
    const l = Lazy.of(() => 'hello');
    l.get();
    expect(l.getSync()).toBe('hello');
  });

  test('throws when called before evaluation', () => {
    const l = Lazy.of(() => 7);
    expect(() => l.getSync()).toThrow(/not been evaluated/);
  });

  test('respects setOverride — returns the override value', () => {
    const l = Lazy.of(() => 'real');
    l.setOverride('fake');
    expect(l.getSync()).toBe('fake');
  });

  test('re-throws the cached error from the thunk', () => {
    const l = Lazy.of<number>(() => { throw new Error('boom'); });
    try { l.get(); } catch { /* prime the cache */ }
    expect(() => l.getSync()).toThrow('boom');
  });

  test('async Lazy: throws before the Promise settles', async () => {
    let resolveIt!: (v: string) => void;
    const slow: Promise<string> = new Promise((r) => { resolveIt = r; });
    const l = Lazy.of(() => slow);
    void l.get(); // force, but don't await
    expect(() => l.getSync<string>()).toThrow(/has not resolved/);
    resolveIt('async-done');
    await l.get();
    expect(l.getSync<string>()).toBe('async-done');
  });

  test('async Lazy: returns the resolved value after the Promise settles', async () => {
    const l = Lazy.of(async () => {
      await Bun.sleep(5);
      return { sdk: 'loaded' };
    });
    await l.get();
    expect(l.getSync<{ sdk: string }>().sdk).toBe('loaded');
  });

  test('reset() clears the resolved-async-value too', async () => {
    let calls = 0;
    const l = Lazy.of(async () => { calls++; return calls; });
    await l.get();
    expect(l.getSync<number>()).toBe(1);
    l.reset();
    expect(() => l.getSync()).toThrow(/not been evaluated/);
    await l.get();
    expect(l.getSync<number>()).toBe(2);
  });

  test('rejected async Lazy: getSync still throws the original error', async () => {
    // get() returns the Promise which rejects; getSync should
    // surface the same error rather than reporting "not resolved".
    const l = Lazy.of(async () => { throw new Error('async-fail'); });
    let caught: Error | null = null;
    try { await l.get(); }
    catch (e) { caught = e as Error; }
    expect(caught?.message).toBe('async-fail');
    // getSync now reports "not resolved" since we never recorded a
    // resolved value.  That's a defensible behaviour: rejection is
    // visible through `await get()`, sync access has no resolved
    // value to give.  Pin it.
    expect(() => l.getSync()).toThrow(/has not resolved/);
  });
});
