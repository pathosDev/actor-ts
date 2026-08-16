/**
 * Projection example — materialise a per-account "bank statement"
 * read-model from the events written by `bank-account.ts`.
 *
 *   Account                ProjectionActor
 *   ─────────              ─────────────────
 *   deposit / withdraw  ─►  pump events out of the journal
 *                            via PersistenceQuery
 *                            ─►  user handler updates an in-memory
 *                                 ledger keyed by persistence id
 *
 * Demonstrates:
 *   - PersistentActor that emits tagged events.
 *   - InMemoryQuery as the read side (works on top of any Journal).
 *   - ProjectionActor.byTag with at-least-once delivery.
 *   - Restart-safe offset persistence via InMemoryOffsetStore (swap
 *     for `DurableStateOffsetStore(new SqliteDurableStateStore(...))`
 *     in production so the cursor survives a process restart).
 *   - A handler-failure recovery strategy + `onFailure` hook — the
 *     ledger below never throws, but this is the wiring a real read
 *     model needs so one bad event cannot wedge the whole projection.
 *
 *   bun run examples/persistence/projection-bank-statement.ts
 */
import { match, P } from 'ts-pattern';
import {
  ActorSystem,
  ActorSystemOptions,
} from '../../src/index.js';
import {
  ByTagProjectionOptions,
  everyNEvents,
  InMemoryJournal,
  InMemoryOffsetStore,
  InMemoryQuery,
  PersistentActor,
  ProjectionActor,
} from '../../src/persistence/index.js';

/* --------------------------- write side ------------------------------- */

type DepositCommand = { kind: 'deposit'; amount: number };
type WithdrawCommand = { kind: 'withdraw'; amount: number };
type BalanceCommand = { kind: 'balance' };
type AccountCommand = DepositCommand | WithdrawCommand | BalanceCommand;

type DepositedEvent = { kind: 'deposited'; amount: number };
type WithdrewEvent = { kind: 'withdrew'; amount: number };
type AccountEvent = DepositedEvent | WithdrewEvent;

type AccountState = { balance: number };

class Account extends PersistentActor<AccountCommand, AccountEvent, AccountState> {
  constructor(readonly persistenceId: string) { super(); }
  initialState(): AccountState { return { balance: 0 }; }
  onEvent(s: AccountState, e: AccountEvent): AccountState {
    return match(e)
      .with({ kind: 'deposited' }, (d) => this.onDeposited(s, d))
      .with({ kind: 'withdrew' }, (d) => this.onWithdrew(s, d))
      .exhaustive();
  }

  private onDeposited(s: AccountState, d: DepositedEvent): AccountState {
    return { balance: s.balance + d.amount };
  }

  private onWithdrew(s: AccountState, d: WithdrewEvent): AccountState {
    return { balance: s.balance - d.amount };
  }

  /** Tag every event so the projection can find them by tag. */
  override tagsFor(_e: AccountEvent): readonly string[] { return ['account']; }
  snapshotPolicy() { return everyNEvents<AccountState, AccountEvent>(5); }

  async onCommand(s: AccountState, command: AccountCommand): Promise<void> {
    await match(command)
      .with({ kind: 'deposit', amount: P.number.gt(0) }, (c) => this.onDeposit(c))
      .with({ kind: 'withdraw' }, (c) => this.onWithdraw(s, c))
      .with({ kind: 'balance' }, () => this.onBalance(s))
      .otherwise(() => this.onUnhandled());
  }

  private reply(message: unknown): void {
    this.sender.forEach((sender) => sender.tell(message));
  }

  private async onDeposit(c: DepositCommand): Promise<void> {
    await this.persist({ kind: 'deposited', amount: c.amount },
      (st) => this.reply({ balance: st.balance }));
  }

  private async onWithdraw(s: AccountState, c: WithdrawCommand): Promise<void> {
    if (c.amount > s.balance) { this.reply(new Error('rejected')); return; }
    await this.persist({ kind: 'withdrew', amount: c.amount },
      (st) => this.reply({ balance: st.balance }));
  }

  private async onBalance(s: AccountState): Promise<void> {
    this.reply({ balance: s.balance });
  }

  private async onUnhandled(): Promise<void> {
    this.reply(new Error('rejected'));
  }
}

/* --------------------------- read side -------------------------------- */

type StatementEntry = { seq: number; kind: string; amount: number; runningBalance: number };

class BankStatementLedger {
  /** Per-account ledger of every event the projection has consumed. */
  private readonly entries = new Map<string, StatementEntry[]>();

  record(persistenceId: string, seq: number, ev: AccountEvent): void {
    const list = this.entries.get(persistenceId) ?? [];
    const prev = list.length > 0 ? list[list.length - 1]!.runningBalance : 0;
    const delta = ev.kind === 'deposited' ? ev.amount : -ev.amount;
    list.push({ seq, kind: ev.kind, amount: ev.amount, runningBalance: prev + delta });
    this.entries.set(persistenceId, list);
  }

  print(): void {
    for (const [persistenceId, list] of this.entries) {
      console.log(`\nStatement for ${persistenceId}:`);
      for (const e of list) {
        const sign = e.kind === 'deposited' ? '+' : '-';
        console.log(`  #${e.seq.toString().padStart(2, '0')}  ${sign}${e.amount.toString().padStart(4, ' ')}  → balance ${e.runningBalance}`);
      }
    }
  }
}

/* ------------------------------ main ---------------------------------- */

async function main(): Promise<void> {
  const journal = new InMemoryJournal();
  const ledger = new BankStatementLedger();

  const sysOptions = ActorSystemOptions.create().withPersistence({ journal });
  const sys = ActorSystem.create('bank', sysOptions);

  // Spawn the projection FIRST so it picks up every event from the
  // start of the run.  In production you'd persist the offset (see
  // DurableStateOffsetStore) so a fresh restart resumes mid-stream.
  // `withRecoveryStrategy` is what a handler failure runs into.  The default
  // is `retry-and-fail` — retry, then stop rather than block the read model
  // forever on one bad event.  A statement is better slightly incomplete than
  // frozen at yesterday, so this one skips instead: the offending event goes
  // to the dead-letter stream and `onFailure` names it.
  const projectionOptions = ByTagProjectionOptions.create<AccountEvent>()
    .withName('bank-statement')
    .withQuery(new InMemoryQuery(journal))
    .withOffsetStore(new InMemoryOffsetStore())
    .withTag('account')
    .withRecoveryStrategy('retry-and-skip')
    .withMaxRetries(2)
    .withOnFailure((failure) => {
      console.error(
        `  ! ${failure.projection}: ${failure.event.persistenceId}#${failure.event.sequenceNr} `
        + `failed (attempt ${failure.attempt}) → ${failure.action}`,
        failure.error,
      );
    })
    .withHandle((ev) => {
      ledger.record(ev.persistenceId, ev.sequenceNr, ev.event);
    })
    .withLiveOptions({ pollIntervalMs: 100 });
  const projectionRef = ProjectionActor.byTag<AccountEvent>(sys, projectionOptions);

  // Drive a couple of accounts.
  const alice = sys.spawn(() => new Account('alice'), 'alice');
  const bob = sys.spawn(() => new Account('bob'), 'bob');
  for (const amt of [100, 50, 30]) await alice.ask({ kind: 'deposit', amount: amt }, 500);
  await alice.ask({ kind: 'withdraw', amount: 60 }, 500);
  for (const amt of [200, 75]) await bob.ask({ kind: 'deposit', amount: amt }, 500);
  await bob.ask({ kind: 'withdraw', amount: 25 }, 500);

  // "Drain" here is the projection's own polling batch, not a mailbox — do not
  // mistake it for the wait terminate() now does.  The projection is a
  // `/system` actor reading the journal on a timer, so neither half is
  // something the `/user` drain covers, and it has to finish before the stop
  // on the next line.  Without this the ledger prints empty.
  await Bun.sleep(250);
  projectionRef.stop();
  ledger.print();

  await sys.terminate();
  await journal.close();
}

void main().catch((err) => {
  console.error('projection-bank-statement example failed:', err);
  process.exit(1);
});
