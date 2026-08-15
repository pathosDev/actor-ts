/**
 * The `/user` vs `/system` boundary, asserted end-to-end.
 *
 * This is the test that keeps the split from rotting: every subsystem is
 * started for real and the whole tree is walked, so a new framework actor
 * added through `system.spawn` shows up here as a failure rather than as a
 * stray entry in someone's DevTools panel months later.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { Cluster } from '../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../src/cluster/Transport.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import { StartSingletonOptions } from '../../src/cluster/singleton/StartSingletonOptions.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import { DistributedPubSubId } from '../../src/cluster/pubsub/DistributedPubSubExtension.js';
import { DistributedDataId } from '../../src/crdt/DistributedData.js';
import { ReceptionistId } from '../../src/discovery/Receptionist.js';
import { ReliableDelivery } from '../../src/delivery/ReliableDelivery.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { SystemGroups } from '../../src/internal/SystemPaths.js';
import { freeActorName } from '../../src/devtools/internal/ActorNames.js';

type EntityCommand = { readonly id: string; readonly kind: 'ping' };

class Entity extends Actor<EntityCommand> {
  override onReceive(_message: EntityCommand): void {}
}

class Plain extends Actor<string> {
  override onReceive(_message: string): void {}
}

const SYSTEM_NAME = 'layout';

async function startEverything(): Promise<{ system: ActorSystem; cluster: Cluster }> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(SYSTEM_NAME, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(72_101)
    .withTransport(new InMemoryTransport(new NodeAddress(SYSTEM_NAME, 'h', 72_101)));
  const cluster = await Cluster.join(system, clusterOptions);

  system.extension(ReceptionistId).start(cluster);
  system.extension(DistributedPubSubId).start(cluster);
  system.extension(DistributedDataId).start(cluster);

  const shardingOptions = StartShardingOptions.create<EntityCommand>()
    .withTypeName('cart')
    .withEntityActor(Entity)
    .withExtractEntityId((message) => message.id)
    .withNumShards(4);
  cluster.sharding.start<EntityCommand>(shardingOptions);

  const singletonOptions = StartSingletonOptions.create<string>()
    .withTypeName('cron')
    .withActor(Plain);
  cluster.singleton.start(singletonOptions);

  // Named explicitly: the auto-generated `consumer-N` counter is module-global,
  // so it would differ between the two tests in this file.
  // `handler`, not `handle` — the misspelling type-checked nowhere and was
  // silently dropped, so the controller under test had no handler at all.
  ReliableDelivery.consumer<string>(system, { handler: () => { /* no-op */ } }, 'orders');

  return { system, cluster };
}

describe('framework actors live under /system', () => {
  test('nothing the framework spawns ends up under /user', async () => {
    const { system, cluster } = await startEverything();
    try {
      // A user actor, so the assertion below is about placement and not about
      // an empty `/user`.
      system.spawn(Plain, 'my-actor');

      const userChildren = system._inspectTree()
        .filter((cell) => cell.parentPath === `actor-ts://${SYSTEM_NAME}/user`)
        .map((cell) => cell.name);

      expect(userChildren).toEqual(['my-actor']);
    } finally {
      await cluster.leave();
      await system.terminate();
    }
  });

  test('each framework actor sits in its expected group', async () => {
    const { system, cluster } = await startEverything();
    try {
      const paths = new Set(system._inspectTree().map((cell) => cell.path));
      const at = (group: string, name: string): string =>
        `actor-ts://${SYSTEM_NAME}/system/${group}/${name}`;

      expect(paths).toContain(at(SystemGroups.cluster, 'receptionist'));
      expect(paths).toContain(at(SystemGroups.clusterPubSub, 'mediator'));
      expect(paths).toContain(at(SystemGroups.clusterCrdt, 'data'));
      expect(paths).toContain(at(SystemGroups.clusterSharding, 'region-cart'));
      expect(paths).toContain(at(SystemGroups.clusterSharding, 'coordinator-cart'));
      expect(paths).toContain(at(SystemGroups.clusterSingleton, 'manager-cron'));
      expect(paths).toContain(at(SystemGroups.delivery, 'orders'));
    } finally {
      await cluster.leave();
      await system.terminate();
    }
  });
});

describe('freeActorName', () => {
  test('sees the siblings inside the group it is asked about', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('free-name', systemOptions);
    try {
      expect(freeActorName(system, SystemGroups.devtools, 'hub')).toBe('hub');

      system._spawnSystemActor(Plain, SystemGroups.devtools, 'hub');

      // Re-attaching before the previous hub has finished terminating must
      // step aside rather than throw "Child name 'hub' is not unique".  A
      // filter looking at the wrong parent would see nothing taken and hand
      // back `hub` again — silently reintroducing that failure.
      expect(freeActorName(system, SystemGroups.devtools, 'hub')).toBe('hub-2');

      // A same-named actor in a *different* group is not a collision.
      system._spawnSystemActor(Plain, SystemGroups.delivery, 'hub');
      expect(freeActorName(system, SystemGroups.devtools, 'hub')).toBe('hub-2');
    } finally {
      await system.terminate();
    }
  });
});
