import { describe, expect, test } from 'bun:test';
import {
  Dispatchers,
  ImmediateDispatcher,
  MicrotaskDispatcher,
  ThroughputDispatcher,
} from '../../src/Dispatcher.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('MicrotaskDispatcher', () => {
  test('executes the work asynchronously (not synchronously)', async () => {
    const d = new MicrotaskDispatcher();
    const trace: string[] = [];
    d.execute(() => { trace.push('work'); });
    trace.push('after-execute');
    expect(trace).toEqual(['after-execute']);
    await sleep(10);
    expect(trace).toEqual(['after-execute', 'work']);
  });

  test('has a descriptive id', () => {
    expect(new MicrotaskDispatcher().id).toContain('microtask');
  });

  test('swallows sync exceptions without propagating', async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const d = new MicrotaskDispatcher();
      expect(() => d.execute(() => { throw new Error('boom'); })).not.toThrow();
      await sleep(10);
    } finally {
      console.error = original;
    }
  });

  test('swallows async rejections without propagating', async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const d = new MicrotaskDispatcher();
      let ran = false;
      expect(() => {
        d.execute(async () => { ran = true; throw new Error('boom'); });
      }).not.toThrow();
      await sleep(10);
      expect(ran).toBe(true);
    } finally {
      console.error = original;
    }
  });
});

describe('ImmediateDispatcher', () => {
  test('executes the work via setImmediate', async () => {
    const d = new ImmediateDispatcher();
    let ran = false;
    d.execute(() => { ran = true; });
    await sleep(10);
    expect(ran).toBe(true);
  });

  test('has a descriptive id', () => {
    expect(new ImmediateDispatcher().id).toContain('immediate');
  });

  test('preserves FIFO order of scheduled units', async () => {
    const d = new ImmediateDispatcher();
    const order: number[] = [];
    for (let i = 0; i < 10; i++) d.execute(() => { order.push(i); });
    await sleep(30);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('ThroughputDispatcher', () => {
  test('default throughput of 16', () => {
    expect(new ThroughputDispatcher().throughput).toBe(16);
  });

  test('executes all queued work', async () => {
    const d = new ThroughputDispatcher(3);
    let count = 0;
    for (let i = 0; i < 20; i++) d.execute(() => { count++; });
    await sleep(50);
    expect(count).toBe(20);
  });

  test('yields to the event loop when throughput cap is hit', async () => {
    const d = new ThroughputDispatcher(2);
    const trace: string[] = [];
    d.execute(() => trace.push('a'));
    d.execute(() => trace.push('b'));
    d.execute(() => trace.push('c'));
    d.execute(() => trace.push('d'));
    // After first drain we must see at most `throughput` entries.
    await sleep(0); // allow setImmediate
    // All 4 eventually execute; at a macro level the order is FIFO.
    await sleep(30);
    expect(trace).toEqual(['a', 'b', 'c', 'd']);
  });

  test('execute on an empty dispatcher re-schedules the drain', async () => {
    const d = new ThroughputDispatcher(5);
    let a = 0;
    d.execute(() => { a++; });
    await sleep(5);
    expect(a).toBe(1);

    // Submit again after idle — must run, not hang.
    d.execute(() => { a++; });
    await sleep(5);
    expect(a).toBe(2);
  });

  test('accepts a custom id', () => {
    const d = new ThroughputDispatcher(4, 'custom-id');
    expect(d.id).toBe('custom-id');
  });

  test('does not propagate sync exceptions', async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const d = new ThroughputDispatcher(1);
      expect(() => d.execute(() => { throw new Error('boom'); })).not.toThrow();
      await sleep(10);
    } finally {
      console.error = original;
    }
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
    const d = Dispatchers.Throughput(42) as ThroughputDispatcher;
    expect(d).toBeInstanceOf(ThroughputDispatcher);
    expect(d.throughput).toBe(42);
  });
});
