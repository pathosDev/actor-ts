import { match } from 'ts-pattern';
import { ParallelMultiNodeSpecOptionsValidator } from './ParallelMultiNodeSpecOptions.js';
import type { ParallelMultiNodeSpecOptions, ParallelMultiNodeSpecOptionsType } from './ParallelMultiNodeSpecOptions.js';
import type {
  BrokeredMessage,
  PortLike,
} from '../cluster/transports/MessageChannelTransport.js';
import type { FailureDetectorOptionsType } from '../cluster/FailureDetectorOptions.js';
import type { Member } from '../cluster/Member.js';
import { NodeAddress } from '../cluster/NodeAddress.js';
import { LogLevel } from '../Logger.js';
import { describeTimeFactor, scaledMs } from './TimeFactor.js';
import {
  resolveWorkerBackend,
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
  /**
   * One counter for the whole spec, on purpose — not one per role.
   *
   * #777's suggested fix offered a per-role counter as an option and it was
   * declined.  The correlation matches on `role` and `expectedKind` as well
   * as on the number, so a value two roles happen to share is harmless, and
   * when one does arrive from the wrong worker
   * {@link onMisdirectedControlFrame} says so by name.  A per-role counter
   * would make that collision rarer without making it safer, and rarer is
   * the worse property here: that warning is the only thing that surfaces a
   * custom `bootstrapModule` or a scenario posting frames it should not.
   */
  private nextRequestId = 1;
  /** Pending RPC promises keyed by the `reqId` the harness stamped. */
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
      // 30s default (vs. 15s in MultiNodeSpec) — worker-thread bootstrap is
      // slower than the in-process variant, and this budget is ample for it
      // (convergence is ~4-5s).  Scaled once, at resolution (#1376).  This
      // spec is the one the factor was written for: it drives real worker
      // threads, which is where a hosted runner's slowness actually shows —
      // and the suites that use it run on GitHub's hosted runners like any
      // other, the #538 quarantine having been measured against its own exit
      // criterion and lifted.
      awaitTimeoutMs: scaledMs(options.awaitTimeoutMs ?? 30_000),
      logLevel: options.logLevel ?? LogLevel.Off,
      addresses: options.addresses,
      failureDetector: options.failureDetector,
      scenarioModule: options.scenarioModule,
      scenarioInitDataFor: options.scenarioInitDataFor,
      bootstrapModule: options.bootstrapModule,
      backend: options.backend,
    };
    // Once, on the merged settings, so a builder and a plain object are held
    // to the same rules — and after the spread, so a cross-field rule would
    // see the resolved values (#1508).
    new ParallelMultiNodeSpecOptionsValidator().validate(this.options);
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
      // Terminate through the helper, and AWAIT it — what `terminate()` does
      // and does not promise is stated once, on `terminateAndWait` (#1277).
      // The consequence is what belongs here: dropping that await leaked live
      // worker threads across tests, and on a 2-core CI runner those leaked
      // workers (busy on a now-dead transport) starved every subsequent
      // worker-thread test to zero CPU — control RPCs timed out and no gossip
      // ever flowed.
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
    // transport; we still have to terminate the worker process — through
    // `terminateAndWait`, for the reason stated there (#1277).
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
   * Terminate a worker and WAIT until it has actually exited.
   *
   * **The one statement of Bun's `terminate()` contract in this file** (#1277):
   * it is fire-and-forget, so awaiting it does not guarantee the OS thread is
   * gone before the next test spawns more — which on a 2-core CI runner left
   * dead/starved workers piling up.  So this kicks `terminate()` and then
   * awaits the worker's own `close` event instead; every teardown path goes
   * through here rather than awaiting `terminate()` directly, and the
   * comments at those call sites point back at this one.
   *
   * The wait is **bounded** because a runtime that emits no `close` event at
   * all would otherwise hang teardown for good.  The bound is the exception,
   * not the path taken — so it is *cancelled* the moment `close` arrives,
   * rather than left to expire: `stop()` runs five times over two workers in
   * this harness's own suite, and an uncancelled fallback leaves every one of
   * those teardowns holding a 3 s timer it will never use (#1508).  Cancelled,
   * not unref'd: an unref'd timer is still armed and still runs its callback
   * whenever something else keeps the loop alive.
   */
  private async terminateAndWait(worker: WorkerLike): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      let done = false;
      let fallback: ReturnType<typeof setTimeout> | undefined;
      const fin = (): void => {
        if (done) return;
        done = true;
        clearTimeout(fallback);
        resolve();
      };
      try { worker.addEventListener('close', fin); } catch { /* ignore */ }
      fallback = setTimeout(fin, 3_000);
    });
    try { await worker.terminate(); } catch { /* ignore */ }
    await closed;
  }

  /**
   * Poll `cond` until it is true, or `timeoutMs` is up.
   *
   * A throw is a retry, and has to be: the conditions here query a worker over
   * the control channel while a cluster is still converging, so throwing is a
   * normal intermediate state rather than a verdict.  What is *not* normal is
   * losing it — the swallow is the amplifier #777 names in its own body.  A
   * mis-correlated reply is only one way in (a `run-command-response`
   * settling a `getMembers` leaves `members` undefined and the `.filter(…)`
   * throws); every other throw inside `cond` ended the same way, as a timeout
   * that named the wait and nothing about why it never finished.  So the last
   * one is kept and appended, which is the difference between a message that
   * sends the reader to convergence and one that names the actual failure.
   *
   * The *last* rather than the first: an early throw is usually the cluster
   * not being up yet, and the one still happening when the budget ran out is
   * the one that was never going to stop.
   */
  private async awaitCondition(
    cond: () => Promise<boolean>, description: string, timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: string | undefined;
    while (Date.now() < deadline) {
      try { if (await cond()) return; }
      catch (e) { lastError = e instanceof Error ? e.message : String(e); }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `ParallelMultiNodeSpec: timeout after ${timeoutMs} ms${describeTimeFactor()} — ${description}`
      + (lastError === undefined ? '' : `; last error: ${lastError}`),
    );
  }

  /**
   * Spawn one worker, do the WorkerNode handshake, register the
   * worker-side port with the broker, and wire up the control
   * channel so RPC responses flow back to `this.pending`.
   */
  private async spawnRole(
    role: string, address: NodeAddress, seeds: string[],
  ): Promise<NodeRecord> {
    // Before the spawn: a backend that declares no error containment is
    // reported before the first worker that could take the test process with
    // it exists (#1288).  Once per backend instance — the helper latches.
    const backend = await resolveWorkerBackend(
      this.options.backend,
      (message) => this.reportUncontainedBackend(message),
    );
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
   * `awaitCondition` retries past the throw, and the spec fails 30 s later
   * naming a convergence that was never the problem — with the thrown message
   * appended since #1508, which is what makes that failure readable at all.
   *
   * Only a worker that *originates* an `mns-test.*` frame can produce the
   * collision — a custom `bootstrapModule`, or a scenario module posting raw
   * frames.  The shipped bootstrap stamps `reqId` from the request it is
   * answering, so no scenario command handler can echo a stale one.
   */
  private onControlFrame(role: string, event: WorkerMessageEvent): void {
    const frame = (event.data ?? undefined) as { kind?: string; reqId?: number } | undefined;
    if (!frame?.kind || !frame.kind.startsWith('mns-test.')) return;
    const requestId = frame.reqId;
    if (requestId === undefined) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (pending.role !== role || pending.expectedKind !== frame.kind) {
      this.onMisdirectedControlFrame(role, frame.kind, requestId, pending);
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(frame as ControlResponse);
  }

  /**
   * A frame matched a pending `reqId` but not the RPC that owns it.
   *
   * Dropped rather than settled, and the entry is left pending so the genuine
   * reply can still land — or `controlRpc`'s own 5 s timer fires and names the
   * role and the request that went unanswered, which is a far shorter walk to
   * the cause than the `await*` timeout the mis-correlation produced.  The two
   * lines are a pair, and both name a role for that reason (#1508).  Reported
   * for the same reason `onWorkerError` is: the harness owns no `ActorSystem`
   * to log through, and a silent drop leaves the reader with a timeout and no
   * clue that a stray frame ever existed.
   */
  private onMisdirectedControlFrame(
    role: string, kind: string, requestId: number, pending: PendingControlRequest,
  ): void {
    console.warn(
      `ParallelMultiNodeSpec: dropped control frame '${kind}' from role '${role}' `
      + `(reqId ${requestId}) — that reqId belongs to a '${pending.expectedKind}' `
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

  /**
   * The backend declared `containsWorkerErrors: false`: the `error`
   * subscription above will not stop a worker's throw from killing the test
   * process on that backend, and this line is what says why afterwards.  The
   * same destination as {@link onWorkerError}, for the same reason (#1288).
   */
  private reportUncontainedBackend(message: string): void {
    console.error(`ParallelMultiNodeSpec: ${message}`);
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
      // The handshake and the control RPC below scale too: they are the two
      // deadlines a slow runner actually crosses, and #538's documented symptom
      // is workers that spawn, handshake and then never run.
      const handshakeMs = scaledMs(10_000);
      const timeout = setTimeout(() => {
        worker.removeEventListener('message', onMessage);
        reject(new Error(
          `Worker ${addr} did not become ready within ${handshakeMs}ms${describeTimeFactor()}`,
        ));
      }, handshakeMs);
      /**
       * First hello wins — the same latch as `WorkerCluster.handshake`, and
       * for the same reason: `postMessage` structured-clones `init` on this
       * thread, so an unlatched hello lets one worker charge the harness a
       * clone per frame for the whole timeout window (#775).
       */
      let helloSeen = false;
      const onWorkerHello = (_hello: WorkerHelloMessage): void => {
        if (helloSeen) return;
        try {
          worker.postMessage(init);
        } catch (error) {
          onInitFrameRefused(error);
          return;
        }
        // Latched on the successful post: a post that threw sent nothing, so
        // there is no init frame for a later hello to duplicate.
        helloSeen = true;
      };
      /**
       * `init.data` is not all harness-built — `scenarioInitDataFor` is the
       * test's own function and its return value rides in that frame — so the
       * clone `postMessage` runs on this thread can refuse it, throwing a
       * `DataCloneError` from inside this listener where nothing above it
       * catches.  The same guard `WorkerCluster.handshake` carries, for the
       * same reason and with the same effect: without it `start()` never
       * settled, it waited out the handshake budget for a frame that had
       * never left the harness (#1515).
       */
      const onInitFrameRefused = (cause: unknown): void => {
        clearTimeout(timeout);
        worker.removeEventListener('message', onMessage);
        reject(new Error(
          `Worker ${addr} could not be sent its init frame — the role's init data must be `
          + `structured-cloneable (${cause instanceof Error ? cause.message : String(cause)})`,
          { cause },
        ));
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
   *
   * The rejection names the **role** as well as the request kind.  Which
   * question went unanswered is only half of what the reader needs: with
   * three or more roles in flight the interesting fact is which worker
   * stopped answering, and until #1508 the only line that said so was the
   * misdirected-frame warning, which is written on a different failure.
   */
  private controlRpc<R extends ControlResponse>(
    node: NodeRecord,
    request: { kind: ControlRequestKind; command?: string; args?: unknown },
  ): Promise<R> {
    if (!node.worker) {
      return Promise.reject(new Error(`controlRpc: role '${node.role}' has been crashed/left`));
    }
    const requestId = this.nextRequestId++;
    return new Promise<R>((resolve, reject) => {
      const controlRpcMs = scaledMs(5_000);
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(
          `controlRpc(${request.kind}) to role '${node.role}': `
          + `timed out after ${controlRpcMs}ms${describeTimeFactor()}`,
        ));
      }, controlRpcMs);
      this.pending.set(requestId, {
        role: node.role,
        expectedKind: `${request.kind}-response`,
        resolve: (v) => resolve(v as R),
        reject,
        timer,
      });
      // `reqId` is the wire property the worker bootstrap answers on, and a
      // custom `bootstrapModule` reads it by that name — spelled out here only
      // on this side of the boundary (#1508).
      node.worker!.postMessage({ ...request, reqId: requestId });
    });
  }
}
