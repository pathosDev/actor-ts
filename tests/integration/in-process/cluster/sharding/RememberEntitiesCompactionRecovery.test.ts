/**
 * A coordinator starting over a long-churned, compacted registry (#649).
 *
 * The store unit suite (`tests/unit/cluster/sharding/RememberEntitiesCompaction.test.ts`)
 * bounds what `load()` reads.  This one runs the coordinator over such a
 * stream: 10 000 start/stop pairs written through the store beforehand, twenty
 * entities left started, and a fresh `ClusterSharding` reading the registry in
 * its `preStart`.  It reads a bounded number of events, and the twenty — and
 * only the twenty — come back.
 */
import { match } from 'ts-pattern';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS } from '../../../../../src/cluster/Constants.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { JournalRememberEntitiesStore } from '../../../../../src/cluster/sharding/RememberEntitiesStore.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { PersistentEvent } from '../../../../../src/persistence/JournalTypes.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

const TYPE_NAME = 'compacted';
const KEPT = 20;

type PingCommand = { readonly kind: 'ping'; readonly id: string };
type Command = PingCommand;

/** Every entity id that reached `preStart`, in order. */
let started: string[] = [];

class Entity extends Actor<Command> {
  override preStart(): void { started.push(this.entityId); }

  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'ping' }, () => this.onPing())
      .exhaustive();
  }

  private onPing(): void {}
}

/** Counts the events every read of the registry stream returns. */
class CountingJournal extends InMemoryJournal {
  registryEventsRead = 0;

  override async read<E>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    const events = await super.read<E>(persistenceId, fromSeq, toSeq);
    if (persistenceId === `sharding-coordinator-${TYPE_NAME}`) this.registryEventsRead += events.length;
    return events;
  }
}

let running: { system: ActorSystem; cluster: Cluster } | null = null;

afterEach(async () => {
  if (running) {
    await running.cluster.leave().catch(() => { /* teardown is best-effort */ });
    await running.system.terminate().catch(() => { /* teardown is best-effort */ });
    running = null;
  }
  started = [];
});

describe('ShardCoordinator — starting over a compacted registry (#649)', () => {
  test('reads a bounded number of events and brings back exactly the live entities', async () => {
    const journal = new CountingJournal();
    const writer = new JournalRememberEntitiesStore(journal);
    for (let index = 0; index < KEPT; index++) {
      await writer.append(TYPE_NAME, { kind: 'started', shardId: 0, entityId: `kept-${index}` });
    }
    for (let index = 0; index < 10_000; index++) {
      await writer.append(TYPE_NAME, { kind: 'started', shardId: 0, entityId: `churn-${index}` });
      await writer.append(TYPE_NAME, { kind: 'stopped', shardId: 0, entityId: `churn-${index}` });
    }
    journal.registryEventsRead = 0;

    const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('remember-compaction', systemOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(47_390)
      .withSeeds([])
      .withTransport(new InMemoryTransport(new NodeAddress('remember-compaction', 'h', 47_390)))
      .withGossipIntervalMs(30);
    const cluster = await Cluster.join(system, clusterOptions);
    running = { system, cluster };

    const shardingOptions = StartShardingOptions.create<Command>()
      .withTypeName(TYPE_NAME)
      .withEntityActor(Entity)
      .withExtractEntityId((message) => message.id)
      .withNumShards(1)
      .withRememberEntities(true)
      .withRememberEntitiesStore(new JournalRememberEntitiesStore(journal))
      .withPassivationIdleMs(0);
    const region = cluster.sharding.start<Command>(shardingOptions);
    region.tell({ kind: 'ping', id: 'kept-0' });

    await awaitCondition(() => new Set(started).size === KEPT, {
      timeoutMs: 5_000,
      intervalMs: 10,
      label: 'every remembered entity came back',
    });
    expect(new Set(started)).toEqual(new Set(Array.from({ length: KEPT }, (_, index) => `kept-${index}`)));
    // Uncompacted, the coordinator's preStart read 20 020 events here.
    expect(journal.registryEventsRead).toBeLessThanOrEqual(REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS + 1);
  }, 15_000);
});
