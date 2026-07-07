/**
 * Schema evolution — additive change via `defaultsAdapter`.
 *
 * Scenario: a `BankAccount` actor originally persisted `Deposited`
 * events as `{ kind: 'deposited', amount: number }`.  A new currency
 * field is added — `currency: 'USD' | 'EUR'`.  Without an adapter,
 * recovering an old event would leave `currency` undefined and corrupt
 * the state.
 *
 * `defaultsAdapter` is the simplest path: declare a default for the
 * field at the previous version; the adapter automatically merges it on
 * read.  No upcaster function needed.
 *
 *   bun run examples/persistence/event-migration.ts
 */
import {
  ActorSystem,
  ActorSystemOptions,
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistentActor,
  Props,
  defaultsAdapter,
  type EventAdapter,
} from '../../src/index.js';

type DepositedV1 = { kind: 'deposited'; amount: number };
type DepositedV2 = { kind: 'deposited'; amount: number; currency: 'USD' | 'EUR' };
type Event = DepositedV2;

type Cmd = { kind: 'deposit'; amount: number } | { kind: 'balance' };
type State = { balance: number; currency: 'USD' | 'EUR' };

class Account extends PersistentActor<Cmd, Event, State> {
  constructor(readonly persistenceId: string) { super(); }
  initialState(): State { return { balance: 0, currency: 'USD' }; }
  onEvent(s: State, e: Event): State {
    return { balance: s.balance + e.amount, currency: e.currency };
  }
  override eventAdapter(): EventAdapter<Event> {
    return defaultsAdapter<DepositedV2>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 2,
      defaults: { 1: { currency: 'USD' } },  // old events default to USD
    });
  }
  async onCommand(_s: State, cmd: Cmd): Promise<void> {
    if (cmd.kind === 'deposit') {
      await this.persist(
        { kind: 'deposited', amount: cmd.amount, currency: 'EUR' },
        (st) => this.sender.forEach((s) => s.tell({ ok: st })),
      );
    } else {
      this.sender.forEach((s) => s.tell({ balance: this.state.balance, currency: this.state.currency }));
    }
  }
}

async function main(): Promise<void> {
  const journal = new InMemoryJournal();
  const snapshots = new InMemorySnapshotStore();

  // Pretend an older version of the app wrote one v1 event before we added `currency`.
  // We hand-craft a v1 envelope to simulate that history.
  await journal.append<unknown>('alice', [
    { _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 100 } as DepositedV1 },
  ], 0);

  const sysOptions = ActorSystemOptions.create()
    .withPersistence({ journal, snapshotStore: snapshots });
  const sys = ActorSystem.create('migration-additive', sysOptions);

  const acct = sys.spawn(Props.create(() => new Account('alice')), 'alice');
  console.log('after recovery →', await acct.ask({ kind: 'balance' }, 500));
  console.log('deposit 50 EUR →', await acct.ask({ kind: 'deposit', amount: 50 }, 500));
  console.log('balance        →', await acct.ask({ kind: 'balance' }, 500));

  // Inspect what's now on disk: legacy v1 entry + new v2 entry.
  const stored = await journal.read<unknown>('alice', 1);
  for (const ev of stored) console.log('journal:', JSON.stringify(ev.event));

  await sys.terminate();
}

void main();
