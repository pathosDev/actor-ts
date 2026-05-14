/**
 * Realistic Cassandra/Scylla plug-in: an event-sourced bank account
 * persisted against a live ScyllaDB cluster.  The example connects to the
 * cluster named in `SCYLLA_CONTACT_POINTS` (comma-separated hosts); if the
 * env var is unset the demo prints the setup instructions and exits.
 *
 *   docker run --rm -p 9042:9042 --name scylla -d scylladb/scylla:latest
 *   SCYLLA_CONTACT_POINTS=127.0.0.1 bun run examples/persistence/scylla-ledger.ts
 *
 *   # Cassandra works identically:
 *   docker run --rm -p 9042:9042 --name cassandra -d cassandra:latest
 *   SCYLLA_CONTACT_POINTS=127.0.0.1 bun run examples/persistence/scylla-ledger.ts
 */
import { match } from 'ts-pattern';
import {
  ActorSystem,
  CASSANDRA_JOURNAL_PLUGIN_ID,
  CASSANDRA_SNAPSHOT_PLUGIN_ID,
  PersistenceExtensionId,
  PersistentActor,
  Props,
  everyNEvents,
  registerCassandraPlugins,
} from '../../src/index.js';

type Cmd =
  | { kind: 'deposit'; amount: number }
  | { kind: 'withdraw'; amount: number }
  | { kind: 'balance' };

type Event =
  | { kind: 'deposited'; amount: number }
  | { kind: 'withdrawn'; amount: number };

interface State { readonly balance: number; }

class Account extends PersistentActor<Cmd, Event, State> {
  override readonly persistenceId: string;
  override readonly snapshotPolicy = everyNEvents<State, Event>(50);

  constructor(accountId: string) {
    super();
    this.persistenceId = `account-${accountId}`;
  }

  override initialState(): State { return { balance: 0 }; }

  override onEvent(state: State, e: Event): State {
    return match(e)
      .with({ kind: 'deposited' }, (d) => ({ balance: state.balance + d.amount }))
      .with({ kind: 'withdrawn' }, (d) => ({ balance: state.balance - d.amount }))
      .exhaustive();
  }

  override async onCommand(state: State, cmd: Cmd): Promise<void> {
    const reply = (msg: unknown): void => this.sender.forEach((s) => s.tell(msg));
    await match(cmd)
      .with({ kind: 'balance' }, async () => reply(state.balance))
      .with({ kind: 'withdraw' }, async (c) => {
        if (state.balance < c.amount) { reply({ error: 'insufficient funds' }); return; }
        await this.persist({ kind: 'withdrawn', amount: c.amount }, (s) => reply(s.balance));
      })
      .with({ kind: 'deposit' }, async (c) => {
        await this.persist({ kind: 'deposited', amount: c.amount }, (s) => reply(s.balance));
      })
      .exhaustive();
  }
}

async function main(): Promise<void> {
  const raw = process.env.SCYLLA_CONTACT_POINTS;
  if (!raw) {
    console.log(
      'SCYLLA_CONTACT_POINTS not set — skipping live run.\n'
      + 'Start Scylla locally with:\n'
      + '  docker run --rm -p 9042:9042 -d scylladb/scylla:latest\n'
      + 'then re-run with SCYLLA_CONTACT_POINTS=127.0.0.1 bun run ' + __filename,
    );
    return;
  }
  const contactPoints = raw.split(',').map((s) => s.trim());

  const system = ActorSystem.create('ledger', {
    config: {
      'actor-ts': {
        persistence: {
          journal: { plugin: CASSANDRA_JOURNAL_PLUGIN_ID },
          'snapshot-store': { plugin: CASSANDRA_SNAPSHOT_PLUGIN_ID },
        },
      },
    },
  });

  const ext = system.extension(PersistenceExtensionId);
  registerCassandraPlugins(ext, {
    journal: {
      contactPoints,
      keyspace: 'actor_ts',
      autoCreateKeyspace: true,
      autoCreateTables: true,
      localDataCenter: process.env.SCYLLA_DC ?? 'datacenter1',
    },
    snapshotStore: {
      contactPoints,
      keyspace: 'actor_ts',
      autoCreateTables: true,
      localDataCenter: process.env.SCYLLA_DC ?? 'datacenter1',
      keepN: 5,
    },
  });

  const alice = system.spawnAnonymous(Props.create(() => new Account('alice')));

  console.log('--- first run ---');
  console.log('deposit 100 →', await alice.ask({ kind: 'deposit', amount: 100 }, 3_000));
  console.log('deposit 200 →', await alice.ask({ kind: 'deposit', amount: 200 }, 3_000));
  console.log('withdraw 50 →', await alice.ask({ kind: 'withdraw', amount: 50 }, 3_000));
  console.log('balance    →', await alice.ask({ kind: 'balance' }, 3_000));

  // "Crash" — stop the actor, rebuild, replay.
  alice.stop();
  await Bun.sleep(50);
  console.log('--- second run (state replayed from Scylla) ---');
  const alice2 = system.spawnAnonymous(Props.create(() => new Account('alice')));
  console.log('balance    →', await alice2.ask({ kind: 'balance' }, 3_000));

  await ext.journal.close?.();
  await ext.snapshotStore.close?.();
  await system.terminate();
}

void main();
