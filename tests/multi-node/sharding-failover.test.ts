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
 *
 * These are intentionally noisy on purpose — each one stresses a
 * different recovery path so that any regression in
 * ShardCoordinator/ShardRegion shows up here before it ships.
 */
import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { Props } from '../../src/Props.js';
import { ClusterSharding } from '../../src/cluster/sharding/ClusterSharding.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import { ShardedDaemonProcess } from '../../src/cluster/sharding/ShardedDaemonProcess.js';
import { ShardedDaemonProcessOptions } from '../../src/cluster/sharding/ShardedDaemonProcessOptions.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import { awaitCondition } from '../util/AwaitCondition.js';
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

function startRegion(
  spec: MultiNodeSpec, role: string,
): ActorRef<Command> {
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName('entity')
    .withEntityProps(Props.create(() => new Entity()))
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
      await Bun.sleep(300);
      for (let i = 0; i < 16; i++) {
        const result = await regions.b.ask<string>({ id: `pre-${i}`, kind: 'ping' }, 3_000);
        expect(result).toBe('pong');
      }

      // 'a' is the leader by lowest-port convention (30_000 < 30_001 < 30_002).
      // Verify that's actually true, then crash.
      const leaderRole = spec.clusterFor('a').leader().toNullable()!.address.systemName;
      expect(leaderRole).toBe('a');
      await spec.crash('a');

      await Promise.all([
        spec.awaitMembers('b', 2, 5_000),
        spec.awaitMembers('c', 2, 5_000),
      ]);
      // Give the new coordinator time to absorb re-registrations.
      await Bun.sleep(500);

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

      await Bun.sleep(300);

      // Start a batch of 32 asks against region 'a', then crash 'c' during
      // the batch.  Expectation: every ask eventually returns 'pong'.
      const inflight = Array.from({ length: 32 }, (_, i) =>
        regions.a.ask<string>({ id: `mid-${i}`, kind: 'ping' }, 8_000),
      );

      // Crash 'c' shortly after issuing — some asks land on shards that
      // were homed on c, and must be re-routed by the survivors.
      await Bun.sleep(20);
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

      await Bun.sleep(300);

      // Cut 'c' from both 'a' and 'b' — c becomes unreachable, then with
      // tight FD options (downAfterMs = 400) the cluster declares c
      // down + removed within ~half a second.  At *that* point — not at
      // first unreachable — the coordinator moves c's shards.  Waiting
      // for a 2-member view is the right signal here.
      spec.partition('a', 'c');
      spec.partition('b', 'c');

      await Promise.all([
        spec.awaitMembers('a', 2, 5_000),
        spec.awaitMembers('b', 2, 5_000),
      ]);
      // Brief settle so the new allocations propagate.
      await Bun.sleep(300);

      // Survivors continue to serve.
      for (let i = 0; i < 8; i++) {
        const result = await regions.a.ask<string>({ id: `part-${i}`, kind: 'ping' }, 5_000);
        expect(result).toBe('pong');
      }

      // Heal — at this point 'c' has been declared down + removed by the
      // survivors, so heal() alone won't bring it back into the cluster
      // (re-joining a downed node is a separate concern, see Cluster.leave).
      // We still call it to verify the harness doesn't throw, and that
      // the survivors stay healthy.
      spec.heal('a', 'c');
      spec.heal('b', 'c');
      await Bun.sleep(200);
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

      await Bun.sleep(300);

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
          await Bun.sleep(5);
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
      // …and after the churn settles, asks succeed again.
      await Bun.sleep(300);
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
          .withBehaviorFor((i) => Props.create(() => new Daemon(i, role)));
        ShardedDaemonProcess.init(
          spec.systemFor(role), spec.clusterFor(role),
          daemonOptions,
        );
      }

      // Wait for all 6 to fire preStart somewhere.
      const initialDeadline = Date.now() + 5_000;
      while (startsByIndex.size < 6 && Date.now() < initialDeadline) {
        await Bun.sleep(50);
      }
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
      // Allow up to 5 s — that's the rebalance + handoff timeout window.
      const failoverDeadline = Date.now() + 8_000;
      while (Date.now() < failoverDeadline) {
        const allRespawned = onC.every((index) => {
          const hosts = startsByIndex.get(index) ?? [];
          // hosts[0] was the original; we want a later entry on a or b.
          return hosts.slice(1).some((h) => h === 'a' || h === 'b');
        });
        if (allRespawned) break;
        await Bun.sleep(100);
      }

      for (const index of onC) {
        const hosts = startsByIndex.get(index) ?? [];
        const respawnedOnSurvivor = hosts.slice(1).some((h) => h === 'a' || h === 'b');
        expect(respawnedOnSurvivor).toBe(true);
      }
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);
});
