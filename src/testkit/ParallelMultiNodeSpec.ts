import { match } from 'ts-pattern';
import type { ParallelMultiNodeSpecOptions, ParallelMultiNodeSpecOptionsType } from './ParallelMultiNodeSpecOptions.js';
import type {
  BrokeredMessage,
  PortLike,
} from '../cluster/transports/MessageChannelTransport.js';
import type { FailureDetectorOptionsType } from '../cluster/FailureDetectorOptions.js';
import type { Member } from '../cluster/Member.js';
import { NodeAddress } from '../cluster/NodeAddress.js';
import { LogLevel } from '../Logger.js';
import {
  getWorkerBackend,
  type WorkerErrorEvent,
  type WorkerLike,
  type WorkerMessageEvent,
} from '../runtime/worker/index.js';
import type {
  WorkerHelloMessage,
  WorkerInitMessage,
  WorkerReadyMessage,
  WorkerTransportMessage,
} from '../worker/WorkerCluster.js';
import { MultiNodeBroker } from './internal/MultiNodeBroker.js';
import type { MemberSnapshot } from './internal/ParallelMultiNodeBootstrap.js';

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
 * `src/testkit/internal/ParallelMultiNodeBootstrap.ts` for the
 * `ScenarioModule` interface.
 */

type NodeRecord = {
  readonly role: string;
  readonly address: NodeAddress;
  worker: WorkerLike | null;       // null after crash/leave
  port: PortLike | null;           // broker-side port
  removed: boolean;
};

let nextPortBase = 30_500;          // disjoint from MultiNodeSpec's 30_000

/* ---------- Control channel: same wire as the bootstrap expects ---------- */

type QueryMembersResponse = {
  kind: 'mns-test.query-members-response'; reqId: number; members: MemberSnapshot[];
};
type QueryLeaderResponse = {
  kind: 'mns-test.query-leader-response'; reqId: number; leader: string | null;
};
type LeaveResponse = { kind: 'mns-test.leave-response'; reqId: number; error?: string };
type RunCommandResponse = {
  kind: 'mns-test.run-command-response'; reqId: number; result: unknown; error?: string;
};
type ControlResponse =
  | QueryMembersResponse | QueryLeaderResponse
  | LeaveResponse | RunCommandResponse;

/** The four requests `controlRpc` can post; each reply is this plus `-response`. */
type ControlRequestKind =
  | 'mns-test.query-members' | 'mns-test.query-leader'
  | 'mns-test.leave' | 'mns-test.run-command';

/**
 * One control RPC the harness is waiting on.
 *
 * `role` and `expectedKind` are the correlation, not decoration.  `reqId` is an
 * instance-global counter and every role's listener resolves out of one map, so
 * the number names a request but not a conversation — matching on it alone lets
 * a frame from the wrong worker, or of the wrong kind, settle someone else's
 * promise (#777).
 */
type PendingControlRequest = {
  /** Role the request was posted to; a reply from any other role is a mismatch. */
  readonly role: string;
  /** `kind` the matching reply must carry. */
  readonly expectedKind: ControlResponse['kind'];
  readonly resolve: (response: ControlResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export class ParallelMultiNodeSpec {
  private readonly options: Required<Omit<
    ParallelMultiNodeSpecOptionsType,
    'addresses' | 'failureDetector' | 'scenarioModule' | 'scenarioInitDataFor' | 'bootstrapModule' | 'backend'
  >> & Pick<
    ParallelMultiNodeSpecOptionsType,
    'addresses' | 'failureDetector' | 'scenarioModule' | 'scenarioInitDataFor' | 'bootstrapModule' | 'backend'
  >;
  private readonly nodes = new Map<string, NodeRecord>();
  private readonly broker = new MultiNodeBroker();
  private started = false;
  private nextReqId = 1;
  /** Pending RPC promises keyed by reqId. */
  private readonly pending = new Map<number, PendingControlRequest>();

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
      // only on the hosted runners, never locally or in Docker).  See #538
      // for the quarantine and its exit criterion.  They run locally + in
      // Docker, where this budget is ample (convergence is ~4-5s).
      awaitTimeoutMs: options.awaitTimeoutMs ?? 30_000,
      logLevel: options.logLevel ?? LogLevel.Off,
      addresses: options.addresses,
      failureDetector: options.failureDetector,
      scenarioModule: options.scenarioModule,
      scenarioInitDataFor: options.scenarioInitDataFor,
      bootstrapModule: options.bootstrapModule,
      backend: options.backend,
    };
  }

  /* ---------------------------- lifecycle --------------------------- */

  async start(): Promise<void> {
    if (this.started) throw new Error('ParallelMultiNodeSpec: already started');
    this.started = true;

    const portBase = nextPortBase;
    nextPortBase += this.options.roles.length + 1;

    const addressByRole = new Map<string, NodeAddress>();
    this.options.roles.forEach((role, index) => {
      const explicit = this.options.addresses?.[role];
      const host = explicit?.host ?? '127.0.0.1';
      const port = explicit?.port ?? (portBase + index);
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
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('ParallelMultiNodeSpec: stopped'));
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
    const response = await this.controlRpc<QueryMembersResponse>(node, { kind: 'mns-test.query-members' });
    return response.members;
  }

  async getLeader(role: string): Promise<string | null> {
    const node = this.requireNode(role);
    const response = await this.controlRpc<QueryLeaderResponse>(node, { kind: 'mns-test.query-leader' });
    return response.leader;
  }

  /** Invoke a scenario-defined command on the worker. */
  async runIn<R = unknown>(role: string, command: string, args: unknown = undefined): Promise<R> {
    const node = this.requireNode(role);
    const response = await this.controlRpc<RunCommandResponse>(node, {
      kind: 'mns-test.run-command', command, args,
    });
    if (response.error) throw new Error(`runIn(${role}, ${command}): ${response.error}`);
    return response.result as R;
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
    const backend = this.options.backend ?? await getWorkerBackend();
    const bootstrap = this.options.bootstrapModule
      ?? new URL('./internal/ParallelMultiNodeBootstrap.js', import.meta.url);
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

    // Subscribe `error` BEFORE the handshake, because without a subscriber an
    // uncaught throw inside this worker takes the whole test process with it.
    // Containment is not a property of the runtime, it is a property of having
    // a subscriber at all: the Web-Worker adapter cancels the event from
    // inside the listener it installs — Deno re-raises the worker's throw as
    // an unhandled rejection and exits 1 otherwise — and the Node adapter only
    // registers `on('error')` when something subscribes, without which Node
    // re-raises on the host and exits 1 (#700).  `WorkerCluster` already
    // subscribes; this harness did not, so the framework's own multi-node
    // suites died with the host on a worker throw.
    worker.addEventListener('error', (e) => this.onWorkerError(role, e));

    // Hello/init/ready handshake — exactly mirrors WorkerCluster.
    await this.handshake(worker, init, address);

    // Wire the broker port — same shape as WorkerCluster.brokerFacade.
    const port = this.brokerFacade(worker);
    this.broker.register(address, port);

    // Listen for control-channel responses on the worker's main
    // postMessage stream.  Cluster transport frames are tagged
    // `actor-ts.transport`; control frames are `mns-test.*`.  The role is
    // bound into the listener here because it is the only place that still
    // knows which worker a frame came out of — the frame itself does not say.
    worker.addEventListener('message', (e) => this.onControlFrame(role, e));

    return { role, address, worker, port, removed: false };
  }

  /**
   * A control frame arrived from `role`'s worker.
   *
   * Settling on `reqId` alone was the defect (#777): the counter is
   * instance-global and every role's listener resolves out of the same map, so
   * a frame carrying a number the harness handed to *another* role settled
   * that role's RPC.  The wrong value is the smaller half of the damage — a
   * `run-command-response` settling a `getMembers` yields `members ===
   * undefined`, the `.filter(…)` in `awaitMembers`'s condition throws,
   * `awaitCondition` swallows the throw as a retry, and the spec fails 30 s
   * later naming a convergence that was never the problem.
   *
   * Only a worker that *originates* an `mns-test.*` frame can produce the
   * collision — a custom `bootstrapModule`, or a scenario module posting raw
   * frames.  The shipped bootstrap stamps `reqId` from the request it is
   * answering, so no scenario command handler can echo a stale one.
   */
  private onControlFrame(role: string, event: WorkerMessageEvent): void {
    const frame = (event.data ?? undefined) as { kind?: string; reqId?: number } | undefined;
    if (!frame?.kind || !frame.kind.startsWith('mns-test.')) return;
    const reqId = frame.reqId;
    if (reqId === undefined) return;
    const pending = this.pending.get(reqId);
    if (!pending) return;
    if (pending.role !== role || pending.expectedKind !== frame.kind) {
      this.onMisdirectedControlFrame(role, frame.kind, reqId, pending);
      return;
    }
    this.pending.delete(reqId);
    clearTimeout(pending.timer);
    pending.resolve(frame as ControlResponse);
  }

  /**
   * A frame matched a pending `reqId` but not the RPC that owns it.
   *
   * Dropped rather than settled, and the entry is left pending so the genuine
   * reply can still land — or `controlRpc`'s own 5 s timer fires and names the
   * request that went unanswered, which is a far shorter walk to the cause than
   * the `await*` timeout the mis-correlation produced.  Reported for the same
   * reason `onWorkerError` is: the harness owns no `ActorSystem` to log
   * through, and a silent drop leaves the reader with a timeout and no clue
   * that a stray frame ever existed.
   */
  private onMisdirectedControlFrame(
    role: string, kind: string, reqId: number, pending: PendingControlRequest,
  ): void {
    console.warn(
      `ParallelMultiNodeSpec: dropped control frame '${kind}' from role '${role}' `
      + `(reqId ${reqId}) — that reqId belongs to a '${pending.expectedKind}' `
      + `awaited from role '${pending.role}'`,
    );
  }

  /**
   * A worker threw where nothing else could see it.
   *
   * Reported rather than swallowed.  A silent handler would contain the crash
   * just as well and leave the run looking like a plain control-RPC timeout
   * thirty seconds later, which is the harder of the two failures to
   * diagnose.  The console is the only destination available: the harness owns
   * no `ActorSystem` — every system lives inside a worker — so there is no
   * logger to route this to, which is the same reason
   * `internal/ParallelMultiNodeBootstrap.ts` writes to the console.
   */
  private onWorkerError(role: string, event: WorkerErrorEvent): void {
    console.error(`ParallelMultiNodeSpec: worker '${role}' threw:`, event.error ?? event.message);
  }

  private brokerFacade(worker: WorkerLike): PortLike {
    let handler: ((e: { data: unknown }) => void) | null = null;
    worker.addEventListener('message', (e) => {
      const message = (e.data ?? undefined) as { kind?: string } | undefined;
      if (message && message.kind === 'worker-transport' && handler) {
        handler({ data: (message as WorkerTransportMessage).envelope });
      }
    });
    return {
      postMessage(v: unknown): void {
        const envelope: BrokeredMessage = v as BrokeredMessage;
        const message: WorkerTransportMessage = { kind: 'worker-transport', envelope };
        worker.postMessage(message);
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
      /**
       * First hello wins — the same latch as `WorkerCluster.handshake`, and
       * for the same reason: `postMessage` structured-clones `init` on this
       * thread, so an unlatched hello lets one worker charge the harness a
       * clone per frame for the whole timeout window (#775).
       */
      let helloSeen = false;
      const onWorkerHello = (_hello: WorkerHelloMessage): void => {
        if (helloSeen) return;
        helloSeen = true;
        worker.postMessage(init);
      };
      const onWorkerReady = (_ready: WorkerReadyMessage): void => {
        clearTimeout(timeout);
        worker.removeEventListener('message', onMessage);
        resolve();
      };
      const onMessage = (e: { data?: unknown }): void => {
        const message = (e.data ?? undefined) as { kind?: string } | undefined;
        if (!message) return;
        // `.otherwise`, not `.exhaustive`: this is untrusted postMessage data
        // from a worker that may not have started correctly, so the value is
        // typed as an open `{ kind?: string }` and anything unrecognised is
        // ignored rather than crashing the handshake.
        match(message)
          .with({ kind: 'worker-hello' }, (m) => onWorkerHello(m as WorkerHelloMessage))
          .with({ kind: 'worker-ready' }, (m) => onWorkerReady(m as WorkerReadyMessage))
          .otherwise(() => {});
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
    request: { kind: ControlRequestKind; command?: string; args?: unknown },
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
        role: node.role,
        expectedKind: `${request.kind}-response`,
        resolve: (v) => resolve(v as R),
        reject,
        timer,
      });
      node.worker!.postMessage({ ...request, reqId });
    });
  }
}
