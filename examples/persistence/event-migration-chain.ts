/**
 * Schema evolution — non-additive change via `MigrationChain`.
 *
 * Scenario: the `Deposited` event used `amount: number` (dollars).  A
 * later revision stores money in cents to avoid float rounding —
 * `cents: number`.  This is a rename + type-meaning change, which the
 * `defaultsAdapter` can't handle.  `MigrationChain` lets us declare
 * each upcaster as a typed pure function.
 *
 *   bun run examples/persistence/event-migration-chain.ts
 */
import { match } from 'ts-pattern';
import {
  ActorSystem,
  ActorSystemOptions,
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistentActor,
  MigrationChain,
  type EventAdapter,
} from '../../src/index.js';
import { attachDevTools } from '../devtools.js';

type DepositedV1 = { kind: 'deposited'; amount: number };                                    // dollars
type DepositedV2 = { kind: 'deposited'; amount: number; currency: 'USD' | 'EUR' };           // dollars + currency
type DepositedV3 = { kind: 'deposited'; cents: number; currency: 'USD' | 'EUR' };            // cents + currency
type Event = DepositedV3;

type DepositCommand = { kind: 'deposit'; cents: number };
type BalanceCommand = { kind: 'balance' };

type Command = DepositCommand | BalanceCommand;
type State = { balanceCents: number; currency: 'USD' | 'EUR' };

class Account extends PersistentActor<Command, Event, State> {
  constructor(readonly persistenceId: string) { super(); }
  initialState(): State { return { balanceCents: 0, currency: 'USD' }; }
  onEvent(s: State, e: Event): State {
    return { balanceCents: s.balanceCents + e.cents, currency: e.currency };
  }
  override eventAdapter(): EventAdapter<Event> {
    const chain = MigrationChain.for<DepositedV3>('BankAccount.Deposited', 3)
      .add({ fromVersion: 1, toVersion: 2,
             upcast: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }) })
      .add({ fromVersion: 2, toVersion: 3,
             upcast: (v: DepositedV2): DepositedV3 => ({
               kind: v.kind, cents: Math.round(v.amount * 100), currency: v.currency,
             }) });
    return {
      manifest: () => 'BankAccount.Deposited',
      toJournal: (e) => ({ manifest: 'BankAccount.Deposited', version: 3, payload: e }),
      fromJournal: (s) => chain.upcast(s),
    };
  }
  async onCommand(_s: State, command: Command): Promise<void> {
    await match(command)
      .with({ kind: 'deposit' }, (c) => this.onDeposit(c))
      .with({ kind: 'balance' }, () => this.onBalance())
      .exhaustive();
  }

  private async onDeposit(command: DepositCommand): Promise<void> {
    await this.persist(
      { kind: 'deposited', cents: command.cents, currency: 'EUR' },
      (st) => this.sender.forEach((s) => s.tell({ ok: st })),
    );
  }

  private onBalance(): void {
    this.sender.forEach((s) => s.tell({ balanceCents: this.state.balanceCents, currency: this.state.currency }));
  }
}

async function main(): Promise<void> {
  const journal = new InMemoryJournal();
  const snapshots = new InMemorySnapshotStore();

  // Simulate three generations of events on disk: v1 (raw amount, USD), v2 (amount + currency),
  // v3 (cents + currency).  Recovery must converge them all to v3.
  await journal.append<unknown>('alice', [
    { _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 1.5 } },
    { _v: 2, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 2, currency: 'EUR' } },
    { _v: 3, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', cents: 99, currency: 'USD' } },
  ], 0);

  const sysOptions = ActorSystemOptions.create().withPersistence({ journal, snapshotStore: snapshots });
  const sys = ActorSystem.create('migration-chain', sysOptions);
  const devtools = await attachDevTools(sys);

  const acct = sys.spawn(() => new Account('alice'), 'alice');
  // v1 (1.5 USD = 150 cents) + v2 (2 EUR = 200 cents) + v3 (99 cents) = 449 cents.
  console.log('after recovery (cents) →', await acct.ask({ kind: 'balance' }, 500));
  console.log('deposit 100 cents EUR  →', await acct.ask({ kind: 'deposit', cents: 100 }, 500));
  console.log('final (cents)          →', await acct.ask({ kind: 'balance' }, 500));

  await devtools.holdOpen();
  await sys.terminate();
}

void main();
