/**
 * Hello Cassandra/Scylla journal: uses the in-memory FakeCassandraClient
 * from the test suite so the example runs without an external database.
 * The journal + snapshot-store code is exactly the same as you'd use
 * against real Cassandra — swap the client for `createCassandraClient(...)`
 * to point at a live cluster (see scylla-ledger.ts for that).
 *
 *   bun run examples/persistence/cassandra-plugin-hello.ts
 */
import { match } from 'ts-pattern';
import {
  ActorSystem,
  ActorSystemOptions,
  CASSANDRA_JOURNAL_PLUGIN_ID,
  CASSANDRA_SNAPSHOT_PLUGIN_ID,
  CassandraJournalOptions,
  CassandraSnapshotStoreOptions,
  PersistenceExtensionId,
  Props,
  PersistentActor,
  RegisterCassandraPluginsOptions,
  registerCassandraPlugins,
} from '../../src/index.js';
import { FakeCassandraClient } from '../../tests/unit/persistence/FakeCassandraClient.js';

type Cmd = { kind: 'inc'; amount: number } | { kind: 'get' };
type Event = { kind: 'incremented'; amount: number };

class Counter extends PersistentActor<Cmd, Event, number> {
  override readonly persistenceId = 'counter-1';
  override initialState(): number { return 0; }

  override async onCommand(state: number, cmd: Cmd): Promise<void> {
    await match(cmd)
      .with({ kind: 'get' }, () => this.onGet(state))
      .with({ kind: 'inc' }, (c) => this.onInc(c))
      .exhaustive();
  }

  private async onGet(state: number): Promise<void> {
    this.sender.forEach((s) => s.tell(state));
  }

  private async onInc(c: Extract<Cmd, { kind: 'inc' }>): Promise<void> {
    await this.persist({ kind: 'incremented', amount: c.amount }, (s) => {
      this.sender.forEach((sender) => sender.tell(s));
    });
  }

  override onEvent(state: number, event: Event): number {
    return state + event.amount;
  }
}

async function main(): Promise<void> {
  const client = new FakeCassandraClient();
  const systemOptions = ActorSystemOptions.create().withConfig({
      'actor-ts': {
        persistence: {
          journal: { plugin: CASSANDRA_JOURNAL_PLUGIN_ID },
          'snapshot-store': { plugin: CASSANDRA_SNAPSHOT_PLUGIN_ID },
        },
      },
    });
  const system = ActorSystem.create('cassandra-hello', systemOptions);
  const ext = system.extension(PersistenceExtensionId);
  const journalOptions = CassandraJournalOptions.create()
    .withContactPoints(['fake']).withKeyspace('app').withAutoCreateKeyspace(true);
  const snapshotOptions = CassandraSnapshotStoreOptions.create()
    .withContactPoints(['fake']).withKeyspace('app');
  const cassandraPluginsOptions = RegisterCassandraPluginsOptions.create()
    .withClient(client)
    .withJournal(journalOptions)
    .withSnapshotStore(snapshotOptions);
  registerCassandraPlugins(ext, cassandraPluginsOptions);

  let counter = system.spawnAnonymous(Props.create(() => new Counter()));
  counter.tell({ kind: 'inc', amount: 10 });
  counter.tell({ kind: 'inc', amount: 32 });
  await Bun.sleep(60);

  // "Crash and restart" — the new actor replays events from the journal.
  counter.stop();
  await Bun.sleep(30);
  counter = system.spawnAnonymous(Props.create(() => new Counter()));

  await Bun.sleep(60);
  // Use ask to read the state so we see the replay worked.
  const { ask } = await import('../../src/index.js');
  const value = await ask<Cmd, number>(counter, { kind: 'get' }, 500);
  console.log(`counter after replay: ${value}`); // expect 42

  await system.terminate();
}

void main();
