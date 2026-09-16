import type { ActorSystem } from '../ActorSystem.js';
import { CoordinatedShutdownId, Phases } from '../CoordinatedShutdown.js';
import { extensionId, type Extension } from '../Extension.js';
import { metricsOf } from '../metrics/MetricsExtension.js';
import { availableParallelism } from '../runtime/Parallelism.js';
import { getWorkerBackend, type WorkerBackend, type WorkerLike } from '../runtime/worker/index.js';
import type { Cancellable } from '../Scheduler.js';
import { RestartBudget } from '../Supervision.js';
import type { OffloadReadyMessage } from './offload-worker.js';
import {
  DEFAULT_MAX_RESTARTS,
  DEFAULT_OFFLOAD_IDLE_TIMEOUT_MS,
  DEFAULT_OFFLOAD_MAX_QUEUE,
  DEFAULT_OFFLOAD_MIN_SIZE,
  DEFAULT_OFFLOAD_OVERFLOW,
  DEFAULT_OFFLOAD_POOL_SIZE,
  DEFAULT_OFFLOAD_TASK_TIMEOUT_MS,
  DEFAULT_OFFLOAD_WARM_UP,
  DEFAULT_RESTART_WINDOW_MS,
  OffloadPoolOptionsValidator,
  withOffloadPoolConfigDefaults,
  type OffloadOverflow,
  type OffloadPoolOptions,
  type OffloadPoolOptionsType,
} from './OffloadPoolOptions.js';
import {
  OffloadAbortedError,
  OffloadPoolUnavailableError,
  OffloadQueueFullError,
  OffloadTaskError,
  OffloadTimeoutError,
  OffloadWorkerLostError,
  type OffloadErrorMessage,
  type OffloadResultMessage,
  type OffloadRunMessage,
  type OffloadTask,
} from './OffloadTask.js';

const POOL_SHUTDOWN_TASK_NAME = 'offload-pool-terminate';

/** Per-run knobs: a deadline that overrides the pool's, and a signal that cancels. */
export type OffloadRunOptions = {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Transferable objects inside `args` — an `ArrayBuffer` moves instead of being copied (#1191). */
  readonly transfer?: ReadonlyArray<unknown>;
};

type PendingRun = {
  readonly id: number;
  readonly task: OffloadTask;
  readonly args: readonly unknown[];
  readonly transfer: ReadonlyArray<unknown> | undefined;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly startedAtMs: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Set while the run is queued and the caller's signal is watched. */
  onAbort: (() => void) | null;
  deadline: Cancellable | null;
};

type Slot = {
  readonly index: number;
  worker: WorkerLike;
  ready: boolean;
  running: PendingRun | null;
  idleTimer: Cancellable | null;
  /** Set when this slot's worker is being terminated on purpose, so its close is not a crash. */
  retiring: boolean;
};

/**
 * Pure functions on worker threads (#1558).
 *
 * The single-threaded runtime's blocking dispatcher: an `await` in a
 * handler yields the event loop and parallelises nothing, so CPU work — a
 * hash, a compression, an FFT over a sensor window — stalls every actor in
 * the process for as long as it runs.  This pool takes a *task* — a named
 * export of a module, because a function cannot cross a thread — and its
 * cloned arguments, runs it on a worker, and resolves with the result.  No
 * `ActorSystem` per worker, no cluster, no gossip: a worker is a module
 * cache and a message loop, which is the right weight for "run this over
 * there and give me the number".
 *
 * Workers are spawned as tasks arrive, up to `size`, and retired beyond
 * `minSize` after `idleTimeoutMs` of nothing to do — a quiet pool costs
 * nothing.  A run past its deadline, or a worker that crashes, terminates
 * that worker and fails what it was running; the pool spawns a replacement
 * inside a restart budget, and past the budget it stops spawning and every
 * run fails at once, which is louder than a pool that quietly does nothing.
 * Off the whole time is the actor: the result is a later message, and the
 * docs say what that means for state.
 */
export class OffloadPool {
  private readonly options: OffloadPoolOptionsType;
  private readonly size: number | 'auto';
  private readonly minSize: number;
  private readonly maxQueue: number;
  private readonly overflow: OffloadOverflow;
  private readonly idleTimeoutMs: number;
  private readonly taskTimeoutMs: number;
  private readonly budget: RestartBudget;
  private resolvedSize: number | null = null;
  private readonly slots = new Map<number, Slot>();
  private readonly spawning = new Set<number>();
  private readonly queue: PendingRun[] = [];
  private readonly waiting: Array<() => void> = [];
  private nextId = 1;
  private nextSlot = 0;
  private closed = false;
  private exhausted = false;
  private backend: WorkerBackend | null;

  private constructor(
    private readonly system: ActorSystem,
    options: OffloadPoolOptionsType,
  ) {
    this.options = options;
    this.size = options.size ?? DEFAULT_OFFLOAD_POOL_SIZE;
    this.minSize = options.minSize ?? DEFAULT_OFFLOAD_MIN_SIZE;
    this.maxQueue = options.maxQueue ?? DEFAULT_OFFLOAD_MAX_QUEUE;
    this.overflow = options.overflow ?? DEFAULT_OFFLOAD_OVERFLOW;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_OFFLOAD_IDLE_TIMEOUT_MS;
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_OFFLOAD_TASK_TIMEOUT_MS;
    this.budget = new RestartBudget(
      { maxRetries: options.maxRestarts ?? DEFAULT_MAX_RESTARTS, withinTimeRangeMs: options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS },
      system.clock,
    );
    this.backend = options.backend ?? null;
  }

  /**
   * Build a pool on `system`.  Synchronous — workers come up as tasks need
   * them (or all at once with `warmUp`) — and hooked into the system's
   * shutdown both ways: coordinated shutdown's `service-stop` phase and a
   * plain `system.terminate()`.
   */
  static start(system: ActorSystem, options?: OffloadPoolOptions): OffloadPool {
    const resolved = withOffloadPoolConfigDefaults(options, system.config);
    new OffloadPoolOptionsValidator().validate(resolved);
    const pool = new OffloadPool(system, resolved);
    system.extension(CoordinatedShutdownId).addFrameworkTask(
      Phases.ServiceStop,
      POOL_SHUTDOWN_TASK_NAME,
      () => pool.terminate(),
    );
    system._beforeTerminate(() => pool.terminate());
    if (resolved.warmUp ?? DEFAULT_OFFLOAD_WARM_UP) void pool.warmUp();
    return pool;
  }

  /**
   * Run `task` with `args` on a worker and resolve with what it returned.
   * Rejects with `OffloadTaskError` when the task threw, `OffloadTimeoutError`
   * past the deadline, `OffloadAbortedError` on the signal,
   * `OffloadQueueFullError` when the queue is full and `overflow` is
   * `reject`, `OffloadWorkerLostError` when the worker died under it, and
   * `OffloadPoolUnavailableError` once the pool is closed or out of budget.
   */
  async run<TArgs extends readonly unknown[], TResult>(
    task: OffloadTask<TArgs, TResult>,
    args: TArgs,
    options: OffloadRunOptions = {},
  ): Promise<TResult> {
    if (this.closed) throw new OffloadPoolUnavailableError('the pool is terminated');
    if (this.exhausted) throw new OffloadPoolUnavailableError('the restart budget is spent — no worker will be spawned again');
    if (options.signal?.aborted) throw new OffloadAbortedError(describeTask(task), options.signal.reason);
    if (this.queue.length >= this.maxQueue) {
      if (this.overflow === 'reject') throw new OffloadQueueFullError(describeTask(task), this.maxQueue);
      await this.awaitQueueSlot();
      if (this.closed) throw new OffloadPoolUnavailableError('the pool is terminated');
    }
    return new Promise<TResult>((resolve, reject) => {
      const pending: PendingRun = {
        id: this.nextId++,
        task,
        args,
        transfer: options.transfer,
        timeoutMs: options.timeoutMs ?? this.taskTimeoutMs,
        signal: options.signal,
        startedAtMs: this.system.clock.now(),
        resolve: resolve as (value: unknown) => void,
        reject,
        onAbort: null,
        deadline: null,
      };
      if (options.signal !== undefined) {
        pending.onAbort = () => this.onAborted(pending);
        options.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.queue.push(pending);
      this.queueDepthGauge().set(this.queue.length);
      this.pump();
    });
  }

  /** Tasks waiting for a worker. */
  get queueDepth(): number { return this.queue.length; }

  /** Workers alive right now, spawning ones included. */
  get workerCount(): number { return this.slots.size + this.spawning.size; }

  /** Spawn every worker up to `size` now, so the first tasks pay no spawn latency. */
  async warmUp(): Promise<void> {
    const size = await this.resolveSize();
    const spawns: Array<Promise<void>> = [];
    for (let i = this.workerCount; i < size; i++) spawns.push(this.spawnOne());
    await Promise.all(spawns);
  }

  /**
   * Stop every worker and fail whatever is queued or running.  Idempotent;
   * the system's shutdown calls it, and so may the application.
   */
  async terminate(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.system.extension(CoordinatedShutdownId).removeTask(Phases.ServiceStop, POOL_SHUTDOWN_TASK_NAME);
    for (const pending of this.queue.splice(0)) this.settle(pending, null, new OffloadPoolUnavailableError('the pool is terminating'));
    for (const resume of this.waiting.splice(0)) resume();
    const terminations: Array<Promise<void>> = [];
    for (const slot of [...this.slots.values()]) {
      terminations.push(this.retire(slot, 'the pool is terminating'));
    }
    await Promise.all(terminations);
    this.queueDepthGauge().set(0);
  }

  // ---------------------------------------------------------------- dispatch

  private pump(): void {
    if (this.closed) return;
    while (this.queue.length > 0) {
      const idle = this.idleSlot();
      if (idle === undefined) break;
      this.dispatch(idle, this.queue.shift()!);
    }
    this.queueDepthGauge().set(this.queue.length);
    if (this.queue.length > 0) void this.grow();
    for (const resume of this.waiting.splice(0, Math.max(0, this.maxQueue - this.queue.length))) resume();
  }

  private idleSlot(): Slot | undefined {
    for (const slot of this.slots.values()) {
      if (slot.ready && slot.running === null && !slot.retiring) return slot;
    }
    return undefined;
  }

  /** One more worker when the queue is waiting and the pool is under `size`. */
  private async grow(): Promise<void> {
    if (this.closed || this.exhausted) return;
    const size = await this.resolveSize();
    if (this.workerCount >= size) return;
    await this.spawnOne();
  }

  private dispatch(slot: Slot, pending: PendingRun): void {
    if (pending.onAbort !== null) {
      pending.signal!.removeEventListener('abort', pending.onAbort);
      pending.onAbort = null;
    }
    if (pending.signal?.aborted) {
      this.settle(pending, null, new OffloadAbortedError(describeTask(pending.task), pending.signal.reason));
      return;
    }
    slot.running = pending;
    if (slot.idleTimer !== null) { slot.idleTimer.cancel(); slot.idleTimer = null; }
    if (pending.timeoutMs > 0) {
      pending.deadline = this.system.scheduler.scheduleOnceFunction(pending.timeoutMs, () => this.onDeadline(slot, pending));
    }
    if (pending.signal !== undefined) {
      pending.onAbort = () => this.onAbortedWhileRunning(slot, pending);
      pending.signal.addEventListener('abort', pending.onAbort, { once: true });
    }
    const frame: OffloadRunMessage = {
      kind: 'offload-run',
      id: pending.id,
      module: pending.task.module,
      exportName: pending.task.exportName,
      args: pending.args,
    };
    slot.worker.postMessage(frame, pending.transfer === undefined ? undefined : [...pending.transfer]);
  }

  private settle(pending: PendingRun, result: unknown, error: Error | null): void {
    if (pending.deadline !== null) { pending.deadline.cancel(); pending.deadline = null; }
    if (pending.onAbort !== null && pending.signal !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort);
      pending.onAbort = null;
    }
    const task = describeTask(pending.task);
    const outcome = error === null ? 'ok' : outcomeOf(error);
    metricsOf(this.system).counter(
      'offload_tasks_total',
      { task, outcome },
      { help: 'Offloaded task runs by outcome.' },
    ).inc();
    metricsOf(this.system).histogram(
      'offload_task_seconds',
      { task },
      { help: 'Wall time of an offloaded task, from run() to its settlement.' },
    ).observe((this.system.clock.now() - pending.startedAtMs) / 1_000);
    if (error === null) pending.resolve(result);
    else pending.reject(error);
  }

  private onWorkerMessage(slot: Slot, data: unknown): void {
    const frame = data as Partial<OffloadResultMessage | OffloadErrorMessage | OffloadReadyMessage> | null;
    if (frame === null || typeof frame !== 'object') return;
    if (frame.kind === 'offload-ready') {
      slot.ready = true;
      this.armIdle(slot);
      this.pump();
      return;
    }
    const running = slot.running;
    if (running === null || (frame as { id?: unknown }).id !== running.id) return;
    slot.running = null;
    if (frame.kind === 'offload-result') {
      this.settle(running, (frame as OffloadResultMessage).result, null);
    } else if (frame.kind === 'offload-error') {
      const failure = frame as OffloadErrorMessage;
      this.settle(running, null, new OffloadTaskError(describeTask(running.task), failure.name, failure.message, failure.stack));
    } else {
      return;
    }
    this.armIdle(slot);
    this.pump();
  }

  private onDeadline(slot: Slot, pending: PendingRun): void {
    if (slot.running !== pending) return;
    slot.running = null;
    this.settle(pending, null, new OffloadTimeoutError(describeTask(pending.task), pending.timeoutMs));
    // The worker is still burning the task — the only way to stop synchronous
    // JS is to stop the thread.  Counted against the budget: a task that
    // overruns is a fault the pool is absorbing, exactly like a crash.
    void this.replace(slot, 'terminated after a deadline');
  }

  private onAborted(pending: PendingRun): void {
    const index = this.queue.indexOf(pending);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.queueDepthGauge().set(this.queue.length);
    this.settle(pending, null, new OffloadAbortedError(describeTask(pending.task), pending.signal?.reason));
    for (const resume of this.waiting.splice(0, 1)) resume();
  }

  private onAbortedWhileRunning(slot: Slot, pending: PendingRun): void {
    if (slot.running !== pending) return;
    slot.running = null;
    this.settle(pending, null, new OffloadAbortedError(describeTask(pending.task), pending.signal?.reason));
    // Not a fault: the caller asked, so the replacement is free of the budget.
    void this.retire(slot, 'aborted by its caller').then(() => this.pump());
  }

  private onWorkerGone(slot: Slot, detail: string): void {
    if (this.slots.get(slot.index) !== slot) return;
    this.slots.delete(slot.index);
    if (slot.idleTimer !== null) { slot.idleTimer.cancel(); slot.idleTimer = null; }
    const running = slot.running;
    slot.running = null;
    if (running !== null) this.settle(running, null, new OffloadWorkerLostError(describeTask(running.task), detail));
    if (slot.retiring || this.closed) return;
    // A crash.  Replacing it is a restart, and restarts are budgeted.
    if (!this.budget.registerRestart()) {
      this.exhausted = true;
      this.system.log.error(
        `[offload] worker ${slot.index} died (${detail}) and the restart budget is spent after `
        + `${this.budget.recordedRestarts} restarts — the pool spawns no worker again; every run fails from here on`,
      );
      for (const pending of this.queue.splice(0)) {
        this.settle(pending, null, new OffloadPoolUnavailableError('the restart budget is spent'));
      }
      return;
    }
    this.system.log.warn(`[offload] worker ${slot.index} died (${detail}); replacing it (restart ${this.budget.recordedRestarts})`);
    this.pump();
  }

  /** Terminate a slot's worker on purpose — a deadline, an abort, idleness, shutdown. */
  private async retire(slot: Slot, reason: string): Promise<void> {
    if (this.slots.get(slot.index) !== slot) return;
    slot.retiring = true;
    this.slots.delete(slot.index);
    if (slot.idleTimer !== null) { slot.idleTimer.cancel(); slot.idleTimer = null; }
    const running = slot.running;
    slot.running = null;
    if (running !== null) this.settle(running, null, new OffloadWorkerLostError(describeTask(running.task), reason));
    try { await slot.worker.terminate(); } catch { /* best effort, the backend says so */ }
  }

  /**
   * A deadline overran: terminate under the budget, and replace if the budget
   * allows.  The budget is charged *before* the terminate is awaited, so a
   * run that arrives in the same turn as the refusal sees the pool exhausted
   * rather than a slot it may still fill.
   */
  private async replace(slot: Slot, reason: string): Promise<void> {
    if (this.slots.get(slot.index) !== slot) return;
    this.slots.delete(slot.index);
    slot.retiring = true;
    if (slot.idleTimer !== null) { slot.idleTimer.cancel(); slot.idleTimer = null; }
    const replaced = !this.closed && this.budget.registerRestart();
    if (!this.closed && !replaced) {
      this.exhausted = true;
      this.system.log.error(
        `[offload] worker ${slot.index} ${reason} and the restart budget is spent after `
        + `${this.budget.recordedRestarts} restarts — the pool spawns no worker again; every run fails from here on`,
      );
      for (const pending of this.queue.splice(0)) {
        this.settle(pending, null, new OffloadPoolUnavailableError('the restart budget is spent'));
      }
    }
    try { await slot.worker.terminate(); } catch { /* best effort */ }
    if (replaced) this.pump();
  }

  private armIdle(slot: Slot): void {
    if (slot.idleTimer !== null) { slot.idleTimer.cancel(); slot.idleTimer = null; }
    if (this.idleTimeoutMs <= 0) return;
    slot.idleTimer = this.system.scheduler.scheduleOnceFunction(this.idleTimeoutMs, () => this.onIdle(slot));
  }

  private onIdle(slot: Slot): void {
    slot.idleTimer = null;
    if (slot.running !== null || this.slots.size <= this.minSize) return;
    void this.retire(slot, 'idle');
  }

  private awaitQueueSlot(): Promise<void> {
    return new Promise<void>((resolve) => { this.waiting.push(resolve); });
  }

  private queueDepthGauge() {
    return metricsOf(this.system).gauge('offload_queue_depth', {}, { help: 'Offloaded tasks waiting for a worker.' });
  }

  private async resolveSize(): Promise<number> {
    if (this.resolvedSize !== null) return this.resolvedSize;
    this.resolvedSize = this.size === 'auto' ? Math.max(1, (await availableParallelism()) - 1) : this.size;
    return this.resolvedSize;
  }

  private async spawnOne(): Promise<void> {
    const index = this.nextSlot++;
    this.spawning.add(index);
    try {
      const backend = this.backend ?? (this.backend = await getWorkerBackend());
      if (this.closed) return;
      const worker = backend.spawn(this.bootstrapUrl(), { name: `offload-${index}` });
      const slot: Slot = { index, worker, ready: false, running: null, idleTimer: null, retiring: false };
      this.slots.set(index, slot);
      worker.addEventListener('message', (event) => this.onWorkerMessage(slot, event.data));
      worker.addEventListener('error', (event) => this.onWorkerGone(slot, `error: ${event.message}`));
      worker.addEventListener('close', (event) => this.onWorkerGone(slot, `exited with code ${event.code}`));
    } finally {
      this.spawning.delete(index);
    }
  }

  private bootstrapUrl(): URL {
    const bootstrap = this.options.bootstrap;
    if (bootstrap === undefined) return new URL('./offload-worker.js', import.meta.url);
    return bootstrap instanceof URL ? bootstrap : new URL(bootstrap);
  }
}

function describeTask(task: OffloadTask): string {
  return `${task.exportName} (${task.module.slice(task.module.lastIndexOf('/') + 1)})`;
}

function outcomeOf(error: Error): string {
  if (error instanceof OffloadTaskError) return 'threw';
  if (error instanceof OffloadTimeoutError) return 'timeout';
  if (error instanceof OffloadAbortedError) return 'aborted';
  if (error instanceof OffloadWorkerLostError) return 'lost';
  return 'unavailable';
}

/**
 * The default pool, built from `actor-ts.offload-pool.*` on first use —
 * what `context.offload(...)` runs on.  An application that wants a second
 * pool with other settings builds it with `OffloadPool.start`.
 */
export class OffloadExtension implements Extension {
  private _pool: OffloadPool | null = null;

  constructor(private readonly system: ActorSystem) {}

  get pool(): OffloadPool {
    if (this._pool === null) this._pool = OffloadPool.start(this.system);
    return this._pool;
  }

  /** Whether the default pool has been built — a system that never offloads has none. */
  get started(): boolean { return this._pool !== null; }
}

export const OffloadExtensionId = extensionId<OffloadExtension>('offload', (system) => new OffloadExtension(system));
