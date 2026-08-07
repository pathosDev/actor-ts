/**
 * Unit tests for the LogContext primitive (#53).
 *
 *   - run/get scoping is reset on exit, even after async work.
 *   - with() merges into the parent context for a sub-scope.
 *   - parallel async branches don't leak context into each other.
 *   - runFresh/runEach isolate deferred work from the turn that
 *     happened to start it (#129).
 *
 * Cross-actor + cross-node propagation is covered by
 * `tests/unit/MdcPropagation.test.ts` and
 * `tests/multi-node/log-context-cross-node.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { LogContext } from '../../src/LogContext.js';
import type { LogContextEntry } from '../../src/LogContext.js';

describe('LogContext — basic scoping', () => {
  test('outside any run, get() returns the empty (frozen) object', () => {
    const context = LogContext.get();
    expect(context).toEqual({});
    expect(Object.isFrozen(context)).toBe(true);
  });

  test('run() makes ctx visible for the duration of the callback', () => {
    let observed: Record<string, unknown> = {};
    LogContext.run({ correlationId: 'abc-123' }, () => {
      observed = { ...LogContext.get() };
    });
    expect(observed).toEqual({ correlationId: 'abc-123' });
    // After exit, the context is empty again.
    expect(LogContext.get()).toEqual({});
  });

  test('run() preserves context across awaits inside the callback', async () => {
    const observed: Array<Record<string, unknown>> = [];
    await LogContext.run({ requestId: 'r-1' }, async () => {
      observed.push({ ...LogContext.get() });
      await Bun.sleep(5);
      observed.push({ ...LogContext.get() });
    });
    expect(observed).toEqual([{ requestId: 'r-1' }, { requestId: 'r-1' }]);
    expect(LogContext.get()).toEqual({});
  });

  test('with() merges extra fields into the current context', () => {
    let observed: Record<string, unknown> = {};
    LogContext.run({ contextA: 1 }, () => {
      LogContext.with({ contextB: 2 }, () => {
        observed = { ...LogContext.get() };
      });
      // After the inner with(), the outer context is restored.
      expect(LogContext.get()).toEqual({ contextA: 1 });
    });
    expect(observed).toEqual({ contextA: 1, contextB: 2 });
  });

  test('with() overrides parent fields on key collision', () => {
    let observed: Record<string, unknown> = {};
    LogContext.run({ phase: 'outer' }, () => {
      LogContext.with({ phase: 'inner' }, () => {
        observed = { ...LogContext.get() };
      });
    });
    expect(observed).toEqual({ phase: 'inner' });
  });

  test('parallel branches don\'t leak context across promises', async () => {
    const branchA = LogContext.run({ branch: 'A' }, () => Bun.sleep(10).then(() => LogContext.get()));
    const branchB = LogContext.run({ branch: 'B' }, () => Bun.sleep(10).then(() => LogContext.get()));
    const [contextA, contextB] = await Promise.all([branchA, branchB]);
    expect(contextA.branch).toBe('A');
    expect(contextB.branch).toBe('B');
  });

  test('snapshot() returns a fresh copy each call', () => {
    LogContext.run({ k: 'v' }, () => {
      const s1 = LogContext.snapshot();
      const s2 = LogContext.snapshot();
      expect(s1).toEqual(s2);
      expect(s1).not.toBe(s2);
    });
  });

  test('get() returns the same readonly reference within one run', () => {
    LogContext.run({ k: 'v' }, () => {
      const contextA = LogContext.get();
      const contextB = LogContext.get();
      expect(contextA).toBe(contextB);
    });
  });
});

describe('LogContext — runFresh drops the ambient context (#129)', () => {
  test('the callback sees an empty context even inside a run()', () => {
    let observed: Record<string, unknown> = { notEmpty: true };
    LogContext.run({ tenant: 'acme' }, () => {
      LogContext.runFresh(() => {
        observed = { ...LogContext.get() };
      });
    });
    expect(observed).toEqual({});
  });

  test('the ambient context is restored after runFresh returns', () => {
    LogContext.run({ tenant: 'acme' }, () => {
      LogContext.runFresh(() => { /* deliberately empty */ });
      expect(LogContext.get()).toEqual({ tenant: 'acme' });
    });
  });

  test('the context stays empty across awaits inside the callback', async () => {
    const observed: Array<Record<string, unknown>> = [];
    await LogContext.run({ tenant: 'acme' }, async () => {
      await LogContext.runFresh(async () => {
        observed.push({ ...LogContext.get() });
        await Bun.sleep(5);
        observed.push({ ...LogContext.get() });
      });
    });
    expect(observed).toEqual([{}, {}]);
  });

  test('a run() nested inside runFresh installs its own context, unpolluted', () => {
    let observed: Record<string, unknown> = {};
    LogContext.run({ tenant: 'acme' }, () => {
      LogContext.runFresh(() => {
        LogContext.run({ tenant: 'globex' }, () => {
          observed = { ...LogContext.get() };
        });
      });
    });
    // `with()` would have merged acme in; runFresh + run must not.
    expect(observed).toEqual({ tenant: 'globex' });
  });

  test('runFresh returns the callback\'s value', () => {
    expect(LogContext.runFresh(() => 42)).toBe(42);
  });

  test('a detached promise started under runFresh keeps the empty context', async () => {
    let observed: Record<string, unknown> = { notEmpty: true };
    let detached: Promise<void> = Promise.resolve();
    LogContext.run({ tenant: 'acme' }, () => {
      // The classic leak shape: created inside a turn, resolved after it.
      detached = LogContext.runFresh(async () => {
        await Bun.sleep(5);
        observed = { ...LogContext.get() };
      });
    });
    await detached;
    expect(observed).toEqual({});
  });
});

describe('LogContext — runEach replays per-item context (#129)', () => {
  const entriesOf = <TItem>(
    pairs: ReadonlyArray<readonly [Record<string, string>, TItem]>,
  ): Array<LogContextEntry<TItem>> => pairs.map(([context, item]) => ({ context, item }));

  test('each entry runs under the context captured with it', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const entries = entriesOf([
      [{ tenant: 'acme' }, 'invoice-1'],
      [{ tenant: 'globex' }, 'invoice-2'],
    ]);
    await LogContext.runEach(entries, () => {
      observed.push({ ...LogContext.get() });
    });
    expect(observed).toEqual([{ tenant: 'acme' }, { tenant: 'globex' }]);
  });

  test('the context ambient at drain time is ignored, not merged', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const entries = entriesOf([[{ tenant: 'acme' }, 'invoice-1']]);
    // Draining happens in a turn that belongs to a different tenant —
    // exactly the case where inheriting would leak.
    await LogContext.run({ tenant: 'globex', requestId: 'r-9' }, async () => {
      await LogContext.runEach(entries, () => {
        observed.push({ ...LogContext.get() });
      });
    });
    expect(observed).toEqual([{ tenant: 'acme' }]);
  });

  test('an async fn completes under its own entry\'s context', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const entries = entriesOf([
      [{ tenant: 'acme' }, 'a'],
      [{ tenant: 'globex' }, 'b'],
    ]);
    await LogContext.runEach(entries, async () => {
      await Bun.sleep(5);
      observed.push({ ...LogContext.get() });
    });
    expect(observed).toEqual([{ tenant: 'acme' }, { tenant: 'globex' }]);
  });

  test('the item is handed to fn alongside its context', async () => {
    const observed: Array<[string, unknown]> = [];
    const entries = entriesOf([
      [{ tenant: 'acme' }, 'invoice-1'],
      [{ tenant: 'globex' }, 'invoice-2'],
    ]);
    await LogContext.runEach(entries, (item) => {
      observed.push([item, LogContext.get().tenant]);
    });
    expect(observed).toEqual([['invoice-1', 'acme'], ['invoice-2', 'globex']]);
  });

  test('entries are processed sequentially, in iteration order', async () => {
    const order: string[] = [];
    const entries = entriesOf([
      [{ tenant: 'acme' }, 10],
      [{ tenant: 'globex' }, 1],
    ]);
    await LogContext.runEach(entries, async (delayMs) => {
      order.push(`start-${delayMs}`);
      await Bun.sleep(delayMs);
      order.push(`end-${delayMs}`);
    });
    // Parallel execution would interleave the slow first entry with the
    // fast second one; sequential must not.
    expect(order).toEqual(['start-10', 'end-10', 'start-1', 'end-1']);
  });

  test('the ambient context survives the drain untouched', async () => {
    const entries = entriesOf([[{ tenant: 'acme' }, 'a']]);
    await LogContext.run({ tenant: 'globex' }, async () => {
      await LogContext.runEach(entries, () => { /* deliberately empty */ });
      expect(LogContext.get()).toEqual({ tenant: 'globex' });
    });
    expect(LogContext.get()).toEqual({});
  });

  test('an empty iterable resolves without calling fn', async () => {
    let calls = 0;
    await LogContext.runEach([], () => { calls += 1; });
    expect(calls).toBe(0);
  });

  test('an error propagates and abandons the remaining entries', async () => {
    const handled: string[] = [];
    const entries = entriesOf([
      [{ tenant: 'acme' }, 'ok'],
      [{ tenant: 'globex' }, 'boom'],
      [{ tenant: 'initech' }, 'never'],
    ]);
    const drain = LogContext.runEach(entries, (item) => {
      if (item === 'boom') throw new Error('handler failed');
      handled.push(item);
    });
    await expect(drain).rejects.toThrow('handler failed');
    expect(handled).toEqual(['ok']);
  });

  test('a rejected async fn propagates too', async () => {
    const entries = entriesOf([[{ tenant: 'acme' }, 'a']]);
    const drain = LogContext.runEach(entries, async () => {
      await Bun.sleep(1);
      throw new Error('async handler failed');
    });
    await expect(drain).rejects.toThrow('async handler failed');
  });
});
