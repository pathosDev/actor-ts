/**
 * In-process schema registry demo (#6).
 *
 *   bun run examples/persistence/schema-registry.ts
 *
 * Shows how to:
 *
 *   1. Build a registry that owns several versions of a domain
 *      type (`BankAccount.Deposited` v1 → v2 → v3 here).
 *   2. Validate every payload at write + read time via codecs
 *      (using a hand-rolled validator stand-in for Zod — bring
 *      your own dependency in real apps).
 *   3. Hand the resulting `EventAdapter` to a `PersistentActor` via
 *      `eventAdapter()` so the actor speaks the latest version
 *      while replaying anything older.
 *
 * The same `Codec<T>` can be plugged into `validatedEventAdapter`
 * for cases where you want validation **without** the registry —
 * e.g. you already use `defaultsAdapter` and just want shape
 * checks layered on top.
 */
import {
  Actor,
  ActorSystem,
  Props,
  ask,
  PersistenceExtensionId,
  PersistentActor,
  InMemorySchemaRegistry,
  InMemoryJournal,
  zodCodec,
  type ParserLike,
} from '../../src/index.js';

/* ------------------- Domain types (three versions) ------------------- */

interface DepositedV1 { kind: 'deposited'; amount: number }
interface DepositedV2 extends DepositedV1 { currency: 'USD' | 'EUR' }
interface DepositedV3 { kind: 'deposited'; cents: number; currency: 'USD' | 'EUR' }

const v1Schema: ParserLike<DepositedV1> = {
  parse(input) {
    const o = input as DepositedV1;
    if (o.kind !== 'deposited') throw new Error('expected kind=deposited');
    if (typeof o.amount !== 'number' || o.amount < 0) throw new Error('bad amount');
    return { kind: 'deposited', amount: o.amount };
  },
};
const v2Schema: ParserLike<DepositedV2> = {
  parse(input) {
    const o = input as DepositedV2;
    if (o.kind !== 'deposited') throw new Error('expected kind=deposited');
    if (typeof o.amount !== 'number' || o.amount < 0) throw new Error('bad amount');
    if (o.currency !== 'USD' && o.currency !== 'EUR') throw new Error('bad currency');
    return { kind: 'deposited', amount: o.amount, currency: o.currency };
  },
};
const v3Schema: ParserLike<DepositedV3> = {
  parse(input) {
    const o = input as DepositedV3;
    if (o.kind !== 'deposited') throw new Error('expected kind=deposited');
    if (typeof o.cents !== 'number' || !Number.isInteger(o.cents) || o.cents < 0) {
      throw new Error('bad cents');
    }
    if (o.currency !== 'USD' && o.currency !== 'EUR') throw new Error('bad currency');
    return o;
  },
};

/* ------------------------- Registry setup ------------------------- */

const registry = new InMemorySchemaRegistry();
registry.register('BankAccount.Deposited', 1, { codec: zodCodec(v1Schema, 'deposited-v1') });
registry.register('BankAccount.Deposited', 2, {
  codec: zodCodec(v2Schema, 'deposited-v2'),
  compatibility: 'sample',
  sample: { kind: 'deposited', amount: 100 },
  upcastFromPrev: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }),
});
registry.register('BankAccount.Deposited', 3, {
  codec: zodCodec(v3Schema, 'deposited-v3'),
  compatibility: 'sample',
  sample: { kind: 'deposited', amount: 100, currency: 'USD' },
  upcastFromPrev: (v: DepositedV2): DepositedV3 => ({
    kind: v.kind, cents: v.amount * 100, currency: v.currency,
  }),
});

/* --------------------------- Actor ----------------------------- */

interface AccountState { cents: number; currency: 'USD' | 'EUR' | '' }

class Account extends PersistentActor<{ kind: 'deposit'; cents: number }, DepositedV3, AccountState> {
  readonly persistenceId = 'account-1';

  override eventAdapter() { return registry.eventAdapter<DepositedV3>('BankAccount.Deposited'); }

  initialState(): AccountState { return { cents: 0, currency: '' }; }
  onEvent(s: AccountState, e: DepositedV3): AccountState {
    return { cents: s.cents + e.cents, currency: e.currency };
  }
  async onCommand(_s: AccountState, c: { kind: 'deposit'; cents: number }): Promise<void> {
    if (c.kind === 'deposit') {
      await this.persist({ kind: 'deposited', cents: c.cents, currency: 'USD' });
    }
    this.sender.toNullable()?.tell(this.state);
  }
}

/* --------------------------- Main ------------------------------ */

async function main(): Promise<void> {
  const sys = ActorSystem.create('schema-registry-demo');
  const journal = new InMemoryJournal();
  sys.extension(PersistenceExtensionId).setJournal(journal);

  // Pre-seed the journal with a v1-shaped event (representing data
  // written before the schema evolved) — wrapped in the standard
  // envelope so the adapter sees it.
  await journal.append('account-1', [{
    _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 50 },
  }], 0);

  const ref = sys.actorOf(Props.create(() => new Account()), 'acct');
  // Recovery: replays the v1 event through the registry's upcasters
  // (v1 → v2 fills currency=USD, v2 → v3 multiplies amount × 100).
  let state = await ask<unknown, AccountState>(ref, { kind: 'deposit', cents: 750 }, 1_000);
  console.log('after deposit:', state);

  state = await ask<unknown, AccountState>(ref, { kind: 'deposit', cents: 250 }, 1_000);
  console.log('after deposit:', state);

  await sys.terminate();
}

void main();
