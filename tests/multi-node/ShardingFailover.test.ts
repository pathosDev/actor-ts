/**
 * Multi-node failure-injection tests for ClusterSharding.
 *
 * These exercise the unhappy paths that the green-path
 * `sharding-rebalance.test.ts` deliberately sidesteps:
 *
 *   1. Coordinator crash (leader dies → next leader rebuilds state).
 *   2. Owner crash mid-traffic — coordinator's onMemberRemoved fires;
 *      survivors take over the orphaned shards within the
 *      failure-detection window, queued messages eventually resolve.
 *   3. Network partition: shards on the partitioned-away node move
 *      to the surviving side; on heal, the rejoining node re-registers
 *      and the cluster converges.
 *   4. Buffered GetShardHome queries during re-allocation — a burst of asks
 *      spans a *graceful* leave, so shards move under live traffic.
 *   5. ShardedDaemonProcess: crash one node, the daemons it hosted
 *      reappear elsewhere within the rebalance window.
 *   6. A node cut off under the default downing configuration, which parks
 *      it at `unreachable` for good: fresh shards are homed on the
 *      survivors only.
 *
 * The crash and partition cases (1, 2, 3, 5) run with
 * `failureDetectorAutoDown: true`.  With no downing strategy the detector
 * only parks a silent node at `unreachable` (#1426), and nothing then removes
 * it; those tests are about what sharding does once a node is removed, not
 * about who decides the removal.  Case 6 is about the parked node itself, so
 * it runs the default and the node is never removed.
 *
 * These are intentionally noisy on purpose — each one stresses a
 * different recovery path so that any regression in
 * ShardCoordinator/ShardRegion shows up here before it ships.
 */
import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import type { NodeAddress } from '../../src/cluster/NodeAddress.js';
import { ClusterSharding } from '../../src/cluster/sharding/ClusterSharding.js';
import { hashShardId } from '../../src/cluster/sharding/ShardAllocator.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import { ShardedDaemonProcess } from '../../src/cluster/sharding/ShardedDaemonProcess.js';
import { ShardedDaemonProcessOptions } from '../../src/cluster/sharding/ShardedDaemonProcessOptions.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import { awaitCondition, sleep } from '../util/AwaitCondition.js';
import { coordinatorSegments } from '../util/SystemPaths.js';
import type { ActorRef } from '../../src/ActorRef.js';

type PingCommand = { id: string; kind: 'ping'; payload?: string };
type EchoCommand = { id: string; kind: 'echo'; payload?: string };

type Command = PingCommand | EchoCommand;

class Entity extends Actor<Command> {
  override onReceive(m: Command): void {
    match(m)
      .with({ kind: 'ping' }, () => this.onPing())
      .with({ kind: 'echo' }, (c) => this.onEcho(c))
      .exhaustive();
  }

  private onPing(): void {
    this.sender.forEach((s) => s.tell('pong'));
  }

  private onEcho(command: EchoCommand): void {
    this.sender.forEach((s) => s.tell(command.payload ?? ''));
  }
}

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

/**
 * Whether `region` still caches a shard home on `node`.
 *
 * A region routes from a cached shard→node map and only drops the entries for
 * a node once it has processed that node's `MemberRemoved`.  Until then a
 * message for such a shard is sent at a node that is gone and sits in the
 * region's buffer.  `awaitMembers` returns strictly earlier than that — it
 * watches the cluster view, not the region — so this is the condition a
 * post-failover ask actually depends on.
 *
 * Test-only reach into a private map, for want of a public surface.  It is
 * still the better probe: `ClusterSharding.shards()` blocks the region's
 * mailbox for the length of its fan-out fuse, so polling *that* starves the
 * very asks these tests are about.
 */
function cachesShardHomeOn(region: ActorRef<Command>, node: string): boolean {
  const internal = region as unknown as {
    getCell?: () => { actor?: { shardHomeNodes: Map<number, { toString(): string }> } };
  };
  const homes = internal.getCell?.().actor?.shardHomeNodes;
  if (!homes) return true;                    // not materialised yet — not ready
  return [...homes.values()].some((address) => address.toString() === node);
}

/**
 * How many regions the local ShardCoordinator has on record, or `-1` when this
 * node hosts no coordinator actor.  Same test-only hop as
 * `sharding-coordinator-recovery.test.ts`: "the coordinator has seen the node
 * leave" decides which candidates it may allocate to, and has no public
 * surface.
 */
function registeredRegionCount(spec: MultiNodeSpec, role: string, typeName: string): number {
  const system = spec.systemFor(role);
  const refOption = system._resolvePath(coordinatorSegments(system.name, typeName));
  if (refOption.isNone()) return -1;
  const internal = refOption.value as unknown as {
    getCell?: () => { actor?: { regions: Map<string, unknown> } };
  };
  return internal.getCell?.().actor?.regions.size ?? -1;
}

/** The status `observer`'s view holds for the member at `address`, or `absent` once it is gone. */
function statusOn(spec: MultiNodeSpec, observer: string, address: NodeAddress): string {
  return spec.clusterFor(observer).getMembers()
    .find((member) => member.address.equals(address))?.status ?? 'absent';
}

/**
 * The node each shard is homed on in `role`'s ShardCoordinator, by shard id —
 * the allocation map itself, reached through the same test-only hop as
 * {@link registeredRegionCount}.  Empty when this node hosts no coordinator.
 */
function shardHomeNodes(spec: MultiNodeSpec, role: string, typeName: string): Map<number, string> {
  const system = spec.systemFor(role);
  const refOption = system._resolvePath(coordinatorSegments(system.name, typeName));
  const homes = new Map<number, string>();
  if (refOption.isNone()) return homes;
  const internal = refOption.value as unknown as {
    getCell?: () => {
      actor?: {
        shardHome: Map<number, string>;
        regions: Map<string, { node: { toString(): string } }>;
      };
    };
  };
  const coordinator = internal.getCell?.().actor;
  if (!coordinator) return homes;
  for (const [shardId, key] of coordinator.shardHome) {
    const node = coordinator.regions.get(key)?.node.toString();
    if (node !== undefined) homes.set(shardId, node);
  }
  return homes;
}

function startRegion(
  spec: MultiNodeSpec, role: string,
): ActorRef<Command> {
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName('entity')
    .withEntityActor(Entity)
    .withExtractEntityId((m) => m.id)
    .withNumShards(16)
    .withRebalanceIntervalMs(200)
    .withHandOffTimeoutMs(1_000);
  return spec.clusterFor(role).sharding.start<Command>(shardingOptions);
}

describe('multi-node sharding failover', () => {
  test('1. leader (coordinator) crashes — survivors elect a new leader and keep serving', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      failureDetectorAutoDown: true,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      const regions: Record<'a' | 'b' | 'c', ActorRef<Command>> = {
        a: startRegion(spec, 'a'),
        b: startRegion(spec, 'b'),
        c: startRegion(spec, 'c'),
      };

      // Warm up: ensure every shard has a home before crashing the leader.
      // Nothing is asserted on the wait itself — the asks that follow carry
      // their own 3 s budget — so a fixed sleep is honest here.
      await sleep(300);
      for (let i = 0; i < 16; i++) {
        const result = await regions.b.ask<string>({ id: `pre-${i}`, kind: 'ping' }, 3_000);
        expect(result).toBe('pong');
      }

      // 'a' is the leader by lowest-port convention (30_000 < 30_001 < 30_002).
      // Verify that's actually true, then crash.
      const leaderRole = spec.clusterFor('a').leader().toNullable()!.address.systemName;
      expect(leaderRole).toBe('a');
      const crashedAddress = spec.addressFor('a').toString();
      await spec.crash('a');

      await Promise.all([
        spec.awaitMembers('b', 2, 5_000),
        spec.awaitMembers('c', 2, 5_000),
      ]);
      // Wait for the querying region to have dropped the homes it cached on
      // the dead leader — the state the round below actually needs, and the
      // one the 500 ms sleep was standing in for.  Measured at ~230 ms on an
      // idle box, so the old budget was both a guess and mostly waste; when
      // it fell short the first `post-` ask timed out at 5 s while the other
      // fifteen answered in under a millisecond, which reads as a
      // re-allocation bug rather than as a test that resumed too early.
      await awaitCondition(
        () => !cachesShardHomeOn(regions.b, crashedAddress),
        {
          timeoutMs: 15_000,
          intervalMs: 10,
          label: 'the querying region dropped every shard home on the crashed leader',
        },
      );

      // Asks on the survivors must continue to succeed.  Some shards
      // may have been homed on the dead leader and need re-allocation —
      // that's the point of the test.
      for (let i = 0; i < 16; i++) {
        const result = await regions.b.ask<string>({ id: `post-${i}`, kind: 'ping' }, 5_000);
        expect(result).toBe('pong');
      }
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);

  test('2. mid-flight asks during a non-leader crash all eventually resolve', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      failureDetectorAutoDown: true,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      const regions = {
        a: startRegion(spec, 'a'),
        b: startRegion(spec, 'b'),
        c: startRegion(spec, 'c'),
      };

      // Warm up the initial shard allocation.  Nothing is asserted on the wait
      // itself — the asks below carry their own 8 s budget — so a still-running
      // allocation is absorbed rather than misread, and a fixed sleep is honest.
      await sleep(300);

      // Start a batch of 32 asks against region 'a', then crash 'c' during
      // the batch.  Expectation: every ask eventually returns 'pong'.
      const inflight = Array.from({ length: 32 }, (_, i) =>
        regions.a.ask<string>({ id: `mid-${i}`, kind: 'ping' }, 8_000),
      );

      // Crash 'c' shortly after issuing — some asks land on shards that
      // were homed on c, and must be re-routed by the survivors.  The delay
      // is the scenario, not a stand-in for one: it puts the crash inside the
      // batch's flight window rather than before or after it.
      await sleep(20);
      await spec.crash('c');

      const replies = await Promise.all(inflight);
      expect(replies.every((result) => result === 'pong')).toBe(true);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);

  test('3. partitioned region — shards move; on heal, the cluster reconverges', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      failureDetectorAutoDown: true,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      const regions = {
        a: startRegion(spec, 'a'),
        b: startRegion(spec, 'b'),
        c: startRegion(spec, 'c'),
      };

      // Warm up the initial shard allocation before cutting the partition, so
      // the rebalance under test starts from an allocated state.  Nothing is
      // asserted on the wait; the 2-member view below is the real signal.
      await sleep(300);

      // Cut 'c' from both 'a' and 'b' — c becomes unreachable, then with
      // tight FD options (downAfterMs = 400) the cluster declares c
      // down + removed within ~half a second.
      spec.partition('a', 'c');
      spec.partition('b', 'c');

      // The shards are allocated *after* the partition — nothing was asked
      // before it — and asked for as soon as neither survivor sees c as up,
      // whether it is still unreachable or already removed.  There is no need
      // to wait for the coordinator to drop c's registration first: a region
      // whose node is not up is never handed a shard, so none of these can be
      // homed on the node just cut off (#1467).
      const cutOff = spec.addressFor('c');
      await awaitCondition(
        () => statusOn(spec, 'a', cutOff) !== 'up' && statusOn(spec, 'b', cutOff) !== 'up',
        {
          timeoutMs: 5_000,
          intervalMs: 10,
          label: 'neither survivor sees the partitioned node as up',
        },
      );

      // Survivors continue to serve.
      for (let i = 0; i < 8; i++) {
        const result = await regions.a.ask<string>({ id: `part-${i}`, kind: 'ping' }, 5_000);
        expect(result).toBe('pong');
      }

      // Heal — once 'c' has been declared down + removed by the survivors,
      // heal() alone won't bring it back into the cluster (re-joining a
      // downed node is a separate concern, see Cluster.leave).  The removal
      // is waited for here, after the asks, because the assertion below is
      // about a removed node — and as the member leaving both views, since
      // `awaitMembers` counts `up` members and is satisfied by an unreachable
      // one already.  We still call heal to verify the harness doesn't throw,
      // and that the survivors stay healthy.
      await awaitCondition(
        () => statusOn(spec, 'a', cutOff) === 'absent' && statusOn(spec, 'b', cutOff) === 'absent',
        {
          timeoutMs: 5_000,
          intervalMs: 10,
          label: 'both survivors removed the partitioned node',
        },
      );
      spec.heal('a', 'c');
      spec.heal('b', 'c');
      // A fixed sleep is the right tool here: the assertion is that healing
      // does *not* bring the downed node back, and there is no state
      // transition to wait for — only a window in which one must not happen.
      await sleep(200);
      expect(spec.clusterFor('a').upMembers().length).toBe(2);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);

  test('4. burst of asks during repeated coordinator state churn', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      const regions = {
        a: startRegion(spec, 'a'),
        b: startRegion(spec, 'b'),
        c: startRegion(spec, 'c'),
      };

      // Warm up the initial shard allocation.  Nothing is asserted on the wait
      // itself — every ask below carries its own 4 s budget.
      await sleep(300);

      // A burst of asks while the cluster topology shifts.  Bounded by a
      // *count*, not by a wall-clock window: how many asks a window fits is a
      // property of the scheduler, not of sharding.  This loop used to run for
      // 1.5 s and assert on the resulting sample count, but `Bun.sleep(5)`
      // costs a full ~15.6 ms timer quantum on Windows (#477) while the ask
      // itself is sub-millisecond — so the count was ~100 % timer granularity,
      // and one stalled event loop turned it into a red build (#902).
      const totalAsks = 60;
      let issued = 0;
      let replies = 0;
      let failures = 0;
      const driver = (async (): Promise<void> => {
        for (let i = 0; i < totalAsks; i++) {
          try {
            await regions.a.ask<string>({ id: `churn-${i % 16}`, kind: 'ping' }, 4_000);
            replies++;
          } catch { failures++; }
          issued++;
          // Pacing, not a wait on an outcome: it spreads the 60 asks over the
          // churn window instead of firing them in one event-loop burst.  The
          // loop is bounded by `totalAsks`, so the delay's length is not load
          // bearing (#477 makes the real quantum ~15.6 ms on Windows anyway).
          await sleep(5);
        }
      })();

      // Topology churn while asks are in flight — keyed to the driver's
      // progress, not to a sleep.  A fixed 200 ms landed the leave after ~13
      // asks on an idle machine but after the first one on a stalled machine,
      // which is what made the interleaving machine-dependent; gating on
      // "8 asks issued" puts the leave mid-burst everywhere.
      await awaitCondition(() => issued >= 8, {
        timeoutMs: 5_000,
        label: 'burst driver issued 8 asks before the graceful leave',
      });
      await spec.leave('c');                                 // graceful
      await spec.awaitMembers('a', 2, 4_000);
      await driver;

      // The property is "survives churn without deadlocking".  Tolerating a
      // failed ask is headroom, not an observed race: a probe that fires the
      // leave at t=0, squarely onto the first in-flight ask, still saw 0
      // failures across ~1 400 asks (#902).  Kept because a loaded machine can
      // stall an ask past its own timeout, which is not what this test is for.
      expect(replies).toBeGreaterThan(0);
      // Exact, not a throughput guess: the burst is a fixed size, so this says
      // the driver ran to completion instead of exiting early.
      expect(replies + failures).toBe(totalAsks);
      // …and after the churn settles, asks succeed again.  The ask carries a
      // 5 s budget of its own, so this settle only shortens it.
      await sleep(300);
      const finalReply = await regions.a.ask<string>({ id: `final`, kind: 'ping' }, 5_000);
      expect(finalReply).toBe('pong');
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);

  test('5. ShardedDaemonProcess — crash one node, daemons respawn elsewhere', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      failureDetectorAutoDown: true,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      // Track every preStart by daemon index — so we can see
      // "daemon 4 was hosted on B, then re-spawned somewhere else after
      // crash".
      const startsByIndex = new Map<number, string[]>();
      const recordStart = (index: number, where: string): void => {
        const list = startsByIndex.get(index) ?? [];
        list.push(where);
        startsByIndex.set(index, list);
      };

      class Daemon extends Actor<{ kind: 'noop' }> {
        constructor(private readonly index: number, private readonly where: string) { super(); }
        override preStart(): void { recordStart(this.index, this.where); }
        override onReceive(): void { /* daemons just need to exist */ }
      }

      // 6 daemons across 3 nodes — at least 2 per node by LeastShard.
      for (const role of ['a', 'b', 'c'] as const) {
        const daemonOptions = ShardedDaemonProcessOptions.create<{ kind: 'noop' }>()
          .withName('workers')
          .withNumDaemons(6)
          .withActorFor((i) => () => new Daemon(i, role));
        ShardedDaemonProcess.init(
          spec.systemFor(role), spec.clusterFor(role),
          daemonOptions,
        );
      }

      const latestHostOf = (index: number): string | undefined => {
        const list = startsByIndex.get(index);
        return list?.[list.length - 1];
      };
      const hostsInUse = (): Set<string> => {
        const hosts = new Set<string>();
        for (const index of startsByIndex.keys()) {
          const where = latestHostOf(index);
          if (where !== undefined) hosts.add(where);
        }
        return hosts;
      };

      // Wait for all 6 to fire preStart AND for the rebalancer to have spread
      // them over all three nodes.
      //
      // "At least 2 per node by LeastShard" is an eventual guarantee, not a
      // property of the first allocation: the coordinator allocates against
      // whichever regions have registered when it handles the request, and
      // since #409 it handles a batch of requests per turn rather than one.
      // On a cold start that legitimately puts all 6 on the node that
      // registered first, and `rebalance-interval` then moves them out.  This
      // case needs 'c' to actually host something before it crashes 'c', so it
      // has to wait for the converged distribution rather than assume it.
      await awaitCondition(
        () => startsByIndex.size === 6 && hostsInUse().size === 3,
        {
          timeoutMs: 20_000,
          intervalMs: 25,
          label: 'all six daemons started and spread over all three nodes',
        },
      );
      expect(startsByIndex.size).toBe(6);

      // Snapshot which indices are hosted where, then crash 'c'.
      const initialHosts = new Map<number, string>();
      for (const [index, list] of startsByIndex) initialHosts.set(index, list[list.length - 1]!);
      const onC = Array.from(initialHosts.entries())
        .filter(([_, where]) => where === 'c').map(([index]) => index);
      expect(onC.length).toBeGreaterThan(0);  // c had at least one daemon

      await spec.crash('c');
      await Promise.all([
        spec.awaitMembers('a', 2, 5_000),
        spec.awaitMembers('b', 2, 5_000),
      ]);

      // The daemons that lived on 'c' must reappear on a survivor.
      // The budget covers the rebalance + handoff window; a healthy run
      // returns as soon as the last one respawns.
      const respawnedOnSurvivor = (index: number): boolean => {
        const hosts = startsByIndex.get(index) ?? [];
        // hosts[0] was the original; we want a later entry on a or b.
        return hosts.slice(1).some((h) => h === 'a' || h === 'b');
      };
      await awaitCondition(
        () => onC.every((index) => respawnedOnSurvivor(index)),
        {
          timeoutMs: 8_000,
          intervalMs: 50,
          label: 'every daemon hosted on the crashed node respawned on a survivor',
        },
      );

      for (const index of onC) {
        expect(respawnedOnSurvivor(index)).toBe(true);
      }
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);

  test('6. a node cut off and parked at unreachable is homed no fresh shard', async () => {
    // The default configuration: no downing strategy and failure-detector
    // auto-down off, so a node that stops answering is parked at `unreachable`
    // and nothing removes it (#1426).  Its region stays registered for as long
    // as that lasts — and the coordinator used to keep it a placement candidate
    // all that time, so about a third of the shards asked for afterwards were
    // homed on a node that could not answer, and their asks timed out (#1467).
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      const regions = {
        a: startRegion(spec, 'a'),
        b: startRegion(spec, 'b'),
        c: startRegion(spec, 'c'),
      };
      // c's region has to be one the coordinator holds before the cut, or the
      // case would be about a node that never registered.
      await awaitCondition(() => registeredRegionCount(spec, 'a', 'entity') === 3, {
        timeoutMs: 5_000,
        intervalMs: 10,
        label: 'all three regions registered with the coordinator',
      });

      const cutOff = spec.addressFor('c');
      spec.partition('a', 'c');
      spec.partition('b', 'c');
      await awaitCondition(
        () => statusOn(spec, 'a', cutOff) === 'unreachable' && statusOn(spec, 'b', cutOff) === 'unreachable',
        {
          timeoutMs: 5_000,
          intervalMs: 10,
          label: 'both survivors see the partitioned node as unreachable',
        },
      );

      // Twelve entities nobody has asked for yet, at once, through a's region.
      // Under the default strategy over all three nodes a shard goes to the
      // (id mod 3)-th in address order, and c sorts last — so at least one of
      // these must hash onto c's slot, or the case could pass by never asking
      // for a shard the old candidate set would have homed there.
      const ids = Array.from({ length: 12 }, (_, i) => `parked-${i}`);
      expect(ids.some((id) => hashShardId(id, 16) % 3 === 2)).toBe(true);
      const replies = await Promise.allSettled(
        ids.map((id) => regions.a.ask<string>({ id, kind: 'ping' }, 4_000)),
      );

      const unanswered = ids.filter((_, index) => replies[index]!.status !== 'fulfilled');
      expect(unanswered).toEqual([]);
      const homes = shardHomeNodes(spec, 'a', 'entity');
      const homedOnCutOff = ids
        .map((id) => hashShardId(id, 16))
        .filter((shardId) => homes.get(shardId) === cutOff.toString());
      expect(homedOnCutOff).toEqual([]);
      // Still parked at the end: the case is the undecided node, not a removal.
      expect(statusOn(spec, 'a', cutOff)).toBe('unreachable');

      spec.heal('a', 'c');
      spec.heal('b', 'c');
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);
});
