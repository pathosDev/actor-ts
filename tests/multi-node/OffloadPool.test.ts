/**
 * `OffloadPool` on real OS threads (#1558).
 *
 * The unit suite (`tests/unit/worker/OffloadPool.test.ts`) runs the identical
 * worker service in-process and proves the protocol, the queue, the budget
 * and the shutdown; this file proves what only a thread can: that the
 * shipped `offload-worker` resolves and runs as a worker entry on this
 * runtime, that a task's module is imported by URL inside the thread, that
 * CPU work genuinely runs in parallel with this thread, that a buffer moves
 * by transfer, and that a deadline stops a thread that is busy-waiting —
 * the one thing no in-process fake can show.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { OffloadPool } from '../../src/worker/OffloadPool.js';
import { OffloadPoolOptions } from '../../src/worker/OffloadPoolOptions.js';
import { OffloadTaskError, OffloadTimeoutError, defineOffloadTask } from '../../src/worker/OffloadTask.js';
import { fibonacci } from './internal/OffloadTasks.js';

const TASKS = new URL('./internal/OffloadTasks.ts', import.meta.url);
const fibonacciTask = defineOffloadTask<[number], number>(TASKS, 'fibonacci');
const busyWait = defineOffloadTask<[number], number>(TASKS, 'busyWait');
const boom = defineOffloadTask<[string], never>(TASKS, 'boom');
const sumBuffer = defineOffloadTask<[ArrayBuffer], number>(TASKS, 'sumBuffer');

describe('OffloadPool on real worker threads', () => {
  test('tasks run on threads, in parallel, with results, errors and transfers crossing; a deadline stops a busy thread', async () => {
    const system = ActorSystem.create('real-offload', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const pool = OffloadPool.start(system, OffloadPoolOptions.create().withSize(4).withMaxRestarts(2));
    try {
      // Four times the same work on four threads finishes in far less than four
      // times the single-threaded figure — measured here, not assumed.
      const expected = fibonacci(27);
      const results = await Promise.all([27, 27, 27, 27].map((n) => pool.run(fibonacciTask, [n], { timeoutMs: 60_000 })));
      expect(results).toEqual([expected, expected, expected, expected]);
      expect(pool.workerCount).toBe(4);

      // Settled through try/catch rather than `expect(...).rejects`: on Bun
      // 1.4.2 that matcher, awaiting a promise a worker message settles,
      // loses the message about every other run — the worker posts the
      // frame, the main thread's listener never fires, and the test hangs
      // to its cap.  Measured 5 of 8 with the matcher, 0 of 8 without;
      // the in-process suite is unaffected because nothing crosses a port.
      let thrown: unknown;
      try { await pool.run(boom, ['thread boom']); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(OffloadTaskError);

      const bytes = new Uint8Array([1, 2, 3, 4]);
      const total = await pool.run(sumBuffer, [bytes.buffer], { transfer: [bytes.buffer] });
      expect(total).toBe(10);
      // Moved, not copied: the caller's view is detached.
      expect(bytes.buffer.byteLength).toBe(0);

      // A thread that busy-waits past its deadline is terminated, and the pool goes on.
      let overran: unknown;
      try { await pool.run(busyWait, [10_000], { timeoutMs: 150 }); } catch (error) { overran = error; }
      expect(overran).toBeInstanceOf(OffloadTimeoutError);
      expect(await pool.run(fibonacciTask, [10], { timeoutMs: 60_000 })).toBe(55);
    } finally {
      await system.terminate();
    }
    expect(pool.workerCount).toBe(0);
  }, 60_000);
});
