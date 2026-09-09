import type { ManualScheduler } from './ManualScheduler.js';
import type { MultiNodeSpecOptions, MultiNodeSpecOptionsType } from './MultiNodeSpecOptions.js';
import { ActorSystem } from '../ActorSystem.js';
import { ActorSystemOptions } from '../ActorSystemOptions.js';
import { Cluster } from '../cluster/Cluster.js';
import { ClusterOptions, type ClusterOptionsType } from '../cluster/ClusterOptions.js';
import type { DowningProvider } from '../cluster/downing/index.js';
import { type Member } from '../cluster/Member.js';
import { NodeAddress } from '../cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../Logger.js';
import { MultiNodeTransport } from './internal/MultiNodeTransport.js';
import { FaultyTransport } from './FaultyTransport.js';
import {
  DEFAULT_TRANSPORT_FAULT_SEED,
  type TransportFaultProfileType,
} from './FaultyTransportOptions.js';

/**
 * Multi-node-spec test harness — runs multiple `ActorSystem` + `Cluster`
 * instances in **one** process, routed through `MultiNodeTransport`,
 * with helpers for the operations real multi-node tests actually need:
 *
 *   - **Spin up N roles** at once (`new MultiNodeSpec({ roles: ['a','b','c'] })`),
 *     each with its own ActorSystem + Cluster + NodeAddress.  The first
 *     role acts as the seed by default.
 *   - **Cluster API access** per role — `clusterFor('a')`, `systemFor('b')`.
 *   - **Crash simulation** — `crash(role)` shuts down a node's transport
 *     ungracefully (other nodes detect via failure-detection); `leave(role)`
 *     does a graceful exit.
 *   - **Network partition** — `partition(roleA, roleB)` bidirectionally
 *     blocks messages between the two roles; `heal(...)` undoes it.
 *   - **Synchronization helpers** — `awaitMembers`, `awaitMemberStatus`,
 *     `awaitLeader` — poll-based assertions with a default 10 s timeout
 *     so race-prone multi-node tests have a deterministic exit point
 *     (rather than hanging forever).
 *
 * In-process means single event-loop — that loses true parallelism, but
 * gains determinism, fast test starts, and clean stack traces.  The
 * worker-thread-based variant could be a follow-up if real concurrency
 * matters.  For the scenarios we're targeting (sharding rebalance,
 * pubsub cross-node, singleton failover), in-process is enough.
 *
 *   const spec = new MultiNodeSpec({ roles: ['a', 'b', 'c'] });
 *   await spec.start();
 *   await spec.awaitMembers('a', 3);
 *
 *   spec.systemFor('b').spawnAnonymous(...);
 *   await spec.crash('b');
 *   await spec.awaitMembers('a', 2);
 *
 *   await spec.stop();
 */

type NodeRecord = {
  readonly role: string;
  readonly address: NodeAddress;
  readonly transport: MultiNodeTransport;
  /**
   * The fault layer wrapping {@link transport}, and the transport the cluster
   * was actually given.
   *
   * Both are kept because they answer different questions: partition and crash
   * are properties of the inner link, and loss/reordering/duplication/latency
   * are properties of the wrapper. Folding them into one would mean either the
   * partition controls growing fault logic or the reverse — the thing
   * decorating exists to avoid (#1023).
   */
  readonly faults: FaultyTransport;
  system: ActorSystem;
  cluster: Cluster;
  /** True after the node was crashed or removed.  Idempotent guard. */
  removed: boolean;
};

let nextPortBase = 30_000;

/**
 * Per-barrier state — every distinct barrier name gets one of these.
 * Once `entered.size === expectedRoles`, every parked waiter resolves.
 */
type BarrierEntry = {
  readonly expectedRoles: number;
  readonly entered: Set<string>;
  readonly waiters: Array<{
    resolve(): void;
    reject(err: Error): void;
    timer: ReturnType<typeof setTimeout> | null;
  }>;
};

export class MultiNodeSpec {
  private readonly options: Required<Omit<
    MultiNodeSpecOptionsType,
    'addresses' | 'failureDetector' | 'downing' | 'scheduler'
  >>
    & Pick<
      MultiNodeSpecOptionsType,
      'addresses' | 'failureDetector' | 'downing' | 'scheduler'
    >;
  private readonly nodes = new Map<string, NodeRecord>();
  private started = false;
  private readonly barriers = new Map<string, BarrierEntry>();

  constructor(optionsInput: MultiNodeSpecOptions) {
    const options = optionsInput as MultiNodeSpecOptionsType;
    if (options.roles.length === 0) {
      throw new Error('MultiNodeSpec: at least one role is required');
    }
    if (new Set(options.roles).size !== options.roles.length) {
      throw new Error('MultiNodeSpec: roles must be unique');
    }
    this.options = {
      roles: options.roles,
      seedRoles: options.seedRoles ?? [options.roles[0]!],
      gossipIntervalMs: options.gossipIntervalMs ?? 100,
      awaitTimeoutMs: options.awaitTimeoutMs ?? 10_000,
      logLevel: options.logLevel ?? LogLevel.Off,
      // Test-scale like the two intervals above: the shipped stability window
      // is 20 s, twice `awaitTimeoutMs`, so a spec inheriting it would time
      // out before its resolver had been consulted once (#839).
      stableAfterMs: options.stableAfterMs ?? 100,
      faultSeed: options.faultSeed ?? DEFAULT_TRANSPORT_FAULT_SEED,
      addresses: options.addresses,
      failureDetector: options.failureDetector,
      downing: options.downing,
      scheduler: options.scheduler,
    };
  }

  /** Bring up every role. */
  async start(): Promise<void> {
    if (this.started) throw new Error('MultiNodeSpec: already started');
    this.started = true;

    const portBase = nextPortBase;
    nextPortBase += this.options.roles.length + 1;

    // Step 1: build the address book up front so seeds can name peers.
    const addressByRole = new Map<string, NodeAddress>();
    this.options.roles.forEach((role, index) => {
      const explicit = this.options.addresses?.[role];
      const host = explicit?.host ?? '127.0.0.1';
      const port = explicit?.port ?? (portBase + index);
      addressByRole.set(role, new NodeAddress(role, host, port));
    });

    const seeds = this.options.seedRoles
      .map((r) => addressByRole.get(r))
      .filter((a): a is NodeAddress => a !== undefined)
      .map((a) => a.toString());

    // Step 2: spin up systems + clusters.  Seed role is started first
    // so the others can hit it with their initial join gossip.
    const orderedRoles = [
      ...this.options.seedRoles,
      ...this.options.roles.filter((r) => !this.options.seedRoles.includes(r)),
    ];
    for (const role of orderedRoles) {
      const address = addressByRole.get(role)!;
      const transport = new MultiNodeTransport(address);
      // Always wrapped, never conditionally: `degrade` has to be able to
      // start a fault after `start()`, and a spec that decided at construction
      // whether it might later want one would be back to a network that can
      // only be broken before the nodes come up.  A clean link costs one map
      // lookup per frame — see `FaultyTransport.send`.
      const faults = new FaultyTransport(transport, {
        seed: this.options.faultSeed,
        ...(this.options.scheduler ? { scheduler: this.options.scheduler } : {}),
      });
      const systemOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(this.options.logLevel);
      // One scheduler for the whole cluster, so `advance` moves every node's
      // gossip, heartbeat and detection ticks by the same amount at the same
      // instant.  Giving each node its own would put them on separate virtual
      // clocks, which is worse than sharing a real one.
      if (this.options.scheduler) systemOptions.withScheduler(this.options.scheduler);
      const system = ActorSystem.create(role, systemOptions);
      const clusterOptions = ClusterOptions.create()
        .withHost(address.host)
        .withPort(address.port)
        .withSeeds(seeds)
        .withTransport(faults)
        .withGossipIntervalMs(this.options.gossipIntervalMs)
        .withSeedRetryIntervalMs(100)
        .withSplitBrainResolver({ stableAfterMs: this.options.stableAfterMs });
      if (this.options.failureDetector) {
        clusterOptions.withFailureDetector(this.options.failureDetector);
      }
      const downing = this.options.downing?.(role);
      if (downing) clusterOptions.withDowning(downing);
      const cluster = await Cluster.join(system, clusterOptions);
      this.nodes.set(role, {
        role,
        address,
        transport,
        faults,
        system,
        cluster,
        removed: false,
      });
    }
  }

  /** Tear down every node.  Idempotent — safe to call after `crash()`. */
  async stop(): Promise<void> {
    const errs: Error[] = [];
    for (const node of this.nodes.values()) {
      try { if (!node.removed) await node.cluster.leave(); }
      catch (e) { errs.push(e as Error); }
      try { await node.system.terminate(); }
      catch (e) { errs.push(e as Error); }
    }
    this.nodes.clear();
    this.started = false;
    if (errs.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`MultiNodeSpec.stop encountered ${errs.length} error(s):`, errs.map((e) => e.message));
    }
  }

  /* ----------------------------- accessors ------------------------------ */

  systemFor(role: string): ActorSystem { return this.requireNode(role).system; }
  clusterFor(role: string): Cluster { return this.requireNode(role).cluster; }
  addressFor(role: string): NodeAddress { return this.requireNode(role).address; }
  /** All roles currently registered, regardless of crashed/active state. */
  allRoles(): string[] { return Array.from(this.nodes.keys()); }

  /* -------------------------- failure simulation ----------------------- */

  /**
   * Hard crash — shut down the transport so the node disappears
   * abruptly.  Other nodes notice via failure detection (typically
   * within `failureDetector.acceptableHeartbeatPause + threshold` ms).
   * The terminated node's `cluster` and `system` references stay live
   * for assertion purposes; calls to them post-crash will error.
   */
  async crash(role: string): Promise<void> {
    const node = this.requireNode(role);
    if (node.removed) return;
    node.removed = true;
    // Through the wrapper, so anything its reorder window is still holding is
    // dropped rather than delivered from a node that has crashed.
    await node.faults.shutdown();
  }

  /** Graceful leave — node sends a Leaving gossip, then shuts down. */
  async leave(role: string): Promise<void> {
    const node = this.requireNode(role);
    if (node.removed) return;
    node.removed = true;
    await node.cluster.leave();
  }

  /** Bidirectional partition between two roles.  Both sides drop traffic to the other. */
  partition(roleA: string, roleB: string): void {
    const nodeA = this.requireNode(roleA);
    const nodeB = this.requireNode(roleB);
    nodeA.transport.partitionFromPeer(nodeB.address);
    nodeB.transport.partitionFromPeer(nodeA.address);
  }

  /** Undo `partition(roleA, roleB)`. */
  heal(roleA: string, roleB: string): void {
    const nodeA = this.requireNode(roleA);
    const nodeB = this.requireNode(roleB);
    nodeA.transport.unblockOutgoing(nodeB.address);
    nodeB.transport.unblockOutgoing(nodeA.address);
  }

  /**
   * Degrade the link between two roles without severing it (#1023).
   *
   * The verb `partition` and `crash` could not express: a network that is
   * *working badly* rather than not at all.  Bidirectional, like `partition`,
   * because a one-way degradation is a different and rarer scenario — reach
   * for `transportFor(role).degradeTo(address, profile)` when that is what is
   * wanted.
   *
   * Deterministic: every decision comes from the spec's seed, so a run that
   * goes red reproduces from the number in its failure message.
   *
   * ```ts
   * spec.degrade('a', 'b', { dropProbability: 0.2, reorderWindow: 4 });
   * await spec.advance(5_000);
   * await spec.awaitMembers('a', 3);   // still converges, just later
   * ```
   */
  degrade(roleA: string, roleB: string, profile: TransportFaultProfileType): void {
    const nodeA = this.requireNode(roleA);
    const nodeB = this.requireNode(roleB);
    nodeA.faults.degradeTo(nodeB.address, profile);
    nodeB.faults.degradeTo(nodeA.address, profile);
  }

  /** Undo `degrade(roleA, roleB)`, releasing whatever the link was holding. */
  restore(roleA: string, roleB: string): void {
    const nodeA = this.requireNode(roleA);
    const nodeB = this.requireNode(roleB);
    nodeA.faults.restoreTo(nodeB.address);
    nodeB.faults.restoreTo(nodeA.address);
  }

  /**
   * The fault layer in front of one role's transport, for the asymmetric cases
   * {@link degrade} deliberately does not cover.
   */
  faultsFor(role: string): FaultyTransport { return this.requireNode(role).faults; }

  /* --------------------------- await helpers --------------------------- */

  /**
   * Wait until the named role's view of the cluster contains exactly
   * `expectedCount` members in `up`-or-better state.  Throws on timeout.
   */
  async awaitMembers(
    role: string, expectedCount: number, timeoutMs: number = this.options.awaitTimeoutMs,
  ): Promise<void> {
    await this.awaitCondition(
      () => {
        const cluster = this.requireNode(role).cluster;
        const upCount = cluster.getMembers().filter((m) => m.status === 'up').length;
        return upCount === expectedCount;
      },
      `awaitMembers(${role}, expected=${expectedCount}) — current: ${this.snapshotMemberCount(role)}`,
      timeoutMs,
    );
  }

  /**
   * Wait until the named role's view shows `targetMember` (by role name)
   * in the given status (`up`, `unreachable`, `down`, `removed`).
   */
  async awaitMemberStatus(
    role: string, targetRole: string, status: Member['status'],
    timeoutMs: number = this.options.awaitTimeoutMs,
  ): Promise<void> {
    const targetAddr = this.requireNode(targetRole).address.toString();
    await this.awaitCondition(
      () => {
        const cluster = this.requireNode(role).cluster;
        const member = cluster.getMembers().find((m) => m.address.toString() === targetAddr);
        return member?.status === status;
      },
      `awaitMemberStatus(${role}, ${targetRole} → ${status}) — current: ${this.snapshotMembers(role)}`,
      timeoutMs,
    );
  }

  /**
   * Wait until the named role's view of the leader is `expectedLeaderRole`,
   * or `null` to wait for "no leader".
   */
  async awaitLeader(
    role: string, expectedLeaderRole: string | null,
    timeoutMs: number = this.options.awaitTimeoutMs,
  ): Promise<void> {
    const expectedAddr = expectedLeaderRole
      ? this.requireNode(expectedLeaderRole).address.toString()
      : null;
    await this.awaitCondition(
      () => {
        const leader = this.requireNode(role).cluster.leader().toNullable();
        if (expectedAddr === null) return leader === null;
        return leader?.address.toString() === expectedAddr;
      },
      `awaitLeader(${role}, expected=${expectedLeaderRole ?? 'null'}) — current: ${this.snapshotLeader(role)}`,
      timeoutMs,
    );
  }

  /* ----------------------------- internals ---------------------------- */

  private requireNode(role: string): NodeRecord {
    const node = this.nodes.get(role);
    if (!node) throw new Error(`MultiNodeSpec: unknown role '${role}'`);
    return node;
  }

  /**
   * The shared virtual clock, or `null` when this spec runs on real time.
   *
   * @throws when asked for and absent, because a silent no-op would make every
   *   assertion that follows a race rather than a failure.
   */
  private requireVirtualClock(caller: string): ManualScheduler {
    const scheduler = this.options.scheduler;
    if (scheduler === undefined || !scheduler.isVirtual) {
      throw new Error(
        `MultiNodeSpec.${caller}: this spec has no virtual clock to advance. `
        + 'Build it with `MultiNodeSpecOptions.create().withScheduler(new ManualScheduler())`.',
      );
    }
    return scheduler as ManualScheduler;
  }

  /**
   * Advance every node's clock by `ms`, then let each node's actors run.
   *
   * The multi-node twin of `TestKit.advance`, and it settles every system
   * rather than one: a gossip tick on node A produces work on node B, so
   * settling only the node whose timer fired would leave the cluster
   * half-way through the round the advance started.
   */
  async advance(ms: number): Promise<void> {
    this.requireVirtualClock('advance').advance(ms);
    for (const node of this.nodes.values()) await node.system._settle();
  }

  /**
   * Advance in `stepMs` slices until `cond()` holds, or until `budgetMs` of
   * **virtual** time has passed.
   *
   * The replacement for polling a real-time deadline, which cannot work on a
   * virtual clock at all: nothing advances while the poller sleeps, so the
   * condition can never become true and the wait can only ever time out.
   *
   * `stepMs` defaults to the gossip interval — the cadence at which anything in
   * a cluster actually changes, so a smaller slice costs settles that observe
   * nothing and a larger one can step over a window entirely.
   */
  async advanceUntil(
    cond: () => boolean,
    options: { readonly budgetMs?: number; readonly stepMs?: number; readonly description?: string } = {},
  ): Promise<void> {
    const budgetMs = options.budgetMs ?? this.options.awaitTimeoutMs;
    const stepMs = options.stepMs ?? this.options.gossipIntervalMs;
    const scheduler = this.requireVirtualClock('advanceUntil');
    const deadline = scheduler.now() + budgetMs;

    // Probed before the first advance, so a condition that already holds costs
    // no virtual time — the same rule `awaitQuiescence` follows for real time.
    for (const node of this.nodes.values()) await node.system._settle();
    if (cond()) return;

    while (scheduler.now() < deadline) {
      await this.advance(stepMs);
      if (cond()) return;
    }
    throw new Error(
      `MultiNodeSpec.advanceUntil: ${options.description ?? 'condition'} did not hold within `
      + `${budgetMs} ms of virtual time (${stepMs} ms steps)${this.reproductionHint()}`,
    );
  }

  private async awaitCondition(
    cond: () => boolean, description: string, timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      `MultiNodeSpec: timeout after ${timeoutMs} ms — ${description}${this.reproductionHint()}`,
    );
  }

  /**
   * What to say after a timeout on a network that was deliberately broken.
   *
   * Empty on a clean spec, because a hint about a seed nothing used would send
   * the reader looking for a fault that is not there.  When faults *are* in
   * play the seed is the whole reproduction: it is the difference between a
   * chaos test and an unreproducible red run, which is the trade #1023 accepts
   * by fixing the seed in the first place.
   */
  private reproductionHint(): string {
    const faulty = [...this.nodes.values()].filter((node) => node.faults.hasFaults);
    if (faulty.length === 0) return '';
    const seed = faulty[0]!.faults.seed;
    return `
  Faults were injected on: ${faulty.map((node) => node.role).join(', ')}.`
      + ` Reproduce with withFaultSeed(${seed}).`;
  }

  /* --------------------------- enterBarrier (#198) ---------------------------- */

  /**
   * Akka-style cross-node test synchronisation.  Each role calls
   * `await spec.enterBarrier(name, role)` at a point where every other
   * role must also have reached the same point.  Resolves only when
   * every role has called in; rejects on timeout if the deadline
   * elapses before all expected entrants arrive.
   *
   * `expectedRoles` defaults to the full role set, but you can pin a
   * subset when a barrier is only between a few of them
   * (e.g. {@link partition(a, b)} testing — `enterBarrier('partitioned',
   * 'a', { participants: ['a','b'] })`).
   *
   * Re-entering an already-completed barrier with the same name
   * works — the barrier slot is reset once everyone has arrived, so
   * subsequent rounds use the same name fresh.
   *
   * Use in tests:
   *
   *   const spec = new MultiNodeSpec({ roles: ['a','b','c'] });
   *   await spec.start();
   *   await Promise.all([
   *     (async () => {
   *       // Per-role setup work
   *       await spec.enterBarrier('configured', 'a');
   *       // Continue once b and c are also configured
   *     })(),
   *     (async () => { ... await spec.enterBarrier('configured', 'b'); })(),
   *     (async () => { ... await spec.enterBarrier('configured', 'c'); })(),
   *   ]);
   */
  async enterBarrier(
    name: string,
    role: string,
    options: { readonly participants?: ReadonlyArray<string>; readonly timeoutMs?: number } = {},
  ): Promise<void> {
    const participants = options.participants ?? this.options.roles;
    if (!participants.includes(role)) {
      throw new Error(
        `MultiNodeSpec.enterBarrier: role '${role}' is not in the participants list ` +
        `[${participants.join(', ')}]`,
      );
    }
    const timeoutMs = options.timeoutMs ?? this.options.awaitTimeoutMs;
    const expectedRoles = participants.length;
    const key = `${name}::${participants.slice().sort().join(',')}`;
    const existing = this.barriers.get(key);
    const entry: BarrierEntry = existing ?? {
      expectedRoles,
      entered: new Set<string>(),
      waiters: [],
    };
    if (!existing) this.barriers.set(key, entry);
    if (entry.expectedRoles !== expectedRoles) {
      throw new Error(
        `MultiNodeSpec.enterBarrier('${name}'): participant-set changed mid-flight ` +
        `(was ${entry.expectedRoles} roles, now ${expectedRoles})`,
      );
    }
    if (entry.entered.has(role)) {
      throw new Error(
        `MultiNodeSpec.enterBarrier: role '${role}' already entered barrier '${name}'`,
      );
    }

    entry.entered.add(role);

    // Last entrant wakes everyone up.
    if (entry.entered.size === expectedRoles) {
      this.barriers.delete(key);
      for (const waiter of entry.waiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve();
      }
      return;
    }

    // Otherwise park here until the deadline or until the last
    // entrant wakes us.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = entry.waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) entry.waiters.splice(i, 1);
        entry.entered.delete(role);
        if (entry.entered.size === 0) this.barriers.delete(key);
        reject(new Error(
          `MultiNodeSpec.enterBarrier('${name}'): role '${role}' timed out after ${timeoutMs}ms — ` +
          `entered=[${Array.from(entry.entered).join(', ')}], expected ${expectedRoles}`,
        ));
      }, timeoutMs);
      entry.waiters.push({ resolve, reject, timer });
    });
  }

  /**
   * Number of currently-tracked barriers — diagnostic / test
   * introspection hook.  Mostly there for tests that want to verify
   * a barrier slot got cleaned up after every role entered.
   */
  get pendingBarrierCount(): number { return this.barriers.size; }

  private snapshotMemberCount(role: string): string {
    try {
      const cluster = this.requireNode(role).cluster;
      const counts = cluster.getMembers().reduce<Record<string, number>>((acc, m) => {
        acc[m.status] = (acc[m.status] ?? 0) + 1;
        return acc;
      }, {});
      return JSON.stringify(counts);
    } catch (e) { return `(snapshot failed: ${(e as Error).message})`; }
  }

  private snapshotMembers(role: string): string {
    try {
      const cluster = this.requireNode(role).cluster;
      return cluster.getMembers()
        .map((m) => `${m.address.systemName}=${m.status}`)
        .join(', ') || '(empty)';
    } catch (e) { return `(snapshot failed: ${(e as Error).message})`; }
  }

  private snapshotLeader(role: string): string {
    try {
      return this.requireNode(role).cluster.leader().toNullable()?.address.systemName ?? 'null';
    } catch (e) { return `(snapshot failed: ${(e as Error).message})`; }
  }
}
