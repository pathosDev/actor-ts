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
 *
 *   bun run examples/persistence/projection-bank-statement.ts
 */
import { match, P } from 'ts-pattern';
import {
  ActorSystem,
  ask,
  everyNEvents,
  InMemoryJournal,
  InMemoryOffsetStore,
  InMemoryQuery,
  PersistentActor,
  ProjectionActor,
  Props,
} from '../../src/index.js';

/* --------------------------- write side ------------------------------- */

type AccountCmd =
  | { kind: 'deposit'; amount: number }
  | { kind: 'withdraw'; amount: number }
  | { kind: 'balance' };

type AccountEvent =
  | { kind: 'deposited'; amount: number }
  | { kind: 'withdrew'; amount: number };

interface AccountState { balance: number }

class Account extends PersistentActor<AccountCmd, AccountEvent, AccountState> {
  constructor(readonly persistenceId: string) { super(); }
  initialState(): AccountState { return { balance: 0 }; }
  onEvent(s: AccountState, e: AccountEvent): AccountState {
    return match(e)
      .with({ kind: 'deposited' }, (d) => ({ balance: s.balance + d.amount }))
      .with({ kind: 'withdrew' }, (d) => ({ balance: s.balance - d.amount }))
      .exhaustive();
  }
  /** Tag every event so the projection can find them by tag. */
  override tagsFor(_e: AccountEvent): readonly string[] { return ['account']; }
  snapshotPolicy() { return everyNEvents<AccountState, AccountEvent>(5); }

  async onCommand(s: AccountState, cmd: AccountCmd): Promise<void> {
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
      .otherwise(async () => reply(new Error('rejected')));
  }
}

/* --------------------------- read side -------------------------------- */

interface StatementEntry { seq: number; kind: string; amount: number; runningBalance: number }

class BankStatementLedger {
  /** Per-account ledger of every event the projection has consumed. */
  private readonly entries = new Map<string, StatementEntry[]>();

  record(pid: string, seq: number, ev: AccountEvent): void {
    const list = this.entries.get(pid) ?? [];
    const prev = list.length > 0 ? list[list.length - 1]!.runningBalance : 0;
    const delta = ev.kind === 'deposited' ? ev.amount : -ev.amount;
    list.push({ seq, kind: ev.kind, amount: ev.amount, runningBalance: prev + delta });
    this.entries.set(pid, list);
  }

  print(): void {
    for (const [pid, list] of this.entries) {
      console.log(`\nStatement for ${pid}:`);
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

  const sys = ActorSystem.create('bank', { persistence: { journal } });

  // Spawn the projection FIRST so it picks up every event from the
  // start of the run.  In production you'd persist the offset (see
  // DurableStateOffsetStore) so a fresh restart resumes mid-stream.
  const projectionRef = ProjectionActor.byTag<AccountEvent>(sys, {
    name: 'bank-statement',
    query: new InMemoryQuery(journal),
    offsetStore: new InMemoryOffsetStore(),
    tag: 'account',
    handle: (ev) => {
      ledger.record(ev.persistenceId, ev.sequenceNr, ev.event);
    },
    liveOptions: { pollIntervalMs: 100 },
  });

  // Drive a couple of accounts.
  const alice = sys.spawn(Props.create(() => new Account('alice')), 'alice');
  const bob = sys.spawn(Props.create(() => new Account('bob')), 'bob');
  for (const amt of [100, 50, 30]) await ask(alice, { kind: 'deposit', amount: amt }, 500);
  await ask(alice, { kind: 'withdraw', amount: 60 }, 500);
  for (const amt of [200, 75]) await ask(bob, { kind: 'deposit', amount: amt }, 500);
  await ask(bob, { kind: 'withdraw', amount: 25 }, 500);

  // Give the projection a beat to drain the last batch.
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
