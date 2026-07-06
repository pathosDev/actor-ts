/**
 * Event-sourced bank account.  Demonstrates:
 *   - PersistentActor with command / event / state triple
 *   - persist(event, cb) with cb replying to the sender
 *   - Recovery from the journal after a fresh incarnation
 *   - Snapshot every N events to keep recovery cheap
 *   - SQLite-backed journal via `bun:sqlite`
 *
 *   bun run examples/persistence/bank-account.ts
 */
import { match, P } from 'ts-pattern';
import {
  ActorSystem,
  ActorSystemOptions,
  PersistentActor,
  Props,
  SqliteJournal,
  SqliteJournalOptions,
  SqliteSnapshotStore,
  SqliteSnapshotStoreOptions,
  everyNEvents,
} from '../../src/index.js';

type Cmd =
  | { kind: 'deposit'; amount: number }
  | { kind: 'withdraw'; amount: number }
  | { kind: 'balance' };

type Event =
  | { kind: 'deposited'; amount: number }
  | { kind: 'withdrew'; amount: number };

type State = { balance: number };

class Account extends PersistentActor<Cmd, Event, State> {
  constructor(readonly persistenceId: string) { super(); }
  initialState(): State { return { balance: 0 }; }
  onEvent(s: State, e: Event): State {
    return match(e)
      .with({ kind: 'deposited' }, (d) => ({ balance: s.balance + d.amount }))
      .with({ kind: 'withdrew' }, (d) => ({ balance: s.balance - d.amount }))
      .exhaustive();
  }
  snapshotPolicy() { return everyNEvents<State, Event>(5); }
  async onCommand(s: State, cmd: Cmd): Promise<void> {
    const reply = (msg: unknown): void => this.sender.forEach((sender) => sender.tell(msg));
    await match(cmd)
      .with({ kind: 'deposit', amount: P.number.gt(0) }, async (c) => {
        await this.persist({ kind: 'deposited', amount: c.amount },
          (st) => reply({ balance: st.balance }));
      })
      .with({ kind: 'withdraw' }, async (c) => {
        if (c.amount > s.balance) { reply(new Error('rejected')); return; }
        await this.persist({ kind: 'withdrew', amount: c.amount },
          (st) => reply({ balance: st.balance }));
      })
      .with({ kind: 'balance' }, async () => reply({ balance: s.balance }))
      .otherwise(async () => reply(new Error('rejected'))); // e.g. deposit with amount<=0
  }
}

async function main(): Promise<void> {
  const journal = new SqliteJournal(SqliteJournalOptions.create().withPath(':memory:'));
  const snapshots = new SqliteSnapshotStore(SqliteSnapshotStoreOptions.create().withPath(':memory:').withKeepN(2));

  // --- first incarnation: record events ---
  const sys1 = ActorSystem.create('bank', ActorSystemOptions.create().withPersistence({ journal, snapshotStore: snapshots }));

  const acct1 = sys1.spawn(Props.create(() => new Account('alice')), 'alice');
  for (const amount of [100, 50, 20, 30, 10, 5, 100]) {
    console.log('deposit', amount, '→', await acct1.ask({ kind: 'deposit', amount }, 500));
  }
  console.log('withdraw 60 →', await acct1.ask({ kind: 'withdraw', amount: 60 }, 500));
  console.log('balance    →', await acct1.ask({ kind: 'balance' }, 500));
  await sys1.terminate();

  // --- second incarnation: recover from the same journal ---
  const sys2 = ActorSystem.create('bank-restart', ActorSystemOptions.create().withPersistence({ journal, snapshotStore: snapshots }));

  const acct2 = sys2.spawn(Props.create(() => new Account('alice')), 'alice');
  console.log('after restart, balance →', await acct2.ask({ kind: 'balance' }, 500));
  await sys2.terminate();

  await journal.close();
  await snapshots.close();
}

void main();
