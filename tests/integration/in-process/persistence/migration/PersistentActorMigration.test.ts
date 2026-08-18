import { match } from 'ts-pattern';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import {
  everyNEvents,
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
  SqliteJournal,
  SqliteJournalOptions,
  SqliteSnapshotStore,
  SqliteSnapshotStoreOptions,
} from '../../../../../src/persistence/index.js';
import {
  defaultsAdapter,
  defaultsSnapshotAdapter,
  InMemorySchemaRegistry,
  MigrationChain,
  MigrationError,
  zodCodec,
  type EventAdapter,
  type ParserLike,
  type SnapshotAdapter,
} from '../../../../../src/persistence/migration/index.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

/* --------------------------- shared types -------------------------------- */

type DepositCommand = { kind: 'deposit'; amount: number };
type BalanceCommand = { kind: 'balance' };

type Command = DepositCommand | BalanceCommand;

// Current event = v2 (added `currency`).  v1 was `{ kind, amount }`.
type DepositedV1 = { kind: 'deposited'; amount: number };
type DepositedV2 = { kind: 'deposited'; amount: number; currency: 'USD' | 'EUR' };
type Event = DepositedV2;

// State v2 has `currency` filled (last-seen).
type StateV1 = { balance: number };
type StateV2 = { balance: number; currency: 'USD' | 'EUR' };
type State = StateV2;

class Account extends PersistentActor<Command, Event, State> {
  readonly persistenceId: string;
  constructor(persistenceId: string, private readonly seen: unknown[]) {
    super();
    this.persistenceId = persistenceId;
  }
  initialState(): State { return { balance: 0, currency: 'USD' }; }
  onEvent(s: State, e: Event): State {
    if (e.kind === 'deposited') return { balance: s.balance + e.amount, currency: e.currency };
    return s;
  }
  override onRecoveryComplete(s: State): void { this.seen.push({ ready: s }); }
  override eventAdapter(): EventAdapter<Event> {
    return defaultsAdapter<DepositedV2>({
      manifest: 'BankAccount.Deposited',
      currentVersion: 2,
      defaults: { 1: { currency: 'USD' } },
    });
  }
  override snapshotAdapter(): SnapshotAdapter<State> {
    return defaultsSnapshotAdapter<StateV2>({
      manifest: 'BankAccount.State',
      currentVersion: 2,
      defaults: { 1: { currency: 'USD' } },
    });
  }
  override snapshotPolicy() { return everyNEvents<State, Event>(2); }
  async onCommand(state: State, command: Command): Promise<void> {
    await match(command)
      .with({ kind: 'deposit' }, (c) => this.onDeposit(c))
      .with({ kind: 'balance' }, () => this.onBalance(state))
      .exhaustive();
  }

  private async onDeposit(command: DepositCommand): Promise<void> {
    await this.persist({ kind: 'deposited', amount: command.amount, currency: 'EUR' },
      (s) => { this.seen.push({ balance: s.balance, currency: s.currency }); });
  }

  private onBalance(state: State): void {
    this.seen.push({ balance: state.balance, currency: state.currency });
  }
}

function makeSystem(name: string): { system: ActorSystem; journal: InMemoryJournal; snapshots: InMemorySnapshotStore } {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  const journal = new InMemoryJournal();
  const snapshots = new InMemorySnapshotStore();
  const ext = system.extension(PersistenceExtensionId);
  ext.setJournal(journal);
  ext.setSnapshotStore(snapshots);
  return { system, journal, snapshots };
}

/* ----------------------- 1. Round-trip with adapter ---------------------- */

describe('PersistentActor — adapter round-trip', () => {
  test('writes envelopes to journal and recovers state correctly', async () => {
    const { system, journal } = makeSystem('rt');
    const seen: unknown[] = [];
    const ref = system.spawn(() => new Account('acct-rt', seen), 'a');
    ref.tell({ kind: 'deposit', amount: 10 });
    ref.tell({ kind: 'deposit', amount: 5 });
    await awaitCondition(async () => (await journal.read<unknown>('acct-rt', 1)).length === 2, {
      label: 'both deposit envelopes reached the journal',
    });

    // Inspect what landed in the journal — should be envelopes, not raw events.
    const stored = await journal.read<unknown>('acct-rt', 1);
    expect(stored.length).toBe(2);
    for (const ev of stored) {
      const env = ev.event as { _v: number; _t: string; _e: unknown };
      expect(env._v).toBe(2);
      expect(env._t).toBe('BankAccount.Deposited');
      expect((env._e as DepositedV2).currency).toBe('EUR');
    }
    await system.terminate();

    // Restart on the same journal — recovery up-casts envelopes through the adapter.
    const sys2Options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys2 = ActorSystem.create('rt2', sys2Options);
    const ext2 = sys2.extension(PersistenceExtensionId);
    ext2.setJournal(journal);
    ext2.setSnapshotStore(new InMemorySnapshotStore());
    const seen2: unknown[] = [];
    sys2.spawn(() => new Account('acct-rt', seen2), 'a');
    await awaitCondition(() => seen2.length > 0, { label: 'restarted actor completed recovery' });
    expect(seen2).toContainEqual({ ready: { balance: 15, currency: 'EUR' } });
    await sys2.terminate();
  });
});

/* ----------------------- 2. Up-cast v1 → v2 ----------------------------- */

describe('PersistentActor — v1 → v2 upcast on recovery', () => {
  test('legacy v1 envelopes are up-cast through the adapter', async () => {
    const { system, journal } = makeSystem('uc');
    // Pre-populate journal with v1 envelopes (no currency).
    await journal.append<unknown>('acct-uc', [
      { event: { _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 10 } as DepositedV1 } },
      { event: { _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 5 } as DepositedV1 } },
    ], 0);

    const seen: unknown[] = [];
    system.spawn(() => new Account('acct-uc', seen), 'a');
    await awaitCondition(() => seen.length > 0, { label: 'recovery from the v1 envelopes completed' });
    // Both events apply — currency defaulted to 'USD' from the adapter.
    expect(seen).toContainEqual({ ready: { balance: 15, currency: 'USD' } });
    await system.terminate();
  });

  test('mixed v1+v2 stream replays in order with per-event upcasting', async () => {
    const { system, journal } = makeSystem('mix');
    await journal.append<unknown>('acct-mix', [
      { event: { _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 10 } } },
      { event: { _v: 2, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 5, currency: 'EUR' } } },
      { event: { _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 3 } } },
    ], 0);

    const seen: unknown[] = [];
    system.spawn(() => new Account('acct-mix', seen), 'a');
    await awaitCondition(() => seen.length > 0, { label: 'recovery from the mixed v1+v2 stream completed' });
    // 10 (USD) + 5 (EUR) + 3 (USD) = 18, last-seen currency = 'USD'.
    expect(seen).toContainEqual({ ready: { balance: 18, currency: 'USD' } });
    await system.terminate();
  });
});

/* ----------------------- 3. Strict mode (raw events) -------------------- */

describe('PersistentActor — strict mode', () => {
  test('adapter active + raw event in journal throws MigrationError', async () => {
    const { system, journal } = makeSystem('strict');
    // Pre-populate with a RAW v1 event (no envelope) — what bare-bones older
    // apps would have on disk before adopting the adapter.
    await journal.append<unknown>('acct-strict', [
      { event: { kind: 'deposited', amount: 10 } as DepositedV1 },
    ], 0);

    let recovered: unknown = null;
    let recoveryError: Error | null = null;
    class StrictAccount extends Account {
      override onRecoveryFailure(e: Error): void { recoveryError = e; }
      override onRecoveryComplete(s: State): void { recovered = s; }
    }
    system.spawn(() => new StrictAccount('acct-strict', []), 'a');
    await awaitCondition(() => recoveryError !== null, {
      label: 'strict-mode recovery reported a failure',
    });
    expect(recovered).toBeNull();
    expect(recoveryError).toBeInstanceOf(MigrationError);
    expect((recoveryError as unknown as Error).message).toContain('expected envelope');
    await system.terminate();
  });
});

/* ----------------------- 4. Snapshot adapter --------------------------- */

describe('PersistentActor — snapshot adapter', () => {
  test('saves snapshot envelope and recovers from it', async () => {
    const { system, journal, snapshots } = makeSystem('snap');
    const seen: unknown[] = [];
    const ref = system.spawn(() => new Account('acct-snap', seen), 'a');
    // Three deposits → snapshotPolicy fires after seq=2 (and again after seq=4 if reached).
    ref.tell({ kind: 'deposit', amount: 10 });
    ref.tell({ kind: 'deposit', amount: 20 });
    ref.tell({ kind: 'deposit', amount: 30 });
    // Two conditions, because the restart below asserts the *full* balance of
    // 60: every deposit has to be journalled, and the policy's snapshot has to
    // have been stored.  Either one alone can hold while the other is pending.
    await awaitCondition(
      async () => (await journal.read<unknown>('acct-snap', 1)).length === 3
        && (await snapshots.loadLatest<unknown>('acct-snap')).isSome(),
      { label: 'all three deposits journalled and a snapshot stored' },
    );

    // Snapshot in store should be wrapped.
    const snap = await snapshots.loadLatest<unknown>('acct-snap');
    expect(snap.isSome()).toBe(true);
    const env = snap.toNullable()!.state as { _v: number; _t: string; _e: StateV2 };
    expect(env._v).toBe(2);
    expect(env._t).toBe('BankAccount.State');
    expect(env._e.balance).toBeGreaterThan(0);
    await system.terminate();

    // Restart — recovery loads the snapshot and continues from there.
    const sys2Options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys2 = ActorSystem.create('snap2', sys2Options);
    const ext2 = sys2.extension(PersistenceExtensionId);
    ext2.setJournal(journal);
    ext2.setSnapshotStore(snapshots);
    const seen2: unknown[] = [];
    sys2.spawn(() => new Account('acct-snap', seen2), 'a');
    await awaitCondition(() => seen2.length > 0, { label: 'restarted actor recovered from the snapshot' });
    expect(seen2).toContainEqual({ ready: { balance: 60, currency: 'EUR' } });
    await sys2.terminate();
  });

  test('legacy v1 snapshot envelope upcasts via defaults adapter', async () => {
    const { system, snapshots } = makeSystem('snap-uc');
    // Pre-populate snapshot at seq=10 with a v1 state envelope.
    await snapshots.save<unknown>('acct-snap-uc', 10, {
      _v: 1, _t: 'BankAccount.State', _e: { balance: 999 } as StateV1,
    });
    const seen: unknown[] = [];
    system.spawn(() => new Account('acct-snap-uc', seen), 'a');
    await awaitCondition(() => seen.length > 0, { label: 'recovery from the v1 snapshot envelope completed' });
    expect(seen).toContainEqual({ ready: { balance: 999, currency: 'USD' } });
    await system.terminate();
  });
});

/* ----------------------- 5. MigrationChain end-to-end ------------------- */

describe('PersistentActor — MigrationChain non-additive', () => {
  // v3 renames `amount` → `cents` (stored in cents).  This is the
  // non-additive case — defaultsAdapter doesn't help.
  type DepositedV3 = { kind: 'deposited'; cents: number; currency: 'USD' | 'EUR' };
  type ChainState = { balanceCents: number; currency: 'USD' | 'EUR' };

  class CentsAccount extends PersistentActor<Command, DepositedV3, ChainState> {
    readonly persistenceId: string;
    constructor(persistenceId: string, private readonly seen: unknown[]) { super(); this.persistenceId = persistenceId; }
    initialState(): ChainState { return { balanceCents: 0, currency: 'USD' }; }
    onEvent(s: ChainState, e: DepositedV3): ChainState {
      return { balanceCents: s.balanceCents + e.cents, currency: e.currency };
    }
    override onRecoveryComplete(s: ChainState): void { this.seen.push({ ready: s }); }
    override eventAdapter(): EventAdapter<DepositedV3> {
      const chain = MigrationChain.for<DepositedV3>('BankAccount.Deposited', 3)
        .add({ fromVersion: 1, toVersion: 2,
               upcast: (v: DepositedV1): DepositedV2 => ({ ...v, currency: 'USD' }) })
        .add({ fromVersion: 2, toVersion: 3,
               upcast: (v: DepositedV2): DepositedV3 => ({ kind: v.kind, cents: v.amount * 100, currency: v.currency }) });
      return {
        manifest: () => 'BankAccount.Deposited',
        toJournal: (e) => ({ manifest: 'BankAccount.Deposited', version: 3, payload: e }),
        fromJournal: (s) => chain.upcast(s),
      };
    }
    async onCommand(_state: ChainState, _command: Command): Promise<void> { /* not exercised */ }
  }

  test('v1 → v2 → v3 chain converts amount to cents on recovery', async () => {
    const { system, journal } = makeSystem('chain');
    await journal.append<unknown>('acct-chain', [
      { event: { _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 1 } } },
      { event: { _v: 2, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 2, currency: 'EUR' } } },
      { event: { _v: 3, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', cents: 250, currency: 'USD' } } },
    ], 0);
    const seen: unknown[] = [];
    system.spawn(() => new CentsAccount('acct-chain', seen), 'a');
    await awaitCondition(() => seen.length > 0, { label: 'recovery through the v1→v2→v3 chain completed' });
    // 100 (USD) + 200 (EUR) + 250 (USD) = 550 cents, last currency 'USD'.
    expect(seen).toContainEqual({ ready: { balanceCents: 550, currency: 'USD' } });
    await system.terminate();
  });
});

/* ----------------------- 6. SQLite end-to-end --------------------------- */

describe('PersistentActor — SQLite e2e with adapter', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'actor-ts-mig-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('JSON.stringify round-trip preserves envelope structure', async () => {
    const path = join(dir, 'mig.db');
    const journalOptions = SqliteJournalOptions.create()
      .withPath(path);
    const journal = new SqliteJournal(journalOptions);
    const snapshotStoreOptions = SqliteSnapshotStoreOptions.create()
      .withPath(path);
    const snapshots = new SqliteSnapshotStore(snapshotStoreOptions);
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('sqlite-mig', systemOptions);
    const ext = system.extension(PersistenceExtensionId);
    ext.setJournal(journal);
    ext.setSnapshotStore(snapshots);

    const seen: unknown[] = [];
    const ref = system.spawn(() => new Account('acct-sql', seen), 'a');
    ref.tell({ kind: 'deposit', amount: 7 });
    ref.tell({ kind: 'deposit', amount: 13 });
    await awaitCondition(async () => (await journal.read<unknown>('acct-sql', 1)).length === 2, {
      label: 'both deposits reached the SQLite journal',
    });
    await system.terminate();
    await journal.close();
    await snapshots.close();

    // Reopen on the SAME files — recovery must succeed.
    const journal2Options = SqliteJournalOptions.create()
      .withPath(path);
    const journal2 = new SqliteJournal(journal2Options);
    const snapshots2Options = SqliteSnapshotStoreOptions.create()
      .withPath(path);
    const snapshots2 = new SqliteSnapshotStore(snapshots2Options);
    const sys2Options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys2 = ActorSystem.create('sqlite-mig-2', sys2Options);
    sys2.extension(PersistenceExtensionId).setJournal(journal2);
    sys2.extension(PersistenceExtensionId).setSnapshotStore(snapshots2);
    const seen2: unknown[] = [];
    sys2.spawn(() => new Account('acct-sql', seen2), 'a');
    await awaitCondition(() => seen2.length > 0, { label: 'reopened SQLite journal replayed into recovery' });
    expect(seen2).toContainEqual({ ready: { balance: 20, currency: 'EUR' } });
    await sys2.terminate();
    await journal2.close();
    await snapshots2.close();
  });
});

/* ------------- 7. Registry adapter refuses a foreign manifest ----------- */

describe('PersistentActor — registry adapter on a foreign manifest', () => {
  type ClosedV1 = { kind: 'closed'; reason: string };
  type RegistryEvent = DepositedV1 | ClosedV1;
  type RegistryState = { balance: number; closed: boolean };

  const depositedSchema: ParserLike<DepositedV1> = {
    parse(input: unknown) {
      const typedInput = input as DepositedV1;
      if (typedInput.kind !== 'deposited' || typeof typedInput.amount !== 'number') throw new Error('bad deposited');
      return { kind: 'deposited', amount: typedInput.amount };
    },
  };
  const closedSchema: ParserLike<ClosedV1> = {
    parse(input: unknown) {
      const typedInput = input as ClosedV1;
      if (typedInput.kind !== 'closed' || typeof typedInput.reason !== 'string') throw new Error('bad closed');
      return { kind: 'closed', reason: typedInput.reason };
    },
  };

  /**
   * One registry holding both event types — the shape that makes the defect
   * reachable.  A journal row tagged `Account.Closed` is fully readable *by the
   * registry*, so nothing except the adapter's own manifest compare can refuse
   * it; before #737 it folded into the actor as if it were a Deposited.
   */
  function twoTypeRegistry(): InMemorySchemaRegistry {
    const registry = new InMemorySchemaRegistry();
    registry.register('Account.Deposited', 1, { codec: zodCodec(depositedSchema) });
    registry.register('Account.Closed', 1, { codec: zodCodec(closedSchema) });
    return registry;
  }

  class RegistryAccount extends PersistentActor<Command, RegistryEvent, RegistryState> {
    readonly persistenceId: string;
    constructor(
      persistenceId: string,
      private readonly registry: InMemorySchemaRegistry,
      private readonly seen: unknown[],
      private readonly failures: Error[],
    ) {
      super();
      this.persistenceId = persistenceId;
    }
    initialState(): RegistryState { return { balance: 0, closed: false }; }
    onEvent(s: RegistryState, e: RegistryEvent): RegistryState {
      return e.kind === 'deposited'
        ? { ...s, balance: s.balance + e.amount }
        : { ...s, closed: true };
    }
    override onRecoveryComplete(s: RegistryState): void { this.seen.push({ ready: s }); }
    override onRecoveryFailure(e: Error): void { this.failures.push(e); }
    override eventAdapter(): EventAdapter<RegistryEvent> {
      return this.registry.eventAdapter<RegistryEvent>('Account.Deposited');
    }
    async onCommand(_state: RegistryState, _command: Command): Promise<void> { /* not exercised */ }
  }

  test('a journal row tagged with another registered manifest fails recovery', async () => {
    const { system, journal } = makeSystem('registry-foreign');
    // A legitimate row, then one whose `_t` names the *other* registered type.
    // Both are valid under their own codec, so the second is refused for its
    // manifest alone — nothing else in the read path objects to it.
    await journal.append<unknown>('acct-foreign', [
      { event: { _v: 1, _t: 'Account.Deposited', _e: { kind: 'deposited', amount: 10 } } },
      { event: { _v: 1, _t: 'Account.Closed', _e: { kind: 'closed', reason: 'fraud' } } },
    ], 0);

    const seen: unknown[] = [];
    const failures: Error[] = [];
    system.spawn(() => new RegistryAccount('acct-foreign', twoTypeRegistry(), seen, failures), 'a');
    // Wait for recovery to settle *either* way rather than for the failure
    // alone: a permissive read path completes recovery instead of failing, and
    // polling only for `failures` would turn that into a timeout whose message
    // says nothing about what went wrong.  This way the assertions below name
    // the actual outcome.
    await awaitCondition(() => failures.length > 0 || seen.length > 0, {
      label: 'recovery over the foreign-manifest row settled',
    });
    // The decisive half: recovery must NOT have completed, because completing
    // means the Closed row was folded into state through a Deposited-typed
    // adapter.  Without the guard this holds `{ ready: { balance: 10, closed:
    // true } }` — the type confusion, end to end.
    expect(seen).toEqual([]);
    expect(failures[0]).toBeInstanceOf(MigrationError);
    expect(failures[0]!.message).toContain('manifest mismatch');
    expect(failures[0]!.message).toContain("got 'Account.Closed'");
    await system.terminate();
  });

  test('the same actor recovers normally when every row carries its own manifest', async () => {
    const { system, journal } = makeSystem('registry-own');
    // The inverse, on the identical wiring: a guard that refused every frame,
    // or one that compared the wrong side, would break this too.
    await journal.append<unknown>('acct-own', [
      { event: { _v: 1, _t: 'Account.Deposited', _e: { kind: 'deposited', amount: 10 } } },
      { event: { _v: 1, _t: 'Account.Deposited', _e: { kind: 'deposited', amount: 5 } } },
    ], 0);

    const seen: unknown[] = [];
    const failures: Error[] = [];
    system.spawn(() => new RegistryAccount('acct-own', twoTypeRegistry(), seen, failures), 'a');
    await awaitCondition(() => seen.length > 0, {
      label: 'recovery from the same-manifest rows completed',
    });
    expect(failures).toEqual([]);
    expect(seen).toContainEqual({ ready: { balance: 15, closed: false } });
    await system.terminate();
  });
});

/* ----------------------- 8. No-adapter regression ----------------------- */

describe('PersistentActor — no-adapter regression', () => {
  test('actor without adapter behaves identically to pre-migration code', async () => {
    type RawEvent = { kind: 'deposited'; amount: number };
    type RawState = { balance: number };
    class RawAccount extends PersistentActor<Command, RawEvent, RawState> {
      readonly persistenceId = 'acct-raw';
      constructor(private readonly seen: unknown[]) { super(); }
      initialState(): RawState { return { balance: 0 }; }
      onEvent(s: RawState, e: RawEvent): RawState { return { balance: s.balance + e.amount }; }
      override onRecoveryComplete(s: RawState): void { this.seen.push({ ready: s }); }
      async onCommand(_s: RawState, command: Command): Promise<void> {
        if (command.kind === 'deposit') {
          await this.persist({ kind: 'deposited', amount: command.amount });
        }
      }
    }
    const { system, journal } = makeSystem('raw');
    const seen: unknown[] = [];
    const ref = system.spawn(() => new RawAccount(seen), 'r');
    ref.tell({ kind: 'deposit', amount: 4 });
    await awaitCondition(async () => (await journal.read<unknown>('acct-raw', 1)).length === 1, {
      label: 'the raw event reached the journal',
    });
    // Verify journal stored a raw event (no _v/_t/_e).
    const stored = await journal.read<unknown>('acct-raw', 1);
    expect(stored[0]!.event).toEqual({ kind: 'deposited', amount: 4 });
    await system.terminate();
  });
});
