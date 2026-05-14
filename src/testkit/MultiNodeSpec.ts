import { ActorSystem } from '../ActorSystem.js';
import { Cluster, type ClusterSettings } from '../cluster/Cluster.js';
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
export interface MultiNodeSpecSettings {
  /** Role names — also act as system names; must be unique within the spec. */
  readonly roles: ReadonlyArray<string>;
  /**
   * Roles that act as bootstrap seeds.  Defaults to `[roles[0]]` — the
   * first role is the lone seed.  All other roles try to join via the
   * seed list.
   */
  readonly seedRoles?: ReadonlyArray<string>;
  /**
   * Per-role address overrides.  Useful if a test wants pinned
   * host:port pairs (e.g. for log readability).  If omitted, addresses
   * are auto-allocated as `127.0.0.1:<base + index>` with a fresh base
   * per spec.
   */
  readonly addresses?: Readonly<Record<string, { host: string; port: number }>>;
  /**
   * Failure-detector overrides.  Multi-node tests typically want the
   * detector tightened so dead nodes are noticed within seconds rather
   * than the production default.  See `Cluster.ts` for the field set.
   */
  readonly failureDetector?: ClusterSettings['failureDetector'];
  /** Gossip interval, default 100 ms (vs production 1 s). */
  readonly gossipIntervalMs?: number;
  /** How long synchronous `await*` helpers wait before throwing.  Default 10 s. */
  readonly awaitTimeoutMs?: number;
  /** Logger — defaults to NoopLogger so tests stay quiet. */
  readonly logLevel?: LogLevel;
  /**
   * Per-role split-brain resolver factory.  Called once per role at
   * `start()` time; the returned provider is wired into that role's
   * cluster via `ClusterSettings.downing`.  Each role typically gets
   * its OWN provider instance (some strategies are stateful — e.g.
   * `LeaseMajority` holds a per-replica acquire result).  Pass
   * `undefined` for a role that should run without downing.
   */
  readonly downing?: (role: string) => DowningProvider | undefined;
}

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

export class MultiNodeSpec {
  private readonly settings: Required<Omit<MultiNodeSpecSettings, 'addresses' | 'failureDetector' | 'downing'>>
    & Pick<MultiNodeSpecSettings, 'addresses' | 'failureDetector' | 'downing'>;
  private readonly nodes = new Map<string, NodeRecord>();
  private started = false;

  constructor(settings: MultiNodeSpecSettings) {
    if (settings.roles.length === 0) {
      throw new Error('MultiNodeSpec: at least one role is required');
    }
    if (new Set(settings.roles).size !== settings.roles.length) {
      throw new Error('MultiNodeSpec: roles must be unique');
    }
    this.settings = {
      roles: settings.roles,
      seedRoles: settings.seedRoles ?? [settings.roles[0]!],
      gossipIntervalMs: settings.gossipIntervalMs ?? 100,
      awaitTimeoutMs: settings.awaitTimeoutMs ?? 10_000,
      logLevel: settings.logLevel ?? LogLevel.Off,
      addresses: settings.addresses,
      failureDetector: settings.failureDetector,
      downing: settings.downing,
    };
  }

  /** Bring up every role. */
  async start(): Promise<void> {
    if (this.started) throw new Error('MultiNodeSpec: already started');
    this.started = true;

    const portBase = nextPortBase;
    nextPortBase += this.settings.roles.length + 1;

    // Step 1: build the address book up front so seeds can name peers.
    const addressByRole = new Map<string, NodeAddress>();
    this.settings.roles.forEach((role, idx) => {
      const explicit = this.settings.addresses?.[role];
      const host = explicit?.host ?? '127.0.0.1';
      const port = explicit?.port ?? (portBase + idx);
      addressByRole.set(role, new NodeAddress(role, host, port));
    });

    const seeds = this.settings.seedRoles
      .map((r) => addressByRole.get(r))
      .filter((a): a is NodeAddress => a !== undefined)
      .map((a) => a.toString());

    // Step 2: spin up systems + clusters.  Seed role is started first
    // so the others can hit it with their initial join gossip.
    const orderedRoles = [
      ...this.settings.seedRoles,
      ...this.settings.roles.filter((r) => !this.settings.seedRoles.includes(r)),
    ];
    for (const role of orderedRoles) {
      const address = addressByRole.get(role)!;
      const transport = new MultiNodeTransport(address);
      const system = ActorSystem.create(role, {
        logger: new NoopLogger(),
        logLevel: this.settings.logLevel,
      });
      const cluster = await Cluster.join(system, {
        host: address.host,
        port: address.port,
        seeds,
        transport,
        gossipIntervalMs: this.settings.gossipIntervalMs,
        seedRetryIntervalMs: 100,
        failureDetector: this.settings.failureDetector,
        downing: this.settings.downing?.(role),
      });
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
    role: string, expectedCount: number, timeoutMs: number = this.settings.awaitTimeoutMs,
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
    timeoutMs: number = this.settings.awaitTimeoutMs,
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
    timeoutMs: number = this.settings.awaitTimeoutMs,
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
