import { NodeAddress } from '../cluster/NodeAddress.js';
import type {
  BrokeredMessage,
  PortLike,
} from '../cluster/transports/MessageChannelTransport.js';
import { getWorkerBackend, type WorkerLike } from '../runtime/worker/index.js';
import type { WorkerClusterOptions, WorkerClusterOptionsType } from './WorkerClusterOptions.js';
import { WorkerBroker } from './WorkerBroker.js';

export type RestartPolicy = 'always' | 'on-failure' | 'never';

export interface WorkerHandle {
  readonly id: number;
  readonly address: NodeAddress;
  readonly worker: WorkerLike;
}

export interface WorkerHelloMessage {
  readonly kind: 'worker-hello';
}

export interface WorkerInitMessage {
  readonly kind: 'worker-init';
  readonly self: ReturnType<NodeAddress['toJSON']>;
  readonly systemName: string;
  readonly data: unknown;
}

export interface WorkerReadyMessage {
  readonly kind: 'worker-ready';
  readonly self: ReturnType<NodeAddress['toJSON']>;
}

/** Wire frame flowing in both directions on every worker↔main channel. */
export interface WorkerTransportMessage {
  readonly kind: 'worker-transport';
  readonly envelope: BrokeredMessage;
}

/**
 * Spawn a pool of workers and wire them into a shared broker via their
 * native postMessage channel.  Each worker hosts its own ActorSystem +
 * Cluster; the broker routes `BrokeredMessage`s between workers based on
 * the envelope's `to` address.
 *
 * The underlying Worker implementation is picked per runtime — Bun and
 * Deno use the Web Worker API, Node.js uses `node:worker_threads` — via
 * `getWorkerBackend()`.  The cluster code itself never branches on
 * runtime; it only ever sees a runtime-neutral `WorkerLike`.
 */
export class WorkerCluster {
  readonly broker: WorkerBroker;
  private readonly handles: WorkerHandle[] = [];
  private readonly options: Required<
    Pick<WorkerClusterOptionsType, 'systemName' | 'hostname' | 'basePort' | 'readyTimeoutMs' | 'restartPolicy'>
  > & { bootstrap: URL | string; workers: number | 'auto'; initData: unknown };
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
      systemName: options.systemName ?? 'worker-cluster',
      hostname: options.hostname ?? 'worker',
      basePort: options.basePort ?? 1,
      initData: options.initData ?? null,
      readyTimeoutMs: options.readyTimeoutMs ?? 10_000,
      restartPolicy: options.restartPolicy ?? 'on-failure',
    };
  }

  static async spawn(
    options: WorkerClusterOptions,
  ): Promise<WorkerCluster> {
    const resolvedOptions = options as WorkerClusterOptionsType;
    const workers = resolveWorkerCount(resolvedOptions.workers);
    const broker = new WorkerBroker();
    const cluster = new WorkerCluster(broker, resolvedOptions, workers);
    await cluster._start();
    return cluster;
  }

  get addresses(): NodeAddress[] { return this.handles.map(h => h.address); }
  get size(): number { return this.handles.length; }

  async terminate(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.handles) { try { h.worker.terminate(); } catch { /* ignore */ } }
    this.broker.close();
    this.handles.length = 0;
  }

  private async _start(): Promise<void> {
    const total = this.options.workers === 'auto'
      ? resolveWorkerCount('auto')
      : (this.options.workers as number);
    const ready: Array<Promise<void>> = [];
    for (let i = 0; i < total; i++) ready.push(this.spawnOne(i));
    await Promise.all(ready);
  }

  private async spawnOne(index: number): Promise<void> {
    const addr = new NodeAddress(
      this.options.systemName,
      this.options.hostname,
      this.options.basePort + index,
    );

    const backend = await getWorkerBackend();
    const url = this.options.bootstrap instanceof URL
      ? this.options.bootstrap
      : new URL(this.options.bootstrap);
    const worker = backend.spawn(url, { name: `worker-${index}` });
    const handle: WorkerHandle = { id: index, address: addr, worker };

    const init: WorkerInitMessage = {
      kind: 'worker-init',
      self: addr.toJSON(),
      systemName: this.options.systemName,
      data: this.options.initData,
    };
    // Handshake first (so only one 'message' listener is live during hello/ready),
    // then wire up the broker — otherwise Bun's multiple-listener path is finicky.
    await this.handshake(worker, init, addr);

    const brokerPort = this.brokerFacade(worker);
    this.broker.register(addr, brokerPort);

    this.handles.push(handle);
    this.attachRestartHandler(index, worker, addr);
  }

  /** Create a PortLike wrapper that speaks the BrokeredMessage protocol
   *  over the worker's native postMessage channel. */
  private brokerFacade(worker: WorkerLike): PortLike {
    let handler: ((e: { data: unknown }) => void) | null = null;
    worker.addEventListener('message', (e) => {
      const msg = (e.data ?? undefined) as { kind?: string } | undefined;
      if (msg && msg.kind === 'worker-transport' && handler) {
        handler({ data: (msg as WorkerTransportMessage).envelope });
      }
    });
    return {
      postMessage(v: unknown) {
        const envelope: BrokeredMessage = v as BrokeredMessage;
        const msg: WorkerTransportMessage = { kind: 'worker-transport', envelope };
        worker.postMessage(msg);
      },
      get onmessage() { return handler; },
      set onmessage(h: ((e: { data: unknown }) => void) | null) { handler = h; },
      close() { handler = null; },
    } as PortLike;
  }

  private handshake(worker: WorkerLike, init: WorkerInitMessage, addr: NodeAddress): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.removeEventListener('message', onMessage);
        reject(new Error(`Worker ${addr} did not become ready within ${this.options.readyTimeoutMs}ms`));
      }, this.options.readyTimeoutMs);
      const onMessage = (e: { data?: unknown }): void => {
        const msg = (e.data ?? undefined) as { kind?: string } | undefined;
        if (!msg) return;
        if (msg.kind === 'worker-hello') {
          worker.postMessage(init);
        } else if (msg.kind === 'worker-ready') {
          clearTimeout(timeout);
          worker.removeEventListener('message', onMessage);
          resolve();
        }
      };
      worker.addEventListener('message', onMessage);
    });
  }

  private attachRestartHandler(index: number, worker: WorkerLike, addr: NodeAddress): void {
    worker.addEventListener('close', (e) => {
      if (this.closed) return;
      const crashed = typeof e?.code === 'number' ? e.code !== 0 : true;
      const should =
        this.options.restartPolicy === 'always' ||
        (this.options.restartPolicy === 'on-failure' && crashed);
      if (!should) return;
      const i = this.handles.findIndex(h => h.address.equals(addr));
      if (i >= 0) {
        this.broker.unregister(addr);
        this.handles.splice(i, 1);
        void this.spawnOne(index);
      }
    });
  }
}

function resolveWorkerCount(value: number | 'auto' | undefined): number {
  if (typeof value === 'number' && value > 0) return value;
  if (typeof process !== 'undefined' && process.env?.ACTOR_TS_WORKERS) {
    const n = parseInt(process.env.ACTOR_TS_WORKERS, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const nav = (globalThis as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator;
  if (nav && typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0) {
    return nav.hardwareConcurrency;
  }
  return 2;
}
