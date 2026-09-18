import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { TestProbe } from '../../../src/testkit/TestProbe.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { OffloadExtensionId, OffloadPool } from '../../../src/worker/OffloadPool.js';
import {
  OffloadPoolOptions,
  OffloadPoolOptionsValidator,
  readOffloadPoolOptionsFromConfig,
  type OffloadPoolOptionsBuilder,
} from '../../../src/worker/OffloadPoolOptions.js';
import {
  OffloadAbortedError,
  OffloadArgumentsError,
  OffloadPoolUnavailableError,
  OffloadQueueFullError,
  OffloadTaskError,
  OffloadTimeoutError,
  OffloadWorkerLostError,
  defineOffloadTask,
} from '../../../src/worker/OffloadTask.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';
import { FakeWorkerBackend, hostOffloadWorker } from './__fixtures__/InMemoryWorkerThread.js';

/**
 * `OffloadPool` (#1558) on the in-process rig: every "worker" is a
 * `FakeWorker` running the production `serveOffload` on this thread through
 * `hostOffloadWorker`, so the protocol, the queue, the deadlines, the budget
 * and the shutdown all run — with no OS thread anywhere.  The thread itself
 * is `tests/multi-node/OffloadPool.test.ts`'s business, and the three
 * runtimes are the smoke case's.
 */

const TASKS = new URL('./__fixtures__/offload-tasks.ts', import.meta.url);
const add = defineOffloadTask<[number, number], number>(TASKS, 'add');
const asyncDouble = defineOffloadTask<[number], number>(TASKS, 'asyncDouble');
const boom = defineOffloadTask<[string], never>(TASKS, 'boom');
const hang = defineOffloadTask<[], never>(TASKS, 'hang');
const sumBytes = defineOffloadTask<[Uint8Array], number>(TASKS, 'sumBytes');
const sumBuffer = defineOffloadTask<[ArrayBuffer], number>(TASKS, 'sumBuffer');
const notAFunction = defineOffloadTask<[], never>(TASKS, 'NOT_A_FUNCTION');
const missing = defineOffloadTask<[], never>(TASKS, 'nope');
const throwsPlain = defineOffloadTask<[], never>(TASKS, 'throwsPlain');

type Rig = {
  readonly system: ActorSystem;
  readonly backend: FakeWorkerBackend;
  readonly hosts: Array<ReturnType<typeof hostOffloadWorker>>;
  readonly pool: OffloadPool;
};

const realImport = (href: string): Promise<Record<string, unknown>> => import(href) as Promise<Record<string, unknown>>;

function rig(configure: (o: OffloadPoolOptionsBuilder) => OffloadPoolOptionsBuilder = (o) => o, name = 'offload'): Rig {
  const hosts: Array<ReturnType<typeof hostOffloadWorker>> = [];
  const backend = new FakeWorkerBackend({ onSpawn: (worker) => { hosts.push(hostOffloadWorker(worker, realImport)); } });
  const system = ActorSystem.create(name, ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
  const pool = OffloadPool.start(system, configure(OffloadPoolOptions.create().withSize(2).withBackend(backend)));
  return { system, backend, hosts, pool };
}

describe('OffloadPool — pure functions on worker threads (#1558)', () => {
  test('a task runs on a lazily spawned worker and its result comes back; async tasks are awaited; bytes cross', async () => {
    const r = rig();
    try {
      expect(r.pool.workerCount).toBe(0);
      expect(await r.pool.run(add, [2, 3])).toBe(5);
      expect(r.pool.workerCount).toBe(1);
      expect(await r.pool.run(asyncDouble, [21])).toBe(42);
      expect(await r.pool.run(sumBytes, [new Uint8Array([1, 2, 3])])).toBe(6);
      // The module was imported once on that worker, not once per run.
      expect(r.hosts).toHaveLength(1);
    } finally {
      await r.system.terminate();
    }
  });

  test('a task that throws rejects with the worker’s error, name and message kept; a missing export is a TypeError', async () => {
    const r = rig();
    try {
      let caught: unknown;
      try { await r.pool.run(boom, ['bang']); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(OffloadTaskError);
      expect((caught as OffloadTaskError).remoteName).toBe('RangeError');
      expect((caught as OffloadTaskError).message).toContain('bang');
      expect((caught as OffloadTaskError).task).toBe('boom (offload-tasks.ts)');
      await expect(r.pool.run(missing, [])).rejects.toThrow(/no function export named 'nope'/);
      await expect(r.pool.run(notAFunction, [])).rejects.toThrow(/no function export named 'NOT_A_FUNCTION'/);
      let plain: unknown;
      try { await r.pool.run(throwsPlain, []); } catch (error) { plain = error; }
      expect((plain as OffloadTaskError).remoteName).toBe('Error');
      expect((plain as OffloadTaskError).message).toContain('not an error object');
      // The worker survived all three: a throwing task is not a crash.
      expect(r.pool.workerCount).toBe(1);
      expect(await r.pool.run(add, [1, 1])).toBe(2);
    } finally {
      await r.system.terminate();
    }
  });

  test('a transfer list the runtime refuses fails the run at once with OffloadArgumentsError; the worker received nothing and serves the next run — dispatched from run()', async () => {
    // No deadline (the default) and no budget: before #1571 the first was the
    // permanent wedge — the slot stayed marked busy with nothing to free it —
    // and the second turns a leaked deadline's termination into a visible
    // OffloadPoolUnavailableError instead of a quiet replacement.
    const r = rig((o) => o.withSize(1).withMaxRestarts(0));
    const registry = r.system.extension(MetricsExtensionId).enable();
    const uncaught: unknown[] = [];
    const record = (error: unknown): void => { uncaught.push(error); };
    process.on('uncaughtException', record);
    try {
      expect(await r.pool.run(add, [1, 1])).toBe(2);
      // A correct list moves the buffer — the fake honours a transfer the way a thread does.
      const moved = new Uint8Array([1, 2, 3, 4]);
      expect(await r.pool.run(sumBuffer, [moved.buffer], { transfer: [moved.buffer] })).toBe(10);
      expect(moved.buffer.byteLength).toBe(0);

      // The common mistake: the view where its buffer was meant.
      const bytes = new Uint8Array([1, 2, 3, 4]);
      let refused: unknown;
      try { await r.pool.run(sumBuffer, [bytes.buffer], { transfer: [bytes] }); } catch (error) { refused = error; }
      expect(refused).toBeInstanceOf(OffloadArgumentsError);
      expect((refused as OffloadArgumentsError).task).toBe('sumBuffer (offload-tasks.ts)');
      expect((refused as OffloadArgumentsError).message).toContain('DataCloneError');
      expect(((refused as OffloadArgumentsError).cause as Error).name).toBe('DataCloneError');
      // Nothing left this thread: the caller's buffer is intact and the worker saw two frames, not three.
      expect(bytes.buffer.byteLength).toBe(4);
      expect(r.hosts[0]!.handled).toBe(2);
      // The same worker, never terminated, never replaced — and free right now, not after a deadline.
      expect(await r.pool.run(add, [2, 2])).toBe(4);
      expect(r.pool.workerCount).toBe(1);
      expect(r.backend.spawned).toHaveLength(1);
      expect(r.backend.spawned[0]!.terminated).toBe(false);
      expect(uncaught).toEqual([]);
      // Counted as the caller's fault, not as the task throwing.
      const outcomes = registry.collect().filter((s) => s.name === 'offload_tasks_total').map((s) => [s.labels.outcome, s.value]);
      expect(outcomes).toContainEqual(['invalid-arguments', 1]);
      expect(outcomes.find(([outcome]) => outcome === 'threw')).toBeUndefined();
    } finally {
      process.off('uncaughtException', record);
      await r.system.terminate();
    }
  });

  test('the same refusal dispatched from the worker’s message callback — a bad run queued behind a busy worker — settles the run and leaves the worker serving', async () => {
    // A deadline this time, so that before #1571 the outcome is a visible
    // OffloadTimeoutError 1.5 s later and a terminated worker, rather than a
    // promise that never settles.  The throw came out of the `message`
    // listener that dispatched the queued run; on a thread that is an
    // uncaught exception on the main thread.
    const r = rig((o) => o.withSize(1).withTaskTimeoutMs(1_500).withMaxRestarts(0));
    const uncaught: unknown[] = [];
    const record = (error: unknown): void => { uncaught.push(error); };
    process.on('uncaughtException', record);
    try {
      expect(await r.pool.run(add, [1, 1])).toBe(2);
      const bytes = new Uint8Array([1, 2, 3, 4]);
      // `asyncDouble` answers a turn later, so the bad run is queued and is
      // dispatched by the result frame's listener, not by `run()`.
      const busy = r.pool.run(asyncDouble, [21]);
      const queued = r.pool.run(sumBuffer, [bytes.buffer], { transfer: [bytes] });
      expect(r.pool.queueDepth).toBe(1);
      expect(await busy).toBe(42);
      let refused: unknown;
      try { await queued; } catch (error) { refused = error; }
      expect(refused).toBeInstanceOf(OffloadArgumentsError);
      expect(r.pool.queueDepth).toBe(0);
      expect(r.hosts[0]!.handled).toBe(2);
      expect(await r.pool.run(add, [3, 3])).toBe(6);
      expect(r.pool.workerCount).toBe(1);
      expect(r.backend.spawned).toHaveLength(1);
      expect(r.backend.spawned[0]!.terminated).toBe(false);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', record);
      await r.system.terminate();
    }
  });

  test('the pool grows to size under load and no further', async () => {
    const r = rig();
    try {
      const results = await Promise.all([1, 2, 3, 4, 5].map((n) => r.pool.run(add, [n, n])));
      expect(results).toEqual([2, 4, 6, 8, 10]);
      expect(r.pool.workerCount).toBe(2);
      expect(r.backend.spawned).toHaveLength(2);
    } finally {
      await r.system.terminate();
    }
  });

  test('overflow = reject: past max-queue a run fails at once with OffloadQueueFullError', async () => {
    const r = rig((o) => o.withSize(1).withMaxQueue(1));
    try {
      // The only worker is busy forever; one task fits in the queue; the next does not.
      const hanging = r.pool.run(hang, []);
      hanging.catch(() => {});
      await awaitCondition(() => r.pool.workerCount === 1 && r.pool.queueDepth === 0, { label: 'first task dispatched' });
      const queued = r.pool.run(add, [1, 1]);
      queued.catch(() => {});
      expect(r.pool.queueDepth).toBe(1);
      await expect(r.pool.run(add, [2, 2])).rejects.toThrow(OffloadQueueFullError);
    } finally {
      await r.system.terminate();
    }
  });

  test('overflow = wait: a run past max-queue waits for a slot and then runs', async () => {
    const r = rig((o) => o.withSize(1).withMaxQueue(1).withOverflow('wait'));
    try {
      const controller = new AbortController();
      const hanging = r.pool.run(hang, [], { signal: controller.signal });
      hanging.catch(() => {});
      await awaitCondition(() => r.pool.workerCount === 1 && r.pool.queueDepth === 0, { label: 'first task dispatched' });
      const queued = r.pool.run(add, [1, 1]);
      let settled = false;
      const waiting = r.pool.run(add, [2, 2]).then((value) => { settled = true; return value; });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(r.pool.queueDepth).toBe(1);
      // Aborting the hanging task frees the worker: the queue drains, the waiter enters.
      controller.abort(new Error('enough'));
      expect(await queued).toBe(2);
      expect(await waiting).toBe(4);
    } finally {
      await r.system.terminate();
    }
  });

  test('a deadline fails the run, terminates the worker, and the replacement counts against the budget', async () => {
    const r = rig((o) => o.withSize(1).withTaskTimeoutMs(40).withMaxRestarts(1).withRestartWindowMs(60_000));
    try {
      await expect(r.pool.run(hang, [])).rejects.toThrow(OffloadTimeoutError);
      await awaitCondition(() => r.backend.spawned[0]!.terminated, { label: 'worker terminated' });
      // One restart granted: the next run spawns a replacement and works.
      expect(await r.pool.run(add, [1, 2], { timeoutMs: 5_000 })).toBe(3);
      expect(r.backend.spawned).toHaveLength(2);
      // The second deadline spends the budget: the pool spawns no more, and says so.
      await expect(r.pool.run(hang, [])).rejects.toThrow(OffloadTimeoutError);
      await expect(r.pool.run(add, [1, 1])).rejects.toThrow(OffloadPoolUnavailableError);
      expect(r.backend.spawned).toHaveLength(2);
    } finally {
      await r.system.terminate();
    }
  });

  test('a signal aborts a queued run without touching a worker, and a running one by terminating its worker — free of the budget', async () => {
    const r = rig((o) => o.withSize(1).withMaxRestarts(0));
    try {
      const early = new AbortController();
      early.abort(new Error('never mind'));
      await expect(r.pool.run(add, [1, 1], { signal: early.signal })).rejects.toThrow(OffloadAbortedError);
      expect(r.pool.workerCount).toBe(0);

      const running = new AbortController();
      const hanging = r.pool.run(hang, [], { signal: running.signal });
      await awaitCondition(() => r.pool.workerCount === 1 && r.pool.queueDepth === 0, { label: 'dispatched' });
      const queued = new AbortController();
      const waiting = r.pool.run(add, [3, 3], { signal: queued.signal });
      queued.abort();
      await expect(waiting).rejects.toThrow(OffloadAbortedError);
      running.abort(new Error('stop'));
      let caught: unknown;
      try { await hanging; } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(OffloadAbortedError);
      expect((caught as OffloadAbortedError).message).toContain('stop');
      await awaitCondition(() => r.backend.spawned[0]!.terminated, { label: 'worker terminated' });
      // maxRestarts = 0, and still a replacement: an abort is the caller's decision, not a fault.
      expect(await r.pool.run(add, [4, 4])).toBe(8);
    } finally {
      await r.system.terminate();
    }
  });

  test('a worker that crashes fails what it ran and is replaced under the budget', async () => {
    const r = rig((o) => o.withSize(1));
    try {
      const doomed = r.pool.run(hang, []);
      await awaitCondition(() => r.pool.workerCount === 1 && r.pool.queueDepth === 0, { label: 'dispatched' });
      r.backend.spawned[0]!.simulateUncaughtThrow('segfault-ish');
      await expect(doomed).rejects.toThrow(OffloadWorkerLostError);
      expect(await r.pool.run(add, [5, 5])).toBe(10);
      expect(r.backend.spawned).toHaveLength(2);
    } finally {
      await r.system.terminate();
    }
  });

  test('warm-up spawns every worker up front; idle workers beyond min-size retire, the ones inside it stay', async () => {
    const r = rig((o) => o.withSize(2).withMinSize(1).withIdleTimeoutMs(30).withWarmUp());
    try {
      await r.pool.warmUp();
      expect(r.pool.workerCount).toBe(2);
      await awaitCondition(() => r.pool.workerCount === 1, { label: 'one idle worker retired' });
      // The slot leaves the pool synchronously; the fake's terminate lands a turn later.
      await awaitCondition(() => r.backend.spawned.filter((w) => w.terminated).length === 1, { label: 'retired worker terminated' });
      // The survivor still works, and the pool grows again when it has to.
      expect(await r.pool.run(add, [1, 1])).toBe(2);
    } finally {
      await r.system.terminate();
    }
  });

  test('terminate() fails what is queued and running, stops every worker, and refuses later runs; the system’s own terminate() does the same', async () => {
    const r = rig((o) => o.withSize(1));
    // Settled as values, because both reject *during* terminate — before an
    // `expect(...).rejects` could attach — and an orphaned rejection is a
    // test failure of its own.
    const running = r.pool.run(hang, []).catch((error: unknown) => error);
    await awaitCondition(() => r.pool.workerCount === 1, { label: 'dispatched' });
    const queued = r.pool.run(add, [1, 1]).catch((error: unknown) => error);
    await r.pool.terminate();
    expect(await running).toBeInstanceOf(OffloadWorkerLostError);
    expect(await queued).toBeInstanceOf(OffloadPoolUnavailableError);
    await expect(r.pool.run(add, [1, 1])).rejects.toThrow(OffloadPoolUnavailableError);
    expect(r.backend.spawned.every((w) => w.terminated)).toBe(true);
    await r.system.terminate();

    const viaSystem = rig((o) => o.withSize(1), 'offload-2');
    expect(await viaSystem.pool.run(add, [2, 2])).toBe(4);
    await viaSystem.system.terminate();
    expect(viaSystem.backend.spawned.every((w) => w.terminated)).toBe(true);
    await expect(viaSystem.pool.run(add, [1, 1])).rejects.toThrow(OffloadPoolUnavailableError);
  });
});

type Command = { readonly kind: 'sum'; readonly a: number; readonly b: number; readonly replyTo: ActorRef<number> };

class Summer extends Actor<Command> {
  override onReceive(command: Command): void {
    // The result is a later message: reply from the continuation, never touch state there.
    void this.context.offload(add, [command.a, command.b]).then((sum) => command.replyTo.tell(sum));
  }
}

describe('context.offload and the default pool from config', () => {
  test('an actor offloads through the extension’s pool, built from actor-ts.offload-pool.* on first use', async () => {
    const hosts: Array<ReturnType<typeof hostOffloadWorker>> = [];
    const backend = new FakeWorkerBackend({ onSpawn: (worker) => { hosts.push(hostOffloadWorker(worker, realImport)); } });
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { 'offload-pool': { size: 1, 'max-queue': 3 } } });
    const system = ActorSystem.create('sugar', systemOptions);
    try {
      const extension = system.extension(OffloadExtensionId);
      expect(extension.started).toBe(false);
      // The backend is code-only, so the config-built pool is given it through a pre-built instance.
      extension['_pool'] = OffloadPool.start(system, OffloadPoolOptions.create().withBackend(backend));
      const probe = new TestProbe(system);
      const summer = system.spawn(Summer, 'summer');
      summer.tell({ kind: 'sum', a: 20, b: 22, replyTo: probe });
      expect(await probe.receiveOne()).toBe(42);
      expect(extension.started).toBe(true);
      expect(extension.pool.workerCount).toBe(1);
    } finally {
      await system.terminate();
    }
  });
});

/* -------- #1288 — a backend that declares no error containment ---------- */

describe('OffloadPool — backend containment declaration (#1288)', () => {
  /**
   * A pool on a system whose logger records, so the diagnostic is read where
   * every other `[offload]` line goes — the shipped `rig` installs a
   * `NoopLogger`, which is right for every other test here and useless for
   * this one.
   */
  const uncontainedLines = (logger: RecordingLogger): string[] =>
    logger.records.filter((record) => /containsWorkerErrors=false/.test(record.message)).map((record) => record.message);

  function reportingRig(containsWorkerErrors: boolean, size: number): Rig & {
    readonly logger: RecordingLogger;
    /** How many diagnostic lines the log held when the first worker was spawned; `-1` until then. */
    readonly linesAtFirstSpawn: () => number;
  } {
    const hosts: Array<ReturnType<typeof hostOffloadWorker>> = [];
    const logger = new RecordingLogger();
    let linesAtFirstSpawn = -1;
    const backend = new FakeWorkerBackend({
      containsWorkerErrors,
      onSpawn: (worker) => {
        if (linesAtFirstSpawn < 0) linesAtFirstSpawn = uncontainedLines(logger).length;
        hosts.push(hostOffloadWorker(worker, realImport));
      },
    });
    const system = ActorSystem.create('offload-reporting', ActorSystemOptions.create().withLogger(logger));
    const pool = OffloadPool.start(system, OffloadPoolOptions.create().withSize(size).withBackend(backend));
    return { system, backend, hosts, pool, logger, linesAtFirstSpawn: () => linesAtFirstSpawn };
  }

  test('a backend declaring false is reported once at error for the whole pool, before its first worker and not before the pool needs one', async () => {
    const r = reportingRig(false, 2);
    try {
      // Nothing has spawned yet — the pool is lazy — so nothing is said yet.
      expect(uncontainedLines(r.logger)).toEqual([]);
      await r.pool.warmUp();
      expect(r.pool.workerCount).toBe(2);
      // Two workers, one line: the declaration is about the backend.
      expect(uncontainedLines(r.logger)).toEqual([
        '[offload] worker backend FakeWorkerBackend declares containsWorkerErrors=false — an uncaught throw inside '
        + "a worker will terminate this process instead of reaching the framework's error handler; wire error "
        + 'containment into its WorkerLike adapter (see cluster/worker-mesh, Failure containment)',
      ]);
      expect(r.logger.records.find((record) => /containsWorkerErrors=false/.test(record.message))?.level).toBe('error');
      // And it preceded the first worker — the one that can take the host down
      // before anything else says why.
      expect(r.linesAtFirstSpawn()).toBe(1);
    } finally {
      await r.system.terminate();
    }
  });

  test('a replacement spawned through the same backend adds no second line', async () => {
    const r = reportingRig(false, 1);
    try {
      const doomed = r.pool.run(hang, []);
      await awaitCondition(() => r.pool.workerCount === 1 && r.pool.queueDepth === 0, { label: 'dispatched' });
      expect(uncontainedLines(r.logger)).toHaveLength(1);
      // The fake still delivers the simulated throw to the pool's `error`
      // listener — `false` is a declaration about a runtime, not about the
      // fake — so the budgeted replacement runs and resolves the backend again.
      r.backend.spawned[0]!.simulateUncaughtThrow('segfault-ish');
      await expect(doomed).rejects.toThrow(OffloadWorkerLostError);
      expect(await r.pool.run(add, [5, 5])).toBe(10);
      expect(r.backend.spawned).toHaveLength(2);
      expect(uncontainedLines(r.logger)).toHaveLength(1);
    } finally {
      await r.system.terminate();
    }
  });

  test('the default fake produces no such line', async () => {
    const r = reportingRig(true, 2);
    try {
      await r.pool.warmUp();
      expect(r.pool.workerCount).toBe(2);
      expect(uncontainedLines(r.logger)).toEqual([]);
    } finally {
      await r.system.terminate();
    }
  });
});

describe('OffloadPoolOptions', () => {
  test('the validator refuses what a worker cannot honour', () => {
    const validator = new OffloadPoolOptionsValidator();
    expect(() => validator.validate({ size: 0 })).toThrow(OptionsError);
    expect(() => validator.validate({ size: 'auto' })).not.toThrow();
    expect(() => validator.validate({ size: 2, minSize: 3 })).toThrow(/must not exceed size/);
    expect(() => validator.validate({ maxQueue: -1 })).toThrow(OptionsError);
    expect(() => validator.validate({ overflow: 'drop' as never })).toThrow(OptionsError);
    expect(() => validator.validate({ idleTimeoutMs: -1 })).toThrow(OptionsError);
    expect(() => validator.validate({ taskTimeoutMs: -1 })).toThrow(OptionsError);
    expect(() => validator.validate({ maxRestarts: -2 })).toThrow(OptionsError);
    expect(() => validator.validate({ bootstrap: './offload-worker.js' })).toThrow(/absolute URL/);
    expect(() => validator.validate({ bootstrap: 'https://example.com/w.js' })).toThrow(/file: scheme/);
    expect(() => validator.validate({ bootstrap: 'file://host/w.js' })).toThrow(/host-less/);
  });

  test('every leaf of actor-ts.offload-pool is read', () => {
    const config = Config.parseString(`
      actor-ts.offload-pool {
        size = 3, min-size = 1, max-queue = 7, overflow = wait,
        idle-timeout = 2s, task-timeout = 1s, max-restarts = 4, restart-window = 30s, warm-up = on
      }
    `);
    expect(readOffloadPoolOptionsFromConfig(config)).toEqual({
      size: 3, minSize: 1, maxQueue: 7, overflow: 'wait',
      idleTimeoutMs: 2_000, taskTimeoutMs: 1_000, maxRestarts: 4, restartWindowMs: 30_000, warmUp: true,
    });
    expect(readOffloadPoolOptionsFromConfig(Config.parseString('actor-ts.offload-pool.size = auto')).size).toBe('auto');
  });

  test('defineOffloadTask resolves the module to an href and refuses an empty export name', () => {
    expect(add.module.startsWith('file:///')).toBe(true);
    expect(add.exportName).toBe('add');
    expect(defineOffloadTask('file:///tmp/x.js', 'f').module).toBe('file:///tmp/x.js');
    expect(() => defineOffloadTask(TASKS, '')).toThrow(/must not be empty/);
  });
});
