import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { ShardRegionRegistered } from '../../../../../src/cluster/ClusterEvents.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

/**
 * #1317 — a region's registration with the coordinator, made observable.
 *
 * The acceptance criterion this suite exists for is the *ordering* one: the
 * signal must fire **after** registration and not before, rather than only
 * eventually.  A test that waits for the flag to flip proves nothing about
 * that — a field initialised to `true` would pass it — so the first case
 * asserts the flag is false at a moment when registration provably cannot
 * have completed: the statement right after `start()` returns, before any
 * round trip to the coordinator could have happened.
 */

type Command = { readonly id: string; readonly kind: 'ping' };

class Entity extends Actor<Command> {
  override onReceive(): void { this.sender.forEach((s) => s.tell('pong')); }
}

const TYPE_NAME = 'registration-probe';

type Node = { readonly sys: ActorSystem; readonly cluster: Cluster };

async function startCluster(sysName: string, port: number): Promise<Node> {
  const sys = ActorSystem.create(
    sysName,
    ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
  );
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(sysName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(sys, clusterOptions);
  return { sys, cluster };
}

function startRegion(node: Node): void {
  node.cluster.sharding.start<Command>(
    StartShardingOptions.create<Command>()
      .withTypeName(TYPE_NAME)
      .withEntityActor(Entity)
      .withExtractEntityId((m) => m.id)
      .withNumShards(8),
  );
}

async function stop(node: Node): Promise<void> {
  await node.cluster.leave();
  await node.sys.terminate();
}

describe('ShardRegion registration observable', () => {
  test('the signal is false until the coordinator acknowledges, then true', async () => {
    const node = await startCluster('reg-order', 45_401);
    try {
      expect(node.cluster.sharding.isRegistered(TYPE_NAME)).toBe(false);

      startRegion(node);
      // The "not before" half.  `start` spawns the region and returns; the
      // registration needs a leader, a resolved coordinator ref and a round
      // trip, none of which can have happened by this line.
      expect(node.cluster.sharding.isRegistered(TYPE_NAME)).toBe(false);

      await awaitCondition(
        () => node.cluster.sharding.isRegistered(TYPE_NAME),
        { timeoutMs: 5_000, intervalMs: 20, label: 'the region registered with the coordinator' },
      );
    } finally {
      await stop(node);
    }
  }, 20_000);

  test('the event is published once, not once per acknowledgment', async () => {
    const node = await startCluster('reg-event', 45_402);
    try {
      const seen: ShardRegionRegistered[] = [];
      node.cluster.subscribe((event) => {
        if (event instanceof ShardRegionRegistered) seen.push(event);
      });

      startRegion(node);
      await awaitCondition(
        () => seen.length > 0,
        { timeoutMs: 5_000, intervalMs: 20, label: 'ShardRegionRegistered was published' },
      );

      expect(seen[0]?.type).toBe(TYPE_NAME);
      expect(seen[0]?.proxy).toBe(false);

      // The coordinator re-acknowledges on every re-registration, and the
      // region re-registers on its retry timer until it is acknowledged.  A
      // second event here would mean the transition guard is not holding.
      await awaitCondition(
        () => node.cluster.sharding.isRegistered(TYPE_NAME),
        { timeoutMs: 5_000, intervalMs: 20, label: 'the region registered' },
      );
      const afterSettling = seen.length;
      await awaitCondition(
        () => seen.length > afterSettling,
        { timeoutMs: 600, intervalMs: 50, label: 'a second registration event (not expected)' },
      ).then(
        () => { throw new Error(`expected one ShardRegionRegistered, saw ${seen.length}`); },
        () => { /* the timeout is the pass */ },
      );
      expect(seen.length).toBe(1);
    } finally {
      await stop(node);
    }
  }, 20_000);

  test('a type this node never started is not registered', async () => {
    const node = await startCluster('reg-unknown', 45_403);
    try {
      startRegion(node);
      await awaitCondition(
        () => node.cluster.sharding.isRegistered(TYPE_NAME),
        { timeoutMs: 5_000, intervalMs: 20, label: 'the region registered' },
      );
      expect(node.cluster.sharding.isRegistered('never-started')).toBe(false);
    } finally {
      await stop(node);
    }
  }, 20_000);
});
