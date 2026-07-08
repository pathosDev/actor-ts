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

interface NodeRecord {
  readonly role: string;
  readonly address: NodeAddress;
  readonly transport: MultiNodeTransport;
  system: ActorSystem;
  cluster: Cluster;
  /** True after the node was crashed or removed.  Idempotent guard. */
  removed: boolean;
}

let nextPortBase = 30_000;

/**
 * Per-barrier state — every distinct barrier name gets one of these.
 * Once `entered.size === expectedRoles`, every parked waiter resolves.
 */
interface BarrierEntry {
  readonly expectedRoles: number;
  readonly entered: Set<string>;
  readonly waiters: Array<{
    resolve(): void;
    reject(err: Error): void;
    timer: ReturnType<typeof setTimeout> | null;
  }>;
}

export class MultiNodeSpec {
  private readonly options: Required<Omit<MultiNodeSpecOptionsType, 'addresses' | 'failureDetector' | 'downing'>>
    & Pick<MultiNodeSpecOptionsType, 'addresses' | 'failureDetector' | 'downing'>;
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
      addresses: options.addresses,
      failureDetector: options.failureDetector,
      downing: options.downing,
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
    this.options.roles.forEach((role, idx) => {
      const explicit = this.options.addresses?.[role];
      const host = explicit?.host ?? '127.0.0.1';
      const port = explicit?.port ?? (portBase + idx);
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
      const system = ActorSystem.create(role, ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(this.options.logLevel));
      const clusterOptions = ClusterOptions.create()
        .withHost(address.host)
        .withPort(address.port)
        .withSeeds(seeds)
        .withTransport(transport)
        .withGossipIntervalMs(this.options.gossipIntervalMs)
        .withSeedRetryIntervalMs(100);
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
    await node.transport.shutdown();
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
    const a = this.requireNode(roleA);
    const b = this.requireNode(roleB);
    a.transport.partitionFromPeer(b.address);
    b.transport.partitionFromPeer(a.address);
  }

  /** Undo `partition(roleA, roleB)`. */
  heal(roleA: string, roleB: string): void {
    const a = this.requireNode(roleA);
    const b = this.requireNode(roleB);
    a.transport.unblockOutgoing(b.address);
    b.transport.unblockOutgoing(a.address);
  }

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

  private async awaitCondition(
    cond: () => boolean, description: string, timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`MultiNodeSpec: timeout after ${timeoutMs} ms — ${description}`);
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
    opts: { readonly participants?: ReadonlyArray<string>; readonly timeoutMs?: number } = {},
  ): Promise<void> {
    const participants = opts.participants ?? this.options.roles;
    if (!participants.includes(role)) {
      throw new Error(
        `MultiNodeSpec.enterBarrier: role '${role}' is not in the participants list ` +
        `[${participants.join(', ')}]`,
      );
    }
    const timeoutMs = opts.timeoutMs ?? this.options.awaitTimeoutMs;
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
      for (const w of entry.waiters) {
        if (w.timer) clearTimeout(w.timer);
        w.resolve();
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
