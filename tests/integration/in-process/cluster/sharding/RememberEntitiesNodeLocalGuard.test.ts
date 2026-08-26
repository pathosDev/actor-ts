import { describe, expect, test } from 'bun:test';

import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions, type ClusterOptionsBuilder } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { JournalRememberEntitiesStore } from '../../../../../src/cluster/sharding/RememberEntitiesStore.js';
import { StartShardingOptions, type StartShardingOptionsBuilder } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import {
  InMemoryJournal,
  PersistenceExtensionId,
  StorageLocalityError,
} from '../../../../../src/persistence/index.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';
import { RecordingLogger, type RecordedLog } from '../../../../util/RecordingLogger.js';

/**
 * The fail-fast half of #1356 — the one place the node-local combination is
 * provably broken rather than merely suspicious.  `rememberEntities: true`
 * on the auto path wires its registry from the system journal, and the
 * coordinator is leader-hosted: on failover the next leader calls
 * `store.load(typeName)` against ITS OWN database.  The repo's own
 * multi-node suite hand-injects one shared `InMemoryJournal` into every
 * role to make the feature work (`tests/multi-node/ShardingRememberEntities
 * .test.ts`) — this guard makes production code refuse the configuration
 * that silently lacks the property the test provides by hand.
 *
 * Every escape hatch is structural, and each one is pinned below: an
 * explicit store, `rememberEntitiesStore: null`, a journal that declares
 * (or is re-declared) `'shared'`, and a genuinely standalone node.
 */

type PingCommand = { readonly kind: 'ping'; readonly id: string };
type Command = PingCommand;

class EntityActor extends Actor<Command> {
  override onReceive(_message: Command): void { /* the guard fires before any entity exists */ }
}

function loggingSystem(name: string): { system: ActorSystem; log: RecordingLogger } {
  const log = new RecordingLogger();
  const system = ActorSystem.create(name, ActorSystemOptions.create().withLogger(log));
  return { system, log };
}

function clusterOptions(systemName: string, port: number): ClusterOptionsBuilder {
  return ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
}

function rememberingSharding(typeName: string): StartShardingOptionsBuilder<Command> {
  return StartShardingOptions.create<Command>()
    .withTypeName(typeName)
    .withEntityActor(EntityActor)
    .withExtractEntityId((message) => message.id)
    .withNumShards(4)
    .withRememberEntities(true);
}

function nodeLocalRecords(log: RecordingLogger): RecordedLog[] {
  return log.records.filter((record) => record.message.includes('node-local storage'));
}

describe('rememberEntities auto-wiring over a node-local journal', () => {
  test('a cluster expecting remote peers refuses to start the region', async () => {
    const { system } = loggingSystem('re-guard-refuse');
    const seeded = clusterOptions('re-guard-refuse', 56_301)
      .withSeeds(['re-guard-refuse@h:56302'])
      .withSeedRetryIntervalMs(100);
    const cluster = await Cluster.join(system, seeded);
    try {
      const start = (): unknown => cluster.sharding.start<Command>(rememberingSharding('carts'));

      expect(start).toThrow(StorageLocalityError);
      // The message has to hand the operator every way out, not just the verdict.
      expect(start).toThrow(/rememberEntitiesStore/);
      expect(start).toThrow(/CassandraRememberEntitiesStore/);
      expect(start).toThrow(/shared journal/);
      expect(start).toThrow(/#1356/);
    } finally {
      await cluster.leave();
      await system.terminate();
    }
  });

  test('an explicit store is the user\'s own wiring and passes', async () => {
    const { system } = loggingSystem('re-guard-explicit');
    const seeded = clusterOptions('re-guard-explicit', 56_311)
      .withSeeds(['re-guard-explicit@h:56312'])
      .withSeedRetryIntervalMs(100);
    const cluster = await Cluster.join(system, seeded);
    try {
      const explicitStore = new JournalRememberEntitiesStore(new InMemoryJournal());
      const options = rememberingSharding('carts').withRememberEntitiesStore(explicitStore);

      expect(() => cluster.sharding.start<Command>(options)).not.toThrow();
    } finally {
      await cluster.leave();
      await system.terminate();
    }
  });

  test('rememberEntitiesStore: null keeps the registry in memory and passes', async () => {
    const { system } = loggingSystem('re-guard-null');
    const seeded = clusterOptions('re-guard-null', 56_321)
      .withSeeds(['re-guard-null@h:56322'])
      .withSeedRetryIntervalMs(100);
    const cluster = await Cluster.join(system, seeded);
    try {
      const options = rememberingSharding('carts').withRememberEntitiesStore(null);

      expect(() => cluster.sharding.start<Command>(options)).not.toThrow();
    } finally {
      await cluster.leave();
      await system.terminate();
    }
  });

  test('a journal re-declared shared passes — one shared in-memory instance is the multi-node fixture shape', async () => {
    const { system } = loggingSystem('re-guard-shared');
    const journal = new InMemoryJournal();
    journal.storageLocality = 'shared';
    system.extension(PersistenceExtensionId).setJournal(journal);
    const seeded = clusterOptions('re-guard-shared', 56_331)
      .withSeeds(['re-guard-shared@h:56332'])
      .withSeedRetryIntervalMs(100);
    const cluster = await Cluster.join(system, seeded);
    try {
      expect(() => cluster.sharding.start<Command>(rememberingSharding('carts'))).not.toThrow();
    } finally {
      await cluster.leave();
      await system.terminate();
    }
  });

  test('a standalone node passes now and escalates to an error when a peer arrives', async () => {
    // Wired before any peer exists, the region cannot be un-wired — so the
    // advisory carries the remember-entities note at error level and the
    // membership event that brings the first peer surfaces it.
    const { system: systemA, log: logA } = loggingSystem('re-guard-late');
    const nodeA = await Cluster.join(systemA, clusterOptions('re-guard-late', 56_341));
    const { system: systemB } = loggingSystem('re-guard-late');
    let nodeB: Cluster | null = null;
    try {
      expect(() => nodeA.sharding.start<Command>(rememberingSharding('carts'))).not.toThrow();
      expect(nodeLocalRecords(logA)).toEqual([]);

      nodeB = await Cluster.join(
        systemB,
        clusterOptions('re-guard-late', 56_342).withSeeds(['re-guard-late@h:56341']),
      );

      await awaitCondition(() => nodeLocalRecords(logA).length === 1, {
        timeoutMs: 4_000,
        label: 'node A escalated the remember-entities note once the peer joined',
      });
      const record = nodeLocalRecords(logA)[0]!;
      expect(record.level).toBe('error');
      expect(record.message).toContain("remember-entities 'InMemoryJournal'");
      expect(record.message).toContain('forgets every remembered entity');
    } finally {
      if (nodeB !== null) await nodeB.leave();
      await nodeA.leave();
      await systemB.terminate();
      await systemA.terminate();
    }
  });
});
