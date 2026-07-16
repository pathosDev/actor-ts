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

type DepositCommand = { kind: 'deposit'; amount: number };
type WithdrawCommand = { kind: 'withdraw'; amount: number };
type BalanceCommand = { kind: 'balance' };
type Command = DepositCommand | WithdrawCommand | BalanceCommand;

type DepositedEvent = { kind: 'deposited'; amount: number };
type WithdrewEvent = { kind: 'withdrew'; amount: number };
type Event = DepositedEvent | WithdrewEvent;

type State = { balance: number };

class Account extends PersistentActor<Command, Event, State> {
  constructor(readonly persistenceId: string) { super(); }
  initialState(): State { return { balance: 0 }; }
  onEvent(s: State, e: Event): State {
    return match(e)
      .with({ kind: 'deposited' }, (d) => this.onDeposited(s, d))
      .with({ kind: 'withdrew' }, (d) => this.onWithdrew(s, d))
      .exhaustive();
  }

  private onDeposited(s: State, d: DepositedEvent): State {
    return { balance: s.balance + d.amount };
  }

  private onWithdrew(s: State, d: WithdrewEvent): State {
    return { balance: s.balance - d.amount };
  }

  snapshotPolicy() { return everyNEvents<State, Event>(5); }
  async onCommand(s: State, cmd: Command): Promise<void> {
    await match(cmd)
      .with({ kind: 'deposit', amount: P.number.gt(0) }, (c) => this.onDeposit(c))
      .with({ kind: 'withdraw' }, (c) => this.onWithdraw(s, c))
      .with({ kind: 'balance' }, () => this.onBalance(s))
      .otherwise(() => this.onUnhandled());
  }

  private reply(msg: unknown): void {
    this.sender.forEach((sender) => sender.tell(msg));
  }

  private async onDeposit(c: DepositCommand): Promise<void> {
    await this.persist({ kind: 'deposited', amount: c.amount },
      (st) => this.reply({ balance: st.balance }));
  }

  private async onWithdraw(s: State, c: WithdrawCommand): Promise<void> {
    if (c.amount > s.balance) { this.reply(new Error('rejected')); return; }
    await this.persist({ kind: 'withdrew', amount: c.amount },
      (st) => this.reply({ balance: st.balance }));
  }

  private async onBalance(s: State): Promise<void> {
    this.reply({ balance: s.balance });
  }

  // e.g. deposit with amount<=0
  private async onUnhandled(): Promise<void> {
    this.reply(new Error('rejected'));
  }
}

async function main(): Promise<void> {
  const journalOptions = SqliteJournalOptions.create().withPath(':memory:');
  const journal = new SqliteJournal(journalOptions);
  const snapshotOptions = SqliteSnapshotStoreOptions.create()
    .withPath(':memory:')
    .withKeepN(2);
  const snapshots = new SqliteSnapshotStore(snapshotOptions);

  // --- first incarnation: record events ---
  const sys1Options = ActorSystemOptions.create().withPersistence({ journal, snapshotStore: snapshots });
  const sys1 = ActorSystem.create('bank', sys1Options);

  const acct1 = sys1.spawn(Props.create(() => new Account('alice')), 'alice');
  for (const amount of [100, 50, 20, 30, 10, 5, 100]) {
    console.log('deposit', amount, '→', await acct1.ask({ kind: 'deposit', amount }, 500));
  }
  console.log('withdraw 60 →', await acct1.ask({ kind: 'withdraw', amount: 60 }, 500));
  console.log('balance    →', await acct1.ask({ kind: 'balance' }, 500));
  await sys1.terminate();

  // --- second incarnation: recover from the same journal ---
  const sys2Options = ActorSystemOptions.create().withPersistence({ journal, snapshotStore: snapshots });
  const sys2 = ActorSystem.create('bank-restart', sys2Options);

  const acct2 = sys2.spawn(Props.create(() => new Account('alice')), 'alice');
  console.log('after restart, balance →', await acct2.ask({ kind: 'balance' }, 500));
  await sys2.terminate();

  await journal.close();
  await snapshots.close();
}

void main();
