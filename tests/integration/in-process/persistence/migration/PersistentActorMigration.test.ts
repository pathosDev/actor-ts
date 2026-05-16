import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import {
  everyNEvents,
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
  SqliteJournal,
  SqliteSnapshotStore,
} from '../../../../../src/persistence/index.js';
import {
  defaultsAdapter,
  defaultsSnapshotAdapter,
  MigrationChain,
  MigrationError,
  type EventAdapter,
  type SnapshotAdapter,
} from '../../../../../src/persistence/migration/index.js';
import { Props } from '../../../../../src/Props.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/* --------------------------- shared types -------------------------------- */

type Cmd =
  | { kind: 'deposit'; amount: number }
  | { kind: 'balance' };

// Current event = v2 (added `currency`).  v1 was `{ kind, amount }`.
type DepositedV1 = { kind: 'deposited'; amount: number };
type DepositedV2 = { kind: 'deposited'; amount: number; currency: 'USD' | 'EUR' };
type Event = DepositedV2;

// State v2 has `currency` filled (last-seen).
type StateV1 = { balance: number };
type StateV2 = { balance: number; currency: 'USD' | 'EUR' };
type State = StateV2;

class Account extends PersistentActor<Cmd, Event, State> {
  readonly persistenceId: string;
  constructor(pid: string, private readonly seen: unknown[]) {
    super();
    this.persistenceId = pid;
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
  async onCommand(state: State, cmd: Cmd): Promise<void> {
    if (cmd.kind === 'deposit') {
      await this.persist({ kind: 'deposited', amount: cmd.amount, currency: 'EUR' },
        (s) => this.seen.push({ balance: s.balance, currency: s.currency }));
    } else if (cmd.kind === 'balance') {
      this.seen.push({ balance: state.balance, currency: state.currency });
    }
  }
}

function makeSystem(name: string): { system: ActorSystem; journal: InMemoryJournal; snapshots: InMemorySnapshotStore } {
  const system = ActorSystem.create(name, { logger: new NoopLogger(), logLevel: LogLevel.Off });
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
    const ref = system.spawn(Props.create(() => new Account('acct-rt', seen)), 'a');
    ref.tell({ kind: 'deposit', amount: 10 });
    ref.tell({ kind: 'deposit', amount: 5 });
    await sleep(40);

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
    const sys2 = ActorSystem.create('rt2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const ext2 = sys2.extension(PersistenceExtensionId);
    ext2.setJournal(journal);
    ext2.setSnapshotStore(new InMemorySnapshotStore());
    const seen2: unknown[] = [];
    sys2.spawn(Props.create(() => new Account('acct-rt', seen2)), 'a');
    await sleep(40);
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
      { _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 10 } as DepositedV1 },
      { _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 5 } as DepositedV1 },
    ], 0);

    const seen: unknown[] = [];
    system.spawn(Props.create(() => new Account('acct-uc', seen)), 'a');
    await sleep(40);
    // Both events apply — currency defaulted to 'USD' from the adapter.
    expect(seen).toContainEqual({ ready: { balance: 15, currency: 'USD' } });
    await system.terminate();
  });

  test('mixed v1+v2 stream replays in order with per-event upcasting', async () => {
    const { system, journal } = makeSystem('mix');
    await journal.append<unknown>('acct-mix', [
      { _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 10 } },
      { _v: 2, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 5, currency: 'EUR' } },
      { _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 3 } },
    ], 0);

    const seen: unknown[] = [];
    system.spawn(Props.create(() => new Account('acct-mix', seen)), 'a');
    await sleep(40);
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
      { kind: 'deposited', amount: 10 } as DepositedV1,
    ], 0);

    let recovered: unknown = null;
    let recoveryError: Error | null = null;
    class StrictAccount extends Account {
      override onRecoveryFailure(e: Error): void { recoveryError = e; }
      override onRecoveryComplete(s: State): void { recovered = s; }
    }
    system.spawn(Props.create(() => new StrictAccount('acct-strict', [])), 'a');
    await sleep(40);
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
    const ref = system.spawn(Props.create(() => new Account('acct-snap', seen)), 'a');
    // Three deposits → snapshotPolicy fires after seq=2 (and again after seq=4 if reached).
    ref.tell({ kind: 'deposit', amount: 10 });
    ref.tell({ kind: 'deposit', amount: 20 });
    ref.tell({ kind: 'deposit', amount: 30 });
    await sleep(40);

    // Snapshot in store should be wrapped.
    const snap = await snapshots.loadLatest<unknown>('acct-snap');
    expect(snap.isSome()).toBe(true);
    const env = snap.toNullable()!.state as { _v: number; _t: string; _e: StateV2 };
    expect(env._v).toBe(2);
    expect(env._t).toBe('BankAccount.State');
    expect(env._e.balance).toBeGreaterThan(0);
    await system.terminate();

    // Restart — recovery loads the snapshot and continues from there.
    const sys2 = ActorSystem.create('snap2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const ext2 = sys2.extension(PersistenceExtensionId);
    ext2.setJournal(journal);
    ext2.setSnapshotStore(snapshots);
    const seen2: unknown[] = [];
    sys2.spawn(Props.create(() => new Account('acct-snap', seen2)), 'a');
    await sleep(40);
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
    system.spawn(Props.create(() => new Account('acct-snap-uc', seen)), 'a');
    await sleep(40);
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

  class CentsAccount extends PersistentActor<Cmd, DepositedV3, ChainState> {
    readonly persistenceId: string;
    constructor(pid: string, private readonly seen: unknown[]) { super(); this.persistenceId = pid; }
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
    async onCommand(_state: ChainState, _cmd: Cmd): Promise<void> { /* not exercised */ }
  }

  test('v1 → v2 → v3 chain converts amount to cents on recovery', async () => {
    const { system, journal } = makeSystem('chain');
    await journal.append<unknown>('acct-chain', [
      { _v: 1, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 1 } },
      { _v: 2, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', amount: 2, currency: 'EUR' } },
      { _v: 3, _t: 'BankAccount.Deposited', _e: { kind: 'deposited', cents: 250, currency: 'USD' } },
    ], 0);
    const seen: unknown[] = [];
    system.spawn(Props.create(() => new CentsAccount('acct-chain', seen)), 'a');
    await sleep(40);
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
    const journal = new SqliteJournal({ path });
    const snapshots = new SqliteSnapshotStore({ path });
    const system = ActorSystem.create('sqlite-mig', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const ext = system.extension(PersistenceExtensionId);
    ext.setJournal(journal);
    ext.setSnapshotStore(snapshots);

    const seen: unknown[] = [];
    const ref = system.spawn(Props.create(() => new Account('acct-sql', seen)), 'a');
    ref.tell({ kind: 'deposit', amount: 7 });
    ref.tell({ kind: 'deposit', amount: 13 });
    await sleep(40);
    await system.terminate();
    await journal.close();
    await snapshots.close();

    // Reopen on the SAME files — recovery must succeed.
    const journal2 = new SqliteJournal({ path });
    const snapshots2 = new SqliteSnapshotStore({ path });
    const sys2 = ActorSystem.create('sqlite-mig-2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    sys2.extension(PersistenceExtensionId).setJournal(journal2);
    sys2.extension(PersistenceExtensionId).setSnapshotStore(snapshots2);
    const seen2: unknown[] = [];
    sys2.spawn(Props.create(() => new Account('acct-sql', seen2)), 'a');
    await sleep(40);
    expect(seen2).toContainEqual({ ready: { balance: 20, currency: 'EUR' } });
    await sys2.terminate();
    await journal2.close();
    await snapshots2.close();
  });
});

/* ----------------------- 7. No-adapter regression ----------------------- */

describe('PersistentActor — no-adapter regression', () => {
  test('actor without adapter behaves identically to pre-migration code', async () => {
    type RawEvent = { kind: 'deposited'; amount: number };
    type RawState = { balance: number };
    class RawAccount extends PersistentActor<Cmd, RawEvent, RawState> {
      readonly persistenceId = 'acct-raw';
      constructor(private readonly seen: unknown[]) { super(); }
      initialState(): RawState { return { balance: 0 }; }
      onEvent(s: RawState, e: RawEvent): RawState { return { balance: s.balance + e.amount }; }
      override onRecoveryComplete(s: RawState): void { this.seen.push({ ready: s }); }
      async onCommand(_s: RawState, cmd: Cmd): Promise<void> {
        if (cmd.kind === 'deposit') {
          await this.persist({ kind: 'deposited', amount: cmd.amount });
        }
      }
    }
    const { system, journal } = makeSystem('raw');
    const seen: unknown[] = [];
    const ref = system.spawn(Props.create(() => new RawAccount(seen)), 'r');
    ref.tell({ kind: 'deposit', amount: 4 });
    await sleep(40);
    // Verify journal stored a raw event (no _v/_t/_e).
    const stored = await journal.read<unknown>('acct-raw', 1);
    expect(stored[0]!.event).toEqual({ kind: 'deposited', amount: 4 });
    await system.terminate();
  });
});
