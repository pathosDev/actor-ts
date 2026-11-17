/**
 * The coordinator's lease cycle on the paths no backend in the tree produces
 * on demand: an `acquire()` that rejects, an acquire held open while frames
 * arrive, and a leadership that moves away and back.
 *
 * `ShardingLease.test.ts` drives the happy paths with an `InMemoryLease`, which
 * answers contention with `false` and never throws, and it starts every case
 * on a node that already leads.  So a rejected acquire, the buffer a pending
 * acquire fills, and the reconcile a later leader change runs were all left to
 * nothing (Pv triage, #1842 G1, G4, G7, G18).
 *
 * A real single-node cluster with one sharded type, the lease scripted by the
 * test, and the coordinator's acquire-retry timer captured, so the retry fires
 * at the moment a case means instead of after a sleep.  A leader change is the
 * cluster's own `LeaderChanged` event, published while `isLeader` answers what
 * the case needs: the coordinator reads both and nothing else.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { none } from '../../../../src/util/Option.js';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { LeaderChanged } from '../../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import type { GetShardHome } from '../../../../src/cluster/sharding/ShardingProtocol.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { NoopLogger } from '../../../../src/Logger.js';
import { CapturingScheduler } from '../../../util/CapturingScheduler.js';
import { ScriptedLease } from '../../../util/ScriptedLease.js';
import { coordinatorSegments } from '../../../util/SystemPaths.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type WorkCommand = { readonly id: string; readonly kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;

/** Delays nothing else in the system uses, so only the coordinator's own timers are captured. */
const ACQUIRE_RETRY_INTERVAL_MS = 6_671;
const REBALANCE_INTERVAL_MS = 6_672;

const delivered: string[] = [];

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, (work) => this.onWork(work))
      .exhaustive();
  }

  private onWork(work: WorkCommand): void { delivered.push(work.id); }
}

type CoordinatorInternals = {
  readonly pending: Map<number, GetShardHome[]>;
};

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly scheduler: CapturingScheduler;
  readonly lease: ScriptedLease;
  readonly region: ActorRef<Command>;
  readonly coordinator: () => CoordinatorInternals;
  /** Every sharding frame kind the coordinator has received, in order, before any gate. */
  readonly received: string[];
  /** Move this node's leadership: the coordinator hears `LeaderChanged` with `isLeader` answering `leads`. */
  readonly setLeading: (leads: boolean) => void;
};

let running: Harness | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* best-effort */ });
    await running.system.terminate().catch(() => { /* best-effort */ });
    running = null;
  }
  delivered.length = 0;
});

async function startCoordinator(systemName: string, port: number, role?: string): Promise<Harness> {
  const scheduler = new CapturingScheduler();
  scheduler.capture(ACQUIRE_RETRY_INTERVAL_MS);
  scheduler.capture(REBALANCE_INTERVAL_MS);
  const system = ActorSystem.create(
    systemName,
    ActorSystemOptions.create().withLogger(new NoopLogger()).withScheduler(scheduler),
  );
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  await awaitCondition(() => cluster.isLeader(), { timeoutMs: 4_000, label: 'the single node leads' });

  const lease = new ScriptedLease();
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    .withRebalanceIntervalMs(REBALANCE_INTERVAL_MS)
    .withLease(lease)
    .withAcquireRetryIntervalMs(ACQUIRE_RETRY_INTERVAL_MS)
    .withPassivationIdleMs(0);
  if (role !== undefined) shardingOptions.withRole(role);
  const region = cluster.sharding.start<Command>(shardingOptions);

  const coordinatorInstance = (): Record<string, unknown> => {
    const resolved = system._resolvePath(coordinatorSegments(systemName, TYPE_NAME));
    if (resolved.isNone()) throw new Error('coordinator actor not found');
    const cell = (resolved.value as unknown as { getCell?: () => { actor?: unknown } }).getCell?.();
    return cell?.actor as Record<string, unknown>;
  };
  await awaitCondition(() => {
    try { return coordinatorInstance() !== undefined; } catch { return false; }
  }, { timeoutMs: 4_000, label: 'the coordinator started' });

  // Every frame, recorded before the leader / authority / lease gates.
  const received: string[] = [];
  const instance = coordinatorInstance() as Record<string, (...parameters: unknown[]) => unknown>;
  const receive = instance['receiveShardingMessage']!;
  instance['receiveShardingMessage'] = function (this: unknown, ...parameters: unknown[]): unknown {
    received.push((parameters[0] as { kind: string }).kind);
    return receive.apply(this, parameters);
  };

  const leaderCheck = cluster.isLeader.bind(cluster);
  let leading: boolean | null = null;
  cluster.isLeader = () => leading ?? leaderCheck();
  const harness: Harness = {
    system,
    cluster,
    scheduler,
    lease,
    region,
    coordinator: () => coordinatorInstance() as unknown as CoordinatorInternals,
    received,
    setLeading: (leads) => {
      leading = leads;
      cluster._publishClusterEvent(new LeaderChanged(leads ? cluster.leader() : none));
    },
  };
  running = harness;
  return harness;
}

describe('the coordinator\'s lease cycle (#1842)', () => {
  test('an acquire that rejects leaves the coordinator passive, and it retries after the interval', async () => {
    const harness = await startCoordinator('1842-lease-rejects', 44_640);
    await awaitCondition(() => harness.lease.pendingAcquires === 1, {
      timeoutMs: 4_000,
      label: 'the leader asked for the lease',
    });
    harness.region.tell({ id: 'user-1', kind: 'work' });
    await awaitCondition(() => harness.received.includes('sharding.GetShardHome'), {
      timeoutMs: 4_000,
      label: 'the region asked for the shard home while the acquire was pending',
    });

    harness.lease.fail();
    await awaitCondition(() => harness.scheduler.capturedAt(ACQUIRE_RETRY_INTERVAL_MS) === 1, {
      timeoutMs: 4_000,
      label: 'the rejected acquire armed the retry',
    });
    // Nothing served on a lease nobody holds, and no second attempt before the interval.
    expect(harness.lease.checkAlive()).toBe(false);
    expect(harness.lease.acquireCalls).toBe(1);
    expect(delivered).toEqual([]);

    harness.scheduler.fire(ACQUIRE_RETRY_INTERVAL_MS);
    await awaitCondition(() => harness.lease.pendingAcquires === 1, {
      timeoutMs: 4_000,
      label: 'the retry asked for the lease again',
    });
    expect(harness.lease.acquireCalls).toBe(2);
    expect(delivered).toEqual([]);

    harness.lease.grant();
    await awaitCondition(() => delivered.length === 1, {
      timeoutMs: 4_000,
      label: 'the message reached its entity once the lease was held',
    });
    expect(delivered).toEqual(['user-1']);
  }, 20_000);

  test('a frame that arrives while the acquire is pending is served once the lease is held', async () => {
    const harness = await startCoordinator('1842-lease-buffer', 44_642);
    await awaitCondition(() => harness.lease.pendingAcquires === 1, {
      timeoutMs: 4_000,
      label: 'the leader asked for the lease',
    });
    harness.region.tell({ id: 'user-2', kind: 'work' });
    await awaitCondition(() => harness.received.includes('sharding.GetShardHome'), {
      timeoutMs: 4_000,
      label: 'the region asked for the shard home while the acquire was pending',
    });
    const asked = harness.received.filter((kind) => kind === 'sharding.GetShardHome').length;

    harness.lease.grant();
    await awaitCondition(() => delivered.length === 1, {
      timeoutMs: 4_000,
      label: 'the buffered request was answered once the lease was held',
    });
    // Answered from the buffer: the region did not have to ask again.
    expect(harness.received.filter((kind) => kind === 'sharding.GetShardHome').length).toBe(asked);
    expect(delivered).toEqual(['user-2']);
  }, 20_000);

  test('losing the leadership releases the lease, and leading again acquires it and serves', async () => {
    const harness = await startCoordinator('1842-lease-leader', 44_644);
    await awaitCondition(() => harness.lease.pendingAcquires === 1, {
      timeoutMs: 4_000,
      label: 'the leader asked for the lease',
    });
    harness.lease.grant();
    harness.region.tell({ id: 'user-3', kind: 'work' });
    await awaitCondition(() => delivered.length === 1, { timeoutMs: 4_000, label: 'the first leader served' });

    harness.setLeading(false);
    await awaitCondition(() => harness.lease.releases === 1, {
      timeoutMs: 4_000,
      label: 'the coordinator that stopped leading released the lease',
    });
    expect(harness.lease.checkAlive()).toBe(false);
    expect(harness.lease.acquireCalls).toBe(1);

    harness.setLeading(true);
    await awaitCondition(() => harness.lease.pendingAcquires === 1, {
      timeoutMs: 4_000,
      label: 'the coordinator that leads again asked for the lease',
    });
    expect(harness.lease.acquireCalls).toBe(2);
    harness.lease.grant();
    harness.region.tell({ id: 'user-4', kind: 'work' });
    await awaitCondition(() => delivered.includes('user-4'), {
      timeoutMs: 4_000,
      label: 'the new term served once the lease was held again',
    });
  }, 20_000);

  test('the GetShardHome requests waiting when the lease is lost are dropped, not answered by the next term', async () => {
    // A role no member carries: the local region registers as nothing the
    // coordinator may place a shard on, so its request waits.
    const harness = await startCoordinator('1842-lease-lost-pending', 44_646, 'nobody-has-this-role');
    await awaitCondition(() => harness.lease.pendingAcquires === 1, {
      timeoutMs: 4_000,
      label: 'the leader asked for the lease',
    });
    harness.lease.grant();
    harness.region.tell({ id: 'user-5', kind: 'work' });
    await awaitCondition(() => harness.coordinator().pending.size === 1, {
      timeoutMs: 4_000,
      label: 'the region\'s request is waiting on an unplaceable shard',
    });

    harness.lease.lose();
    await awaitCondition(() => harness.lease.pendingAcquires === 1, {
      timeoutMs: 4_000,
      label: 'the coordinator stepped down and asked for the lease again',
    });
    expect(harness.coordinator().pending.size).toBe(0);
  }, 20_000);

  test('the GetShardHome requests waiting when the leadership is lost are dropped, not answered by the next term', async () => {
    const harness = await startCoordinator('1842-leader-lost-pending', 44_648, 'nobody-has-this-role');
    await awaitCondition(() => harness.lease.pendingAcquires === 1, {
      timeoutMs: 4_000,
      label: 'the leader asked for the lease',
    });
    harness.lease.grant();
    harness.region.tell({ id: 'user-6', kind: 'work' });
    await awaitCondition(() => harness.coordinator().pending.size === 1, {
      timeoutMs: 4_000,
      label: 'the region\'s request is waiting on an unplaceable shard',
    });

    harness.setLeading(false);
    // The release runs on the reconcile the leader change queues behind itself.
    await awaitCondition(() => harness.lease.releases === 1, {
      timeoutMs: 4_000,
      label: 'the coordinator handled the leader change',
    });
    expect(harness.coordinator().pending.size).toBe(0);

    harness.setLeading(true);
    await awaitCondition(() => harness.lease.pendingAcquires === 1, {
      timeoutMs: 4_000,
      label: 'the next term asked for the lease',
    });
    expect(harness.coordinator().pending.size).toBe(0);
  }, 20_000);
});
