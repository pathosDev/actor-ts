import type { ParallelMultiNodeSpecOptions, ParallelMultiNodeSpecOptionsType } from './ParallelMultiNodeSpecOptions.js';
import type {
  BrokeredMessage,
  PortLike,
} from '../cluster/transports/MessageChannelTransport.js';
import type { FailureDetectorOptionsType } from '../cluster/FailureDetectorOptions.js';
import type { Member } from '../cluster/Member.js';
import { NodeAddress } from '../cluster/NodeAddress.js';
import { LogLevel } from '../Logger.js';
import { getWorkerBackend, type WorkerLike } from '../runtime/worker/index.js';
import type {
  WorkerHelloMessage,
  WorkerInitMessage,
  WorkerReadyMessage,
  WorkerTransportMessage,
} from '../worker/WorkerCluster.js';
import { MultiNodeBroker } from './internal/MultiNodeBroker.js';
import type { MemberSnapshot } from './internal/parallel-multi-node-bootstrap.js';

/**
 * Worker-thread variant of `MultiNodeSpec` (#46).  Each role runs in
 * a dedicated `worker_threads` Worker (or Web Worker on Bun/Deno),
 * connected via a shared `MultiNodeBroker`.  Use this variant when a
 * test needs **true parallelism** — concurrent journal writes,
 * scheduler-thread interleaving, anything that doesn't fully
 * serialise on the main event loop.
 *
 * **Trade-offs vs. `MultiNodeSpec`** (in-process variant):
 *
 *   - **Pro**: real OS threads.  Catches races the in-process variant
 *     papers over by virtue of running on a single event loop.
 *   - **Con**: slower start-up (worker spawn + cluster handshake
 *     takes ~200-500 ms vs. ~10 ms in-process).  Stack traces span
 *     thread boundaries and are messier.  No `systemFor` /
 *     `clusterFor` returning real instances — the actor system
 *     lives in the worker, so the harness exposes JSON-shaped
 *     accessors (`getMembers()`, `getLeader()`) and a
 *     `runIn(role, command, args)` RPC for invoking scenario-
 *     defined commands.
 *
 * **Public API mirrors `MultiNodeSpec`** for the lifecycle bits —
 * `start`, `stop`, `crash`, `leave`, `partition`, `heal`,
 * `awaitMembers`, `awaitMemberStatus`, `awaitLeader`, `addressFor`,
 * `allRoles` — so a test that only uses those works against either
 * variant by changing one constructor.
 *
 *   const spec = new ParallelMultiNodeSpec({
 *     roles: ['a', 'b', 'c'],
 *     scenarioModule: new URL('./my-scenario.ts', import.meta.url),
 *   });
 *   await spec.start();
 *   await spec.awaitMembers('a', 3);
 *   const result = await spec.runIn('a', 'compute', { x: 42 });
 *   await spec.stop();
 *
 * The scenario module owns the actor-shaped setup (entity classes,
 * sharding regions, …) inside the worker — see
 * `src/testkit/internal/parallel-multi-node-bootstrap.ts` for the
 * `ScenarioModule` interface.
 */

interface NodeRecord {
  readonly role: string;
  readonly address: NodeAddress;
  worker: WorkerLike | null;       // null after crash/leave
  port: PortLike | null;           // broker-side port
  removed: boolean;
}

let nextPortBase = 30_500;          // disjoint from MultiNodeSpec's 30_000

/* ---------- Control channel: same wire as the bootstrap expects ---------- */

interface QueryMembersResponse {
  kind: 'mns-test.query-members-response'; reqId: number; members: MemberSnapshot[];
}
interface QueryLeaderResponse {
  kind: 'mns-test.query-leader-response'; reqId: number; leader: string | null;
}
interface LeaveResponse { kind: 'mns-test.leave-response'; reqId: number; error?: string }
interface RunCommandResponse {
  kind: 'mns-test.run-command-response'; reqId: number; result: unknown; error?: string;
}
type ControlResponse =
  | QueryMembersResponse | QueryLeaderResponse
  | LeaveResponse | RunCommandResponse;

export class ParallelMultiNodeSpec {
  private readonly options: Required<Omit<
    ParallelMultiNodeSpecOptionsType,
    'addresses' | 'failureDetector' | 'scenarioModule' | 'scenarioInitDataFor' | 'bootstrapModule'
  >> & Pick<
    ParallelMultiNodeSpecOptionsType,
    'addresses' | 'failureDetector' | 'scenarioModule' | 'scenarioInitDataFor' | 'bootstrapModule'
  >;
  private readonly nodes = new Map<string, NodeRecord>();
  private readonly broker = new MultiNodeBroker();
  private started = false;
  private nextReqId = 1;
  /** Pending RPC promises keyed by reqId. */
  private readonly pending = new Map<number, {
    resolve: (v: ControlResponse) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(optionsInput: ParallelMultiNodeSpecOptions) {
    const options = optionsInput as ParallelMultiNodeSpecOptionsType;
    if (options.roles.length === 0) {
      throw new Error('ParallelMultiNodeSpec: at least one role is required');
    }
    if (new Set(options.roles).size !== options.roles.length) {
      throw new Error('ParallelMultiNodeSpec: roles must be unique');
    }
    this.options = {
      roles: options.roles,
      seedRoles: options.seedRoles ?? [options.roles[0]!],
      gossipIntervalMs: options.gossipIntervalMs ?? 100,
      // 30s default (vs. 15s in MultiNodeSpec) — worker-thread bootstrap
      // is slower than the in-process variant.  NOTE: the worker-thread
      // suites that use this harness are QUARANTINED on GitHub's hosted
      // runners — Bun there cannot respawn functional workers after the
      // first test (they spawn + handshake, then never run; reproducible
      // only on the hosted runners, never locally or in Docker).  See the
      // [CI] tracking issue.  They run locally + in Docker, where this
      // budget is ample (convergence is ~4-5s).
      awaitTimeoutMs: options.awaitTimeoutMs ?? 30_000,
      logLevel: options.logLevel ?? LogLevel.Off,
      addresses: options.addresses,
      failureDetector: options.failureDetector,
      scenarioModule: options.scenarioModule,
      scenarioInitDataFor: options.scenarioInitDataFor,
      bootstrapModule: options.bootstrapModule,
    };
  }

  /* ---------------------------- lifecycle --------------------------- */

  async start(): Promise<void> {
    if (this.started) throw new Error('ParallelMultiNodeSpec: already started');
    this.started = true;

    const portBase = nextPortBase;
    nextPortBase += this.options.roles.length + 1;

    const addressByRole = new Map<string, NodeAddress>();
    this.options.roles.forEach((role, idx) => {
      const explicit = this.options.addresses?.[role];
      const host = explicit?.host ?? '127.0.0.1';
      const port = explicit?.port ?? (portBase + idx);
      addressByRole.set(role, new NodeAddress(role, host, port));
    });

    const seeds = this.options.seedRoles
      .map((r) => addressByRole.get(r)!.toString());

    const orderedRoles = [
      ...this.options.seedRoles,
      ...this.options.roles.filter((r) => !this.options.seedRoles.includes(r)),
    ];
    for (const role of orderedRoles) {
      const address = addressByRole.get(role)!;
      const handle = await this.spawnRole(role, address, seeds);
      this.nodes.set(role, handle);
    }
  }

  async stop(): Promise<void> {
    const errs: Error[] = [];
    for (const node of this.nodes.values()) {
      if (node.removed) continue;
      // AWAIT termination.  On Bun `Worker.terminate()` returns a promise
      // that resolves once the worker thread is actually gone; firing it
      // without awaiting leaked live worker threads across tests.  On a
      // 2-core CI runner those leaked workers (busy on a now-dead
      // transport) starved every subsequent worker-thread test to zero
      // CPU — control RPCs timed out and no gossip ever flowed (#flaky-ci).
      try { if (node.worker) await this.terminateAndWait(node.worker); } catch (e) { errs.push(e as Error); }
    }
    this.broker.close();
    this.nodes.clear();
    this.started = false;
    // Reject any in-flight RPCs.
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('ParallelMultiNodeSpec: stopped'));
    }
    this.pending.clear();
    if (errs.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`ParallelMultiNodeSpec.stop ran into ${errs.length} error(s):`, errs.map((e) => e.message));
    }
  }

  async crash(role: string): Promise<void> {
    const node = this.requireNode(role);
    if (node.removed) return;
    node.removed = true;
    if (node.worker) {
      try { await this.terminateAndWait(node.worker); } catch { /* ignore */ }
    }
    if (node.port) this.broker.unregister(node.address);
    node.worker = null; node.port = null;
  }

  async leave(role: string): Promise<void> {
    const node = this.requireNode(role);
    if (node.removed) return;
    node.removed = true;
    try { await this.controlRpc(node, { kind: 'mns-test.leave' }); }
    catch { /* ignore — graceful leave is best-effort */ }
    // After cluster.leave returns, the worker has closed its
    // transport; we still have to terminate the worker process.
    // AWAIT it — an un-awaited terminate leaks the worker thread (see
    // the note in stop()).
    if (node.worker) {
      try { await this.terminateAndWait(node.worker); } catch { /* ignore */ }
    }
    if (node.port) this.broker.unregister(node.address);
    node.worker = null; node.port = null;
  }

  partition(roleA: string, roleB: string): void {
    this.broker.partition(this.requireNode(roleA).address, this.requireNode(roleB).address);
  }

  heal(roleA: string, roleB: string): void {
    this.broker.heal(this.requireNode(roleA).address, this.requireNode(roleB).address);
  }

  /* ---------------------------- accessors --------------------------- */

  addressFor(role: string): NodeAddress { return this.requireNode(role).address; }
  allRoles(): string[] { return Array.from(this.nodes.keys()); }

  /** Async snapshot of the worker's view of cluster members. */
  async getMembers(role: string): Promise<MemberSnapshot[]> {
    const node = this.requireNode(role);
    const resp = await this.controlRpc<QueryMembersResponse>(node, { kind: 'mns-test.query-members' });
    return resp.members;
  }

  async getLeader(role: string): Promise<string | null> {
    const node = this.requireNode(role);
    const resp = await this.controlRpc<QueryLeaderResponse>(node, { kind: 'mns-test.query-leader' });
    return resp.leader;
  }

  /** Invoke a scenario-defined command on the worker. */
  async runIn<R = unknown>(role: string, command: string, args: unknown = undefined): Promise<R> {
    const node = this.requireNode(role);
    const resp = await this.controlRpc<RunCommandResponse>(node, {
      kind: 'mns-test.run-command', command, args,
    });
    if (resp.error) throw new Error(`runIn(${role}, ${command}): ${resp.error}`);
    return resp.result as R;
  }

  /* ---------------------------- await helpers --------------------------- */

  async awaitMembers(
    role: string, expectedCount: number, timeoutMs: number = this.options.awaitTimeoutMs,
  ): Promise<void> {
    await this.awaitCondition(
      async () => {
        const members = await this.getMembers(role);
        return members.filter((m) => m.status === 'up').length === expectedCount;
      },
      `awaitMembers(${role}, expected=${expectedCount})`,
      timeoutMs,
    );
  }

  async awaitMemberStatus(
    role: string, targetRole: string, status: Member['status'],
    timeoutMs: number = this.options.awaitTimeoutMs,
  ): Promise<void> {
    const targetAddr = this.requireNode(targetRole).address.toString();
    await this.awaitCondition(
      async () => {
        const members = await this.getMembers(role);
        return members.find((m) => m.address === targetAddr)?.status === status;
      },
      `awaitMemberStatus(${role}, ${targetRole} → ${status})`,
      timeoutMs,
    );
  }

  async awaitLeader(
    role: string, expectedLeaderRole: string | null,
    timeoutMs: number = this.options.awaitTimeoutMs,
  ): Promise<void> {
    const expectedAddr = expectedLeaderRole
      ? this.requireNode(expectedLeaderRole).address.toString()
      : null;
    await this.awaitCondition(
      async () => (await this.getLeader(role)) === expectedAddr,
      `awaitLeader(${role}, expected=${expectedLeaderRole ?? 'null'})`,
      timeoutMs,
    );
  }

  /* ----------------------------- internals ---------------------------- */

  private requireNode(role: string): NodeRecord {
    const node = this.nodes.get(role);
    if (!node) throw new Error(`ParallelMultiNodeSpec: unknown role '${role}'`);
    return node;
  }

  /**
   * Terminate a worker and WAIT until it has actually exited.  Bun's
   * `Worker.terminate()` is fire-and-forget (returns void), so simply
   * awaiting it does not guarantee the OS thread is gone before the next
   * test spawns more — which on a 2-core CI runner left dead/starved
   * workers piling up.  Here we kick `terminate()` and then await the
   * worker's `close` event (bounded, so a runtime that emits no close
   * event doesn't hang teardown).
   */
  private async terminateAndWait(worker: WorkerLike): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      let done = false;
      const fin = (): void => { if (!done) { done = true; resolve(); } };
      try { worker.addEventListener('close', fin); } catch { /* ignore */ }
      setTimeout(fin, 3_000);
    });
    try { await worker.terminate(); } catch { /* ignore */ }
    await closed;
  }

  private async awaitCondition(
    cond: () => Promise<boolean>, description: string, timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await cond()) return; } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`ParallelMultiNodeSpec: timeout after ${timeoutMs} ms — ${description}`);
  }

  /**
   * Spawn one worker, do the WorkerNode handshake, register the
   * worker-side port with the broker, and wire up the control
   * channel so RPC responses flow back to `this.pending`.
   */
  private async spawnRole(
    role: string, address: NodeAddress, seeds: string[],
  ): Promise<NodeRecord> {
    const backend = await getWorkerBackend();
    const bootstrap = this.options.bootstrapModule
      ?? new URL('./internal/parallel-multi-node-bootstrap.js', import.meta.url);
    const worker = backend.spawn(bootstrap, { name: `parallel-mns-${role}` });

    const initData = {
      role,
      seeds,
      failureDetector: this.options.failureDetector,
      gossipIntervalMs: this.options.gossipIntervalMs,
      logLevel: this.options.logLevel,
      scenarioModule: this.options.scenarioModule?.toString(),
      scenarioInitData: this.options.scenarioInitDataFor?.(role),
    };
    const init: WorkerInitMessage = {
      kind: 'worker-init',
      self: address.toJSON(),
      systemName: role,
      data: initData,
    };

    // Hello/init/ready handshake — exactly mirrors WorkerCluster.
    await this.handshake(worker, init, address);

    // Wire the broker port — same shape as WorkerCluster.brokerFacade.
    const port = this.brokerFacade(worker);
    this.broker.register(address, port);

    // Listen for control-channel responses on the worker's main
    // postMessage stream.  Cluster transport frames are tagged
    // `actor-ts.transport`; control frames are `mns-test.*`.
    worker.addEventListener('message', (e) => {
      const data = (e.data ?? undefined) as { kind?: string } | undefined;
      if (!data?.kind || !data.kind.startsWith('mns-test.')) return;
      const reqId = (data as { reqId?: number }).reqId;
      const pending = reqId !== undefined ? this.pending.get(reqId) : undefined;
      if (!pending) return;
      this.pending.delete(reqId!);
      clearTimeout(pending.timer);
      pending.resolve(data as ControlResponse);
    });

    return { role, address, worker, port, removed: false };
  }

  private brokerFacade(worker: WorkerLike): PortLike {
    let handler: ((e: { data: unknown }) => void) | null = null;
    worker.addEventListener('message', (e) => {
      const msg = (e.data ?? undefined) as { kind?: string } | undefined;
      if (msg && msg.kind === 'worker-transport' && handler) {
        handler({ data: (msg as WorkerTransportMessage).envelope });
      }
    });
    return {
      postMessage(v: unknown): void {
        const envelope: BrokeredMessage = v as BrokeredMessage;
        const msg: WorkerTransportMessage = { kind: 'worker-transport', envelope };
        worker.postMessage(msg);
      },
      get onmessage(): ((e: { data: unknown }) => void) | null { return handler; },
      set onmessage(h: ((e: { data: unknown }) => void) | null) { handler = h; },
      close(): void { handler = null; },
    } as PortLike;
  }

  private handshake(
    worker: WorkerLike, init: WorkerInitMessage, addr: NodeAddress,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.removeEventListener('message', onMessage);
        reject(new Error(`Worker ${addr} did not become ready within 10s`));
      }, 10_000);
      const onMessage = (e: { data?: unknown }): void => {
        const msg = (e.data ?? undefined) as { kind?: string } | undefined;
        if (!msg) return;
        if (msg.kind === 'worker-hello') {
          const hello: WorkerHelloMessage = msg as WorkerHelloMessage;
          void hello;
          worker.postMessage(init);
        } else if (msg.kind === 'worker-ready') {
          const ready: WorkerReadyMessage = msg as WorkerReadyMessage;
          void ready;
          clearTimeout(timeout);
          worker.removeEventListener('message', onMessage);
          resolve();
        }
      };
      worker.addEventListener('message', onMessage);
    });
  }

  /**
   * Send a control request to a worker and await its response.
   * Times out after 5s — RPC failures usually indicate the worker
   * is wedged; fast timeouts surface the issue rather than hanging
   * the test forever.
   */
  private controlRpc<R extends ControlResponse>(
    node: NodeRecord,
    request: { kind: string; command?: string; args?: unknown },
  ): Promise<R> {
    if (!node.worker) {
      return Promise.reject(new Error(`controlRpc: role '${node.role}' has been crashed/left`));
    }
    const reqId = this.nextReqId++;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`controlRpc(${request.kind}): timed out after 5s`));
      }, 5_000);
      this.pending.set(reqId, {
        resolve: (v) => resolve(v as R),
        reject,
        timer,
      });
      node.worker!.postMessage({ ...request, reqId });
    });
  }
}
