import { match } from 'ts-pattern';
import { NodeAddress } from '../cluster/NodeAddress.js';
import type {
  BrokeredMessage,
  PortLike,
} from '../cluster/transports/MessageChannelTransport.js';
import { exponentialBackoff, type BackoffPolicy } from '../pattern/BackoffPolicy.js';
import {
  getWorkerBackend,
  type WorkerBackend,
  type WorkerCloseEvent,
  type WorkerErrorEvent,
  type WorkerLike,
} from '../runtime/worker/index.js';
import { RestartBudget } from '../Supervision.js';
import {
  DEFAULT_MAX_RESTARTS,
  DEFAULT_RESTART_MAX_BACKOFF_MS,
  DEFAULT_RESTART_MIN_BACKOFF_MS,
  DEFAULT_RESTART_RANDOM_FACTOR,
  DEFAULT_RESTART_WINDOW_MS,
  DEFAULT_WORKER_BASE_PORT,
  DEFAULT_WORKER_HOSTNAME,
  DEFAULT_WORKER_READY_TIMEOUT_MS,
  DEFAULT_WORKER_RESTART_POLICY,
  DEFAULT_WORKER_SYSTEM_NAME,
  WorkerClusterOptionsValidator,
  withWorkerClusterConfigDefaults,
} from './WorkerClusterOptions.js';
import type {
  WorkerClusterOptions,
  WorkerClusterOptionsType,
  WorkerPermanentlyDownInfo,
} from './WorkerClusterOptions.js';
import { WorkerBroker } from './WorkerBroker.js';

export type RestartPolicy = 'always' | 'on-failure' | 'never';

export type WorkerHandle = {
  readonly id: number;
  readonly address: NodeAddress;
  readonly worker: WorkerLike;
};

export type WorkerHelloMessage = {
  readonly kind: 'worker-hello';
};

export type WorkerInitMessage = {
  readonly kind: 'worker-init';
  readonly self: ReturnType<NodeAddress['toJSON']>;
  readonly systemName: string;
  readonly data: unknown;
};

export type WorkerReadyMessage = {
  readonly kind: 'worker-ready';
  readonly self: ReturnType<NodeAddress['toJSON']>;
};

/** Wire frame flowing in both directions on every worker↔main channel. */
export type WorkerTransportMessage = {
  readonly kind: 'worker-transport';
  readonly envelope: BrokeredMessage;
};

/**
 * Per-slot restart bookkeeping.  Keyed by slot index rather than by address,
 * because the address is derived from the index and a retired slot has to stay
 * retired even though its address is free again.
 */
type RestartState = {
  /** Sliding-window tally; refuses once the allowance inside the window is spent. */
  readonly budget: RestartBudget;
  /** Pending respawn timer, so `terminate()` can cancel a scheduled attempt. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Set when the budget refused a restart — the slot never comes back. */
  retired: boolean;
};

/**
 * Spawn a pool of workers and wire them into a shared broker via their
 * native postMessage channel.  Each worker hosts its own ActorSystem +
 * Cluster; the broker routes `BrokeredMessage`s between workers based on
 * the envelope's `to` address.
 *
 * The underlying Worker implementation is picked per runtime — Bun and
 * Deno use the Web Worker API, Node.js uses `node:worker_threads` — via
 * `getWorkerBackend()`, unless the options name one explicitly.  The
 * cluster code itself never branches on runtime; it only ever sees a
 * runtime-neutral `WorkerLike`.
 */
export class WorkerCluster {
  readonly broker: WorkerBroker;
  private readonly handles: WorkerHandle[] = [];
  /**
   * Workers that have been spawned but have not finished their handshake.
   * `handles` cannot serve here — a worker only lands there once it is ready —
   * and without this set a `spawn()` that fails leaves every sibling still
   * starting up as an unreachable live thread (#735).
   */
  private readonly starting = new Set<WorkerLike>();
  private readonly restartStates = new Map<number, RestartState>();
  private readonly backoff: BackoffPolicy;
  private readonly options: Required<
    Pick<WorkerClusterOptionsType,
      'systemName' | 'hostname' | 'basePort' | 'readyTimeoutMs' | 'restartPolicy'
      | 'restartMinBackoffMs' | 'restartMaxBackoffMs' | 'restartRandomFactor'
      | 'maxRestarts' | 'restartWindowMs'>
  > & {
    bootstrap: URL | string;
    workers: number | 'auto';
    initData: unknown;
    backend?: WorkerBackend;
    onWorkerPermanentlyDown?: (info: WorkerPermanentlyDownInfo) => void;
  };
  private closed = false;

  private constructor(
    broker: WorkerBroker,
    options: WorkerClusterOptionsType,
    resolvedWorkers: number,
  ) {
    this.broker = broker;
    this.options = {
      bootstrap: options.bootstrap,
      workers: resolvedWorkers,
      systemName: options.systemName ?? DEFAULT_WORKER_SYSTEM_NAME,
      hostname: options.hostname ?? DEFAULT_WORKER_HOSTNAME,
      basePort: options.basePort ?? DEFAULT_WORKER_BASE_PORT,
      initData: options.initData ?? null,
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_WORKER_READY_TIMEOUT_MS,
      restartPolicy: options.restartPolicy ?? DEFAULT_WORKER_RESTART_POLICY,
      restartMinBackoffMs: options.restartMinBackoffMs ?? DEFAULT_RESTART_MIN_BACKOFF_MS,
      restartMaxBackoffMs: options.restartMaxBackoffMs ?? DEFAULT_RESTART_MAX_BACKOFF_MS,
      restartRandomFactor: options.restartRandomFactor ?? DEFAULT_RESTART_RANDOM_FACTOR,
      maxRestarts: options.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      restartWindowMs: options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS,
      onWorkerPermanentlyDown: options.onWorkerPermanentlyDown,
      backend: options.backend,
    };
    this.backoff = exponentialBackoff({
      minMs: this.options.restartMinBackoffMs,
      maxMs: this.options.restartMaxBackoffMs,
      randomFactor: this.options.restartRandomFactor,
    });
  }

  static async spawn(
    options: WorkerClusterOptions,
  ): Promise<WorkerCluster> {
    const resolvedOptions = withWorkerClusterConfigDefaults(options as WorkerClusterOptionsType);
    new WorkerClusterOptionsValidator().validate(resolvedOptions);
    const workers = resolveWorkerCount(resolvedOptions.workers);
    const broker = new WorkerBroker();
    const cluster = new WorkerCluster(broker, resolvedOptions, workers);
    await cluster._start();
    return cluster;
  }

  get addresses(): NodeAddress[] { return this.handles.map(h => h.address); }
  get size(): number { return this.handles.length; }

  /**
   * Shut the mesh down and wait for the threads to actually go.
   *
   * `closed` is set **before** anything else and must stay that way: the
   * synthetic `close` events that termination raises would otherwise be read as
   * crashes and respawn the pool being torn down.  Pending respawn timers are
   * cancelled for the same reason — after the backoff landed, a timer firing
   * post-shutdown would register a fresh port into a closed broker and leak the
   * thread it had just started (#734, #735).
   */
  async terminate(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.restartStates.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
    }
    const workers = [...this.handles.map(h => h.worker), ...this.starting];
    this.starting.clear();
    this.handles.length = 0;
    this.broker.close();
    await Promise.all(workers.map(worker => terminateQuietly(worker)));
  }

  private async _start(): Promise<void> {
    const total = this.options.workers === 'auto'
      ? resolveWorkerCount('auto')
      : (this.options.workers as number);
    const ready: Array<Promise<void>> = [];
    for (let i = 0; i < total; i++) {
      const starting = this.spawnOne(i);
      // Observed twice on purpose: `Promise.all` below throws the *first*
      // failure, and this swallows a sibling's later one, which would otherwise
      // surface as an unhandled rejection with nothing left to catch it.
      starting.catch(() => {});
      ready.push(starting);
    }
    try {
      await Promise.all(ready);
    } catch (error) {
      // Every worker that did come up is unreachable now — `spawn()` never
      // returns the instance that owns them — so the partial pool is torn down
      // before the failure propagates (#735).
      await this.terminate();
      throw error;
    }
  }

  private async spawnOne(index: number): Promise<void> {
    const address = new NodeAddress(
      this.options.systemName,
      this.options.hostname,
      this.options.basePort + index,
    );

    const backend = this.options.backend ?? await getWorkerBackend();
    const url = this.options.bootstrap instanceof URL
      ? this.options.bootstrap
      : new URL(this.options.bootstrap);
    const worker = backend.spawn(url, { name: `worker-${index}` });
    this.starting.add(worker);
    const handle: WorkerHandle = { id: index, address, worker };

    const init: WorkerInitMessage = {
      kind: 'worker-init',
      self: address.toJSON(),
      systemName: this.options.systemName,
      data: this.options.initData,
    };
    try {
      // Handshake first (so only one 'message' listener is live during hello/ready),
      // then wire up the broker — otherwise Bun's multiple-listener path is finicky.
      await this.handshake(worker, init, address);
    } catch (error) {
      // The worker is referenced by two locals and nothing else; letting the
      // rejection propagate used to drop both and leave the thread running for
      // the lifetime of the host (#735).
      this.starting.delete(worker);
      await terminateQuietly(worker);
      throw error;
    }
    this.starting.delete(worker);

    // Re-checked after the await: `terminate()` may have run during the
    // handshake, and registering now would put a port into a closed broker and
    // push a handle into an array nobody clears again (#735).
    if (this.closed) {
      await terminateQuietly(worker);
      return;
    }

    const brokerPort = this.brokerFacade(worker);
    this.broker.register(address, brokerPort);

    this.handles.push(handle);
    this.attachFailureHandlers(index, worker, address);
  }

  /** Create a PortLike wrapper that speaks the BrokeredMessage protocol
   *  over the worker's native postMessage channel. */
  private brokerFacade(worker: WorkerLike): PortLike {
    let handler: ((e: { data: unknown }) => void) | null = null;
    worker.addEventListener('message', (e) => {
      const message = (e.data ?? undefined) as { kind?: string } | undefined;
      if (message && message.kind === 'worker-transport' && handler) {
        handler({ data: (message as WorkerTransportMessage).envelope });
      }
    });
    return {
      postMessage(v: unknown) {
        const envelope: BrokeredMessage = v as BrokeredMessage;
        const message: WorkerTransportMessage = { kind: 'worker-transport', envelope };
        worker.postMessage(message);
      },
      get onmessage() { return handler; },
      set onmessage(h: ((e: { data: unknown }) => void) | null) { handler = h; },
      close() { handler = null; },
    } as PortLike;
  }

  private handshake(worker: WorkerLike, init: WorkerInitMessage, address: NodeAddress): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Worker ${address} did not become ready within ${this.options.readyTimeoutMs}ms`));
      }, this.options.readyTimeoutMs);
      const unsubscribe = (): void => {
        clearTimeout(timeout);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      /**
       * First hello wins; every later one is dropped.
       *
       * `postMessage` structured-clones its argument on the *posting* thread,
       * and `init.data` is whatever the application handed to `withInitData` —
       * a config blob, a seed list.  Without the latch a worker stuck in
       * `for (;;) postMessage({ kind: 'worker-hello' })` buys an arbitrarily
       * expensive main-thread clone per one-word frame, for the whole
       * `readyTimeoutMs` window.  Re-sending init cannot help a worker that
       * missed the first one either: the frame is identical and the channel is
       * ordered, so a repeat is pure cost (#775).
       */
      let helloSeen = false;
      const onWorkerHello = (): void => {
        if (helloSeen) return;
        helloSeen = true;
        worker.postMessage(init);
      };
      const onWorkerReady = (): void => {
        unsubscribe();
        resolve();
      };
      /**
       * A bootstrap that throws or fails to resolve an import produces an
       * `error` and never a `worker-ready`, so without this the handshake sat
       * out the whole `readyTimeoutMs` for a failure that was already known —
       * ten seconds by default, and on Node the host was dead long before it
       * elapsed anyway (#700).
       */
      const onError = (e: WorkerErrorEvent): void => {
        unsubscribe();
        reject(new Error(`Worker ${address} failed during startup: ${e.message ?? 'unknown error'}`));
      };
      const onMessage = (e: { data?: unknown }): void => {
        const message = (e.data ?? undefined) as { kind?: string } | undefined;
        if (!message) return;
        // `.otherwise`, not `.exhaustive`: this is untrusted postMessage data
        // from a worker that may not have started correctly, so the value is
        // typed as an open `{ kind?: string }` and anything unrecognised is
        // ignored rather than crashing the handshake.
        match(message)
          .with({ kind: 'worker-hello' }, () => onWorkerHello())
          .with({ kind: 'worker-ready' }, () => onWorkerReady())
          .otherwise(() => {});
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
    });
  }

  /**
   * Subscribe both ways a worker can die, behind one latch.
   *
   * The latch is the load-bearing part.  For a single uncaught throw Node emits
   * `error` and then `exit`, Bun emits `error` and then `close`, and Deno emits
   * only `error` — so routing the new event into the existing `close` path,
   * which is what #700 asked for, respawns twice per crash on two of the three
   * runtimes.  Whichever event arrives first consumes the latch; the other is
   * dropped.
   */
  private attachFailureHandlers(index: number, worker: WorkerLike, address: NodeAddress): void {
    let consumed = false;
    const onClose = (e: WorkerCloseEvent): void => {
      if (consumed) return;
      consumed = true;
      const crashed = typeof e?.code === 'number' ? e.code !== 0 : true;
      this.onWorkerDown(index, address, crashed, undefined);
    };
    const onError = (e: WorkerErrorEvent): void => {
      if (consumed) return;
      consumed = true;
      // Not reported during shutdown: killing a worker is allowed to make it
      // complain, and that is not a diagnostic anyone wants.
      if (this.closed) return;
      reportWorkerFailure(`worker ${index} (${address}) failed`, e.error ?? e.message);
      this.onWorkerDown(index, address, true, e.error ?? e.message);
    };
    worker.addEventListener('close', onClose);
    worker.addEventListener('error', onError);
  }

  /** Apply `restartPolicy` to a worker that has gone away, and free its slot. */
  private onWorkerDown(index: number, address: NodeAddress, crashed: boolean, error: unknown): void {
    if (this.closed) return;
    const should =
      this.options.restartPolicy === 'always' ||
      (this.options.restartPolicy === 'on-failure' && crashed);
    if (!should) return;
    const i = this.handles.findIndex(h => h.address.equals(address));
    if (i < 0) return;
    this.broker.unregister(address);
    this.handles.splice(i, 1);
    this.requestRestart(index, address, error);
  }

  /**
   * Ask the slot's budget for one restart and either schedule it behind the
   * backoff or retire the slot.
   *
   * This is the only route to a respawn, so the budget covers both a worker
   * that died and a replacement that never started — a crash loop and a
   * bootstrap that always fails are the same shape and used to be equally
   * unbounded (#734).
   */
  private requestRestart(index: number, address: NodeAddress, error: unknown): void {
    const state = this.restartStateFor(index);
    if (state.retired) return;
    if (!state.budget.registerRestart()) {
      state.retired = true;
      this.reportPermanentlyDown(index, address, state.budget.recordedRestarts, error);
      return;
    }
    // `recordedRestarts` and not a private counter: the budget prunes it with
    // the sliding window, so a slot that stayed up long enough to leave the
    // window behind restarts from the minimum delay again instead of staying
    // pinned at the ceiling for the process lifetime.
    const delayMs = this.backoff.delayFor(state.budget.recordedRestarts - 1);
    const timer = setTimeout(() => {
      state.timer = undefined;
      // `terminate()` may have run during the backoff.
      if (this.closed) return;
      this.spawnOne(index).catch((respawnError: unknown) => {
        this.onRespawnFailed(index, address, respawnError);
      });
    }, delayMs);
    state.timer = timer;
    unrefTimer(timer);
  }

  /**
   * A replacement that never became ready.
   *
   * Before this handler the respawn was `void this.spawnOne(index)`, so the
   * handshake's rejection had nowhere to go and terminated the host process
   * instead of degrading the mesh by one worker (#702).  The retry goes back
   * through the same budget, which is what makes a permanently broken bootstrap
   * stop rather than loop.
   */
  private onRespawnFailed(index: number, address: NodeAddress, error: unknown): void {
    // A respawn that lost the race with `terminate()` rejects by design — the
    // worker it started is already terminated by `spawnOne`'s own guard.
    if (this.closed) return;
    reportWorkerFailure(`respawning worker ${index} (${address}) failed`, error);
    this.requestRestart(index, address, error);
  }

  private reportPermanentlyDown(
    index: number,
    address: NodeAddress,
    restarts: number,
    error: unknown,
  ): void {
    const listener = this.options.onWorkerPermanentlyDown;
    if (listener === undefined) {
      // The `Dispatcher.onError` precedent: a default sink beats silence, and
      // `src/worker/` has no logger to reach for.
      console.error(
        `[actor-ts] worker ${index} (${address}) is permanently down — `
        + `${restarts} restarts inside ${this.options.restartWindowMs}ms exhausted its budget`,
        error ?? '',
      );
      return;
    }
    const info: WorkerPermanentlyDownInfo = { index, address, restarts, error };
    try {
      listener(info);
    } catch (listenerError) {
      console.error('[actor-ts] onWorkerPermanentlyDown threw:', listenerError);
    }
  }

  private restartStateFor(index: number): RestartState {
    const existing = this.restartStates.get(index);
    if (existing !== undefined) return existing;
    const state: RestartState = {
      // `RestartBudget` reads only these two fields, which is why it takes a
      // `Pick` — a worker slot has no actor to apply a `Directive` to and no
      // supervision scope to name.
      budget: new RestartBudget({
        maxRetries: this.options.maxRestarts,
        withinTimeRangeMs: this.options.restartWindowMs,
      }),
      timer: undefined,
      retired: false,
    };
    this.restartStates.set(index, state);
    return state;
  }
}

/**
 * Terminate without letting the teardown itself throw.  Every caller is on a
 * cleanup path where there is nothing useful to do with a failure, and where
 * throwing would abandon the workers still queued behind this one.
 */
async function terminateQuietly(worker: WorkerLike): Promise<void> {
  try {
    await worker.terminate();
  } catch { /* ignore */ }
}

/**
 * Keep a pending respawn from holding the process open.
 *
 * Two dialects: Node and Bun put `unref()` on the handle, while Deno returns a
 * plain number and needs `Deno.unrefTimer(id)`.  The src-side idiom elsewhere
 * (`ClusterBootstrap`) only does the first and therefore silently no-ops on
 * Deno — #778 tracks unifying the two.
 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle = timer as unknown as { unref?: () => void };
  if (typeof handle.unref === 'function') {
    handle.unref();
    return;
  }
  const deno = (globalThis as { Deno?: { unrefTimer?: (id: number) => void } }).Deno;
  deno?.unrefTimer?.(timer as unknown as number);
}

/**
 * Report a worker failure the framework cannot hand to anyone else.
 *
 * `src/worker/` has no logger and `WorkerCluster` has no `ActorSystem` in scope
 * — it is a static-constructed plain object, and the workers build their own
 * systems after spawning — so this follows `Dispatcher`'s precedent of a
 * prefixed `console.error` rather than inventing a logging seam here.
 */
function reportWorkerFailure(what: string, error: unknown): void {
  console.error(`[actor-ts] ${what}:`, error);
}

function resolveWorkerCount(value: number | 'auto' | undefined): number {
  if (typeof value === 'number' && value > 0) return value;
  if (typeof process !== 'undefined' && process.env?.ACTOR_TS_WORKERS) {
    const workerCount = parseInt(process.env.ACTOR_TS_WORKERS, 10);
    if (Number.isFinite(workerCount) && workerCount > 0) return workerCount;
  }
  const nav = (globalThis as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator;
  if (nav && typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0) {
    return nav.hardwareConcurrency;
  }
  return 2;
}
