/**
 * Unit tests for the LogContext primitive (#53).
 *
 *   - run/get scoping is reset on exit, even after async work.
 *   - with() merges into the parent context for a sub-scope.
 *   - parallel async branches don't leak context into each other.
 *
 * Cross-actor + cross-node propagation is covered by
 * `tests/unit/MdcPropagation.test.ts` and
 * `tests/multi-node/log-context-cross-node.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { LogContext } from '../../src/LogContext.js';

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
