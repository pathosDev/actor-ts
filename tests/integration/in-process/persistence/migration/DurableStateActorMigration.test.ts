import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Props } from '../../../../../src/Props.js';
import {
  DurableStateActor,
  DurableStateOptions,
  InMemoryDurableStateStore,
  type DurableStateStore,
} from '../../../../../src/persistence/index.js';
import {
  defaultsSnapshotAdapter,
  MigrationError,
  type StateAdapter,
} from '../../../../../src/persistence/migration/index.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import type { Actor } from '../../../../../src/Actor.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/* ----------------------------- Domain ----------------------------------- */

type StateV1 = { balance: number };
type StateV2 = { balance: number; currency: 'USD' | 'EUR' };
type State = StateV2;

type Cmd =
  | { kind: 'deposit'; amount: number; replyTo: ActorRef }
  | { kind: 'state'; replyTo: ActorRef };

const stateAdapter = (): StateAdapter<State> => defaultsSnapshotAdapter<StateV2>({
  manifest: 'KV.State',
  currentVersion: 2,
  defaults: { 1: { currency: 'USD' } },
});

class Account extends DurableStateActor<Cmd, State> {
  protected override stateAdapter(): StateAdapter<State> { return stateAdapter(); }
  override async onCommand(cmd: Cmd): Promise<void> {
    if (cmd.kind === 'deposit') {
      const next: State = { balance: this.state.balance + cmd.amount, currency: 'EUR' };
      await this.persist(next);
      cmd.replyTo.tell({ ok: this.revision } as never);
      return;
    }
    cmd.replyTo.tell({ ...this.state } as never);
  }
}

class StrictAccount extends Account {
  recoveryError: Error | null = null;
  override async preStart(): Promise<void> {
    try { await super.preStart(); }
    catch (e) { this.recoveryError = e as Error; }
  }
}

const props = (store: DurableStateStore, id: string, ctor: typeof Account = Account): Props<Cmd> =>
  Props.create(() => new ctor(
    DurableStateOptions.create<State>()
      .withPersistenceId(id)
      .withStore(store)
      .withEmptyState((): State => ({ balance: 0, currency: 'USD' })),
  ) as unknown as Actor<Cmd>);

/* ----------------------------- Tests ------------------------------------ */

describe('DurableStateActor — adapter round-trip', () => {
  test('upsert wraps state in envelope; load unwraps it', async () => {
    const store = new InMemoryDurableStateStore();
    const sys = ActorSystem.create('ds-rt', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = makeProbe(sys);
    const ref = sys.spawn(props(store, 'acct'), 'a');
    ref.tell({ kind: 'deposit', amount: 50, replyTo: probe.ref });
    await sleep(30);

    // Wire format: store should hold an envelope.
    const raw = await store.load<unknown>('acct');
    expect(raw.isSome()).toBe(true);
    const env = raw.toNullable()!.state as { _v: number; _t: string; _e: StateV2 };
    expect(env._v).toBe(2);
    expect(env._t).toBe('KV.State');
    expect(env._e.balance).toBe(50);
    expect(env._e.currency).toBe('EUR');
    await sys.terminate();
  });

  test('restart with adapter recovers current-version state', async () => {
    const store = new InMemoryDurableStateStore();
    const sys = ActorSystem.create('ds-restart', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = makeProbe(sys);
    const ref = sys.spawn(props(store, 'acct'), 'a');
    ref.tell({ kind: 'deposit', amount: 100, replyTo: probe.ref });
    await sleep(30);
    await sys.terminate();

    const sys2 = ActorSystem.create('ds-restart-2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe2 = makeProbe(sys2);
    const ref2 = sys2.spawn(props(store, 'acct'), 'a');
    ref2.tell({ kind: 'state', replyTo: probe2.ref });
    await sleep(30);
    expect(probe2.received).toContainEqual({ balance: 100, currency: 'EUR' });
    await sys2.terminate();
  });
});

describe('DurableStateActor — v1 → v2 upcast', () => {
  test('legacy v1 envelope upcasts via defaults adapter', async () => {
    const store = new InMemoryDurableStateStore();
    // Pre-populate the store with a v1 state envelope (no currency).
    await store.upsert<unknown>('acct', 0, {
      _v: 1, _t: 'KV.State', _e: { balance: 999 },
    });
    const sys = ActorSystem.create('ds-upcast', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = makeProbe(sys);
    const ref = sys.spawn(props(store, 'acct'), 'a');
    ref.tell({ kind: 'state', replyTo: probe.ref });
    await sleep(30);
    expect(probe.received).toContainEqual({ balance: 999, currency: 'USD' });
    await sys.terminate();
  });
});

describe('DurableStateActor — strict mode', () => {
  test('adapter active + raw stored state throws MigrationError on preStart', async () => {
    const store = new InMemoryDurableStateStore();
    await store.upsert<unknown>('acct', 0, { balance: 1 } as StateV1);  // raw, no envelope
    const sys = ActorSystem.create('ds-strict', { logger: new NoopLogger(), logLevel: LogLevel.Off });

    let captured: StrictAccount | null = null;
    const probe = makeProbe(sys);
    void probe;
    sys.spawn(Props.create(() => {
      const a = new StrictAccount(
        DurableStateOptions.create<State>()
          .withPersistenceId('acct')
          .withStore(store)
          .withEmptyState((): State => ({ balance: 0, currency: 'USD' })),
      );
      captured = a;
      return a as unknown as Actor<Cmd>;
    }), 'strict');
    await sleep(30);
    const a = captured! as unknown as StrictAccount;
    expect(a.recoveryError).toBeInstanceOf(MigrationError);
    expect(a.recoveryError!.message).toContain('expected envelope');
    await sys.terminate();
  });
});

describe('DurableStateActor — no adapter regression', () => {
  test('actor without stateAdapter uses raw state on disk (pre-migration behaviour)', async () => {
    const store = new InMemoryDurableStateStore();
    class RawAccount extends DurableStateActor<Cmd, StateV1> {
      override async onCommand(cmd: Cmd): Promise<void> {
        if (cmd.kind === 'deposit') {
          await this.persist({ balance: this.state.balance + cmd.amount });
        } else {
          cmd.replyTo.tell({ ...this.state } as never);
        }
      }
    }
    const sys = ActorSystem.create('ds-raw', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const probe = makeProbe(sys);
    const ref = sys.spawn(Props.create(() => new RawAccount(
      DurableStateOptions.create<StateV1>()
        .withPersistenceId('r')
        .withStore(store)
        .withEmptyState((): StateV1 => ({ balance: 0 })),
    ) as unknown as Actor<Cmd>), 'raw');
    ref.tell({ kind: 'deposit', amount: 7, replyTo: probe.ref });
    await sleep(30);
    const raw = await store.load<StateV1>('r');
    expect(raw.toNullable()?.state).toEqual({ balance: 7 });  // no envelope
    await sys.terminate();
  });
});

/* ------------------------- mini probe helper --------------------------- */

interface Probe { ref: ActorRef; received: unknown[]; }
function makeProbe(sys: ActorSystem): Probe {
  const received: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Actor } = require('../../../../../src/Actor.js') as { Actor: new <T>() => { onReceive(_: T): void; }; };
  class P extends (Actor as new () => { onReceive(_: unknown): void; }) {
    onReceive(m: unknown): void { received.push(m); }
  }
  const ref = sys.spawn(Props.create(() => new P() as unknown as Actor<unknown>), `p-${Math.random().toString(36).slice(2, 6)}`);
  return { ref, received };
}
