import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type Dispatcher,
  Dispatchers,
  HybridDispatcher,
  ImmediateDispatcher,
  MicrotaskDispatcher,
  ThroughputDispatcher,
} from '../../src/Dispatcher.js';
import { awaitCondition } from '../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('MicrotaskDispatcher', () => {
  test('executes the work asynchronously (not synchronously)', async () => {
    const dispatcher = new MicrotaskDispatcher();
    const trace: string[] = [];
    dispatcher.execute(() => { trace.push('work'); });
    trace.push('after-execute');
    expect(trace).toEqual(['after-execute']);
    await awaitCondition(() => trace.length === 2, {
      timeoutMs: 4_000,
      label: 'the dispatched unit ran',
    });
    expect(trace).toEqual(['after-execute', 'work']);
  });

  test('has a descriptive id', () => {
    expect(new MicrotaskDispatcher().id).toContain('microtask');
  });

  test('swallows sync exceptions without propagating, and reports them', async () => {
    const dispatcher = new MicrotaskDispatcher();
    const reported: unknown[] = [];
    dispatcher.onError = (error) => { reported.push(error); };
    expect(() => dispatcher.execute(() => { throw new Error('boom'); })).not.toThrow();
    await awaitCondition(() => reported.length === 1, {
      timeoutMs: 4_000,
      label: 'the sync throw was reported to the sink',
    });
    expect((reported[0] as Error).message).toBe('boom');
  });

  test('swallows async rejections without propagating, and reports them', async () => {
    const dispatcher = new MicrotaskDispatcher();
    const reported: unknown[] = [];
    dispatcher.onError = (error) => { reported.push(error); };
    let ran = false;
    expect(() => {
      dispatcher.execute(async () => { ran = true; throw new Error('boom'); });
    }).not.toThrow();
    await awaitCondition(() => reported.length === 1, {
      timeoutMs: 4_000,
      label: 'the rejection was reported to the sink',
    });
    expect(ran).toBe(true);
    expect((reported[0] as Error).message).toBe('boom');
  });
});

describe('ImmediateDispatcher', () => {
  test('executes the work via setImmediate', async () => {
    const dispatcher = new ImmediateDispatcher();
    let ran = false;
    dispatcher.execute(() => { ran = true; });
    await awaitCondition(() => ran, {
      timeoutMs: 4_000,
      label: 'the dispatched unit ran',
    });
    expect(ran).toBe(true);
  });

  test('has a descriptive id', () => {
    expect(new ImmediateDispatcher().id).toContain('immediate');
  });

  test('preserves FIFO order of scheduled units', async () => {
    const dispatcher = new ImmediateDispatcher();
    const order: number[] = [];
    for (let i = 0; i < 10; i++) dispatcher.execute(() => { order.push(i); });
    await awaitCondition(() => order.length === 10, {
      timeoutMs: 4_000,
      label: 'all ten units ran',
    });
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('ThroughputDispatcher', () => {
  test('default throughput of 16', () => {
    expect(new ThroughputDispatcher().throughput).toBe(16);
  });

  test('executes all queued work', async () => {
    const dispatcher = new ThroughputDispatcher(3);
    let count = 0;
    for (let i = 0; i < 20; i++) dispatcher.execute(() => { count++; });
    await awaitCondition(() => count === 20, {
      timeoutMs: 4_000,
      label: 'all twenty queued units ran',
    });
    expect(count).toBe(20);
  });

  test('yields to the event loop when throughput cap is hit', async () => {
    const dispatcher = new ThroughputDispatcher(2);
    const trace: string[] = [];
    dispatcher.execute(() => { trace.push('a'); });
    dispatcher.execute(() => { trace.push('b'); });
    dispatcher.execute(() => { trace.push('c'); });
    dispatcher.execute(() => { trace.push('d'); });
    // After first drain we must see at most `throughput` entries.
    await sleep(0); // allow setImmediate
    // All 4 eventually execute; at a macro level the order is FIFO.
    await awaitCondition(() => trace.length === 4, {
      timeoutMs: 4_000,
      label: 'all four units ran across the throughput yields',
    });
    expect(trace).toEqual(['a', 'b', 'c', 'd']);
  });

  test('execute on an empty dispatcher re-schedules the drain', async () => {
    const dispatcher = new ThroughputDispatcher(5);
    let calls = 0;
    dispatcher.execute(() => { calls++; });
    await awaitCondition(() => calls === 1, {
      timeoutMs: 4_000,
      label: 'the first unit ran',
    });
    expect(calls).toBe(1);

    // Submit again after idle — must run, not hang.
    dispatcher.execute(() => { calls++; });
    await awaitCondition(() => calls === 2, {
      timeoutMs: 4_000,
      label: 'the re-scheduled drain ran the second unit',
    });
    expect(calls).toBe(2);
  });

  test('accepts a custom id', () => {
    const dispatcher = new ThroughputDispatcher(4, 'custom-id');
    expect(dispatcher.id).toBe('custom-id');
  });

  test('does not propagate sync exceptions, and reports them', async () => {
    const dispatcher = new ThroughputDispatcher(1);
    const reported: unknown[] = [];
    dispatcher.onError = (error) => { reported.push(error); };
    expect(() => dispatcher.execute(() => { throw new Error('boom'); })).not.toThrow();
    await awaitCondition(() => reported.length === 1, {
      timeoutMs: 4_000,
      label: 'the sync throw was reported to the sink',
    });
    expect((reported[0] as Error).message).toBe('boom');
  });

  test('keeps draining the queue after a unit threw', async () => {
    const dispatcher = new ThroughputDispatcher(2);
    const reported: unknown[] = [];
    dispatcher.onError = (error) => { reported.push(error); };
    const ran: number[] = [];
    dispatcher.execute(() => { ran.push(1); });
    dispatcher.execute(() => { throw new Error('boom'); });
    dispatcher.execute(() => { ran.push(3); });
    await awaitCondition(() => ran.length === 2 && reported.length === 1, {
      timeoutMs: 4_000,
      label: 'both healthy units ran and the failing one was reported',
    });
    expect(ran).toEqual([1, 3]);
  });
});

/**
 * The reporting contract itself (#410).  These tests own the console: a
 * dispatcher with no sink is *supposed* to write there, so the fallback is
 * asserted rather than silenced — which is the whole difference between
 * this file before and after the fix.
 */
describe('dispatcher error reporting', () => {
  let consoleErrors: unknown[][];
  const originalConsoleError = console.error;

  beforeEach(() => {
    consoleErrors = [];
    console.error = ((...args: unknown[]) => { consoleErrors.push(args); }) as typeof console.error;
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  test('the sink is told which dispatcher failed', async () => {
    const dispatcher = new ThroughputDispatcher(4, 'named-dispatcher');
    const reported: string[] = [];
    dispatcher.onError = (_error, dispatcherId) => { reported.push(dispatcherId); };
    dispatcher.execute(() => { throw new Error('boom'); });
    await awaitCondition(() => reported.length === 1, {
      timeoutMs: 4_000,
      label: 'the sink was told the dispatcher id',
    });
    expect(reported).toEqual(['named-dispatcher']);
  });

  test('a wired sink keeps the failure off the console', async () => {
    const dispatcher = new ImmediateDispatcher();
    const reported: unknown[] = [];
    dispatcher.onError = (error) => { reported.push(error); };
    dispatcher.execute(() => { throw new Error('boom'); });
    await awaitCondition(() => reported.length === 1, {
      timeoutMs: 4_000,
      label: 'the failure reached the sink',
    });
    expect(consoleErrors).toEqual([]);
  });

  test('with no sink wired, the console is the last resort', async () => {
    const dispatcher = new ImmediateDispatcher();
    dispatcher.execute(() => { throw new Error('boom'); });
    await awaitCondition(() => consoleErrors.length === 1, {
      timeoutMs: 4_000,
      label: 'the failure reached the console fallback',
    });
    expect(consoleErrors[0][0]).toBe('[actor-ts] unhandled dispatcher error:');
    expect((consoleErrors[0][1] as Error).message).toBe('boom');
  });

  test('a sink that throws falls back to the console with the original error', async () => {
    const dispatcher = new ImmediateDispatcher();
    dispatcher.onError = () => { throw new Error('the sink is broken too'); };
    dispatcher.execute(() => { throw new Error('boom'); });
    await awaitCondition(() => consoleErrors.length >= 2, {
      timeoutMs: 4_000,
      label: 'the failed report fell through to the console',
    });
    // The original failure is what nobody else is holding — the sink's own
    // failure is reported after it, never instead of it.
    expect(consoleErrors[0][0]).toBe('[actor-ts] unhandled dispatcher error:');
    expect((consoleErrors[0][1] as Error).message).toBe('boom');
    expect((consoleErrors[1][1] as Error).message).toBe('the sink is broken too');
  });

  test('an async rejection takes the same route as a sync throw', async () => {
    const dispatcher = new ImmediateDispatcher();
    const reported: unknown[] = [];
    dispatcher.onError = (error) => { reported.push(error); };
    dispatcher.execute(async () => { throw new Error('async boom'); });
    await awaitCondition(() => reported.length === 1, {
      timeoutMs: 4_000,
      label: 'the rejection reached the sink',
    });
    expect((reported[0] as Error).message).toBe('async boom');
    expect(consoleErrors).toEqual([]);
  });
});

/**
 * A chain of units that each schedule the next — the shape an alternating
 * volley between two actors produces, and the one an unbounded microtask
 * dispatcher cannot escape.
 *
 * Returns how many units had run when a macrotask armed *before* the chain
 * started finally ran.  That number is the whole fairness question: below the
 * chain length, the event loop got a turn part-way through; equal to it, the
 * chain ran to completion first and every queued callback in the process
 * waited behind it.
 *
 * The competing work is a `setImmediate` and not a `setTimeout(…, 0)`, which
 * is the obvious choice and the wrong one: a zero-millisecond timer is clamped
 * to one millisecond, and a chain of forty trivial units finishes far inside
 * that.  A timer probe therefore reports "starved" for a dispatcher that is
 * yielding perfectly well — it measures the clamp, not the fairness.  An
 * immediate lands in the same phase the yield does and answers the question
 * that was asked.
 */
const runSelfPerpetuatingChain = async (
  dispatcher: Dispatcher,
  units: number,
): Promise<number> => {
  let ran = 0;
  let competingRanAfter = -1;
  setImmediate(() => { competingRanAfter = ran; });
  const step = (): void => {
    ran++;
    if (ran < units) dispatcher.execute(step);
  };
  dispatcher.execute(step);
  await awaitCondition(() => ran >= units && competingRanAfter >= 0, {
    timeoutMs: 4_000,
    label: `the ${units}-unit chain finished and the competing callback ran`,
  });
  return competingRanAfter;
};

describe('HybridDispatcher', () => {
  test('lets other queued work through part-way along a self-perpetuating chain', async () => {
    // 8 rather than the default 64 only to keep the chain short; the property
    // is the same at any budget.
    const firedAfter = await runSelfPerpetuatingChain(new HybridDispatcher(8), 40);
    expect(firedAfter).toBeGreaterThan(0);
    expect(firedAfter).toBeLessThan(40);
  });

  test('…where an unbounded microtask dispatcher does not — the same probe, starved', async () => {
    // The other half of the test above, and the reason it is a guard rather
    // than an assertion that happens to hold.  If this one ever stops starving,
    // the fairness test above has stopped testing anything.
    const firedAfter = await runSelfPerpetuatingChain(new MicrotaskDispatcher(), 40);
    expect(firedAfter).toBe(40);
  });

  test('runs units in the order they were handed over, across a yield', async () => {
    // The yield is where a naive implementation reorders: the unit that spends
    // the budget goes on a macrotask while the next arrival starts a fresh
    // microtask burst and overtakes it.
    const dispatcher = new HybridDispatcher(3);
    const seen: number[] = [];
    for (let i = 0; i < 12; i++) dispatcher.execute(() => { seen.push(i); });
    await awaitCondition(() => seen.length === 12, {
      timeoutMs: 4_000,
      label: 'all twelve units ran',
    });
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test('keeps its ordering when the queue outlasts more than one budget', async () => {
    const dispatcher = new HybridDispatcher(2);
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) dispatcher.execute(() => { seen.push(i); });
    await awaitCondition(() => seen.length === 20, {
      timeoutMs: 4_000,
      label: 'all twenty units ran',
    });
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  test('executes asynchronously, and reports a throw like every other dispatcher', async () => {
    const dispatcher = new HybridDispatcher();
    const trace: string[] = [];
    const reported: unknown[] = [];
    dispatcher.onError = (error) => { reported.push(error); };
    dispatcher.execute(() => { trace.push('work'); });
    expect(trace).toEqual([]);
    dispatcher.execute(() => { throw new Error('boom'); });
    dispatcher.execute(async () => { throw new Error('async boom'); });
    await awaitCondition(() => reported.length === 2, {
      timeoutMs: 4_000,
      label: 'both failures reached the sink',
    });
    expect(trace).toEqual(['work']);
    expect((reported[0] as Error).message).toBe('boom');
    expect((reported[1] as Error).message).toBe('async boom');
  });

  test('has a descriptive id and a default budget', () => {
    expect(new HybridDispatcher().id).toContain('hybrid');
    expect(new HybridDispatcher().yieldEvery).toBe(64);
  });
});

describe('Dispatchers factory', () => {
  test('Immediate returns ImmediateDispatcher instance', () => {
    expect(Dispatchers.Immediate()).toBeInstanceOf(ImmediateDispatcher);
  });

  test('Microtask returns MicrotaskDispatcher instance', () => {
    expect(Dispatchers.Microtask()).toBeInstanceOf(MicrotaskDispatcher);
  });

  test('Hybrid forwards the yield budget', () => {
    const dispatcher = Dispatchers.Hybrid(7) as HybridDispatcher;
    expect(dispatcher).toBeInstanceOf(HybridDispatcher);
    expect(dispatcher.yieldEvery).toBe(7);
  });

  test('Throughput forwards the throughput value', () => {
    const dispatcher = Dispatchers.Throughput(42) as ThroughputDispatcher;
    expect(dispatcher).toBeInstanceOf(ThroughputDispatcher);
    expect(dispatcher.throughput).toBe(42);
  });
});
