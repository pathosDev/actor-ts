import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  Dispatchers,
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

describe('Dispatchers factory', () => {
  test('Immediate returns ImmediateDispatcher instance', () => {
    expect(Dispatchers.Immediate()).toBeInstanceOf(ImmediateDispatcher);
  });

  test('Microtask returns MicrotaskDispatcher instance', () => {
    expect(Dispatchers.Microtask()).toBeInstanceOf(MicrotaskDispatcher);
  });

  test('Throughput forwards the throughput value', () => {
    const dispatcher = Dispatchers.Throughput(42) as ThroughputDispatcher;
    expect(dispatcher).toBeInstanceOf(ThroughputDispatcher);
    expect(dispatcher.throughput).toBe(42);
  });
});
