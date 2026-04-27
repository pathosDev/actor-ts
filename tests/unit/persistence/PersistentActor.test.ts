import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  everyNEvents,
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
} from '../../../src/persistence/index.js';
import { Props } from '../../../src/Props.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/** Shared domain types for the tests. */
type Cmd = { kind: 'deposit'; amount: number } | { kind: 'withdraw'; amount: number } | { kind: 'balance' };
type Event = { kind: 'deposited'; amount: number } | { kind: 'withdrew'; amount: number };
type State = { balance: number };

function makeSystem(): { system: ActorSystem; journal: InMemoryJournal; snapshots: InMemorySnapshotStore } {
  const system = ActorSystem.create('persist-unit', { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const journal = new InMemoryJournal();
  const snapshots = new InMemorySnapshotStore();
  const ext = system.extension(PersistenceExtensionId);
  ext.setJournal(journal);
  ext.setSnapshotStore(snapshots);
  return { system, journal, snapshots };
}

class Account extends PersistentActor<Cmd, Event, State> {
  readonly persistenceId: string;
  constructor(pid: string, private readonly replyTo?: (m: unknown) => void) {
    super();
    this.persistenceId = pid;
  }
  initialState(): State { return { balance: 0 }; }
  onEvent(s: State, e: Event): State {
    if (e.kind === 'deposited') return { balance: s.balance + e.amount };
    if (e.kind === 'withdrew')  return { balance: s.balance - e.amount };
    return s;
  }
  override onRecoveryComplete(s: State): void { this.replyTo?.({ ready: s.balance }); }
  async onCommand(state: State, cmd: Cmd): Promise<void> {
    if (cmd.kind === 'deposit') {
      await this.persist({ kind: 'deposited', amount: cmd.amount }, s => this.replyTo?.({ balance: s.balance }));
    } else if (cmd.kind === 'withdraw') {
      if (cmd.amount > state.balance) { this.replyTo?.({ error: 'insufficient' }); return; }
      await this.persist({ kind: 'withdrew', amount: cmd.amount }, s => this.replyTo?.({ balance: s.balance }));
    } else if (cmd.kind === 'balance') {
      this.replyTo?.({ balance: state.balance });
    }
  }
}

describe('PersistentActor — write + recover', () => {
  test('persists events and applies them to the state', async () => {
    const { system } = makeSystem();
    const seen: unknown[] = [];
    const ref = system.actorOf(Props.create(() => new Account('acct-1', m => seen.push(m))), 'a');
    ref.tell({ kind: 'deposit', amount: 100 });
    ref.tell({ kind: 'deposit', amount: 50 });
    ref.tell({ kind: 'withdraw', amount: 30 });
    ref.tell({ kind: 'balance' });
    await sleep(50);
    expect(seen).toEqual([
      { ready: 0 },
      { balance: 100 },
      { balance: 150 },
      { balance: 120 },
      { balance: 120 },
    ]);
    await system.terminate();
  });

  test('recovers state from the journal after a restart', async () => {
    const { system, journal, snapshots } = makeSystem();
    // Pre-populate the journal by hand — simulating a prior incarnation.
    await journal.append<Event>('acct-7', [
      { kind: 'deposited', amount: 10 },
      { kind: 'deposited', amount: 5 },
      { kind: 'withdrew',  amount: 3 },
    ], 0);

    const seen: unknown[] = [];
    system.actorOf(Props.create(() => new Account('acct-7', m => seen.push(m))), 'a');
    await sleep(30);
    expect(seen).toContainEqual({ ready: 12 });
    void snapshots; // snapshot path not used in this test
    await system.terminate();
  });

  test('snapshot + replay: state comes from snapshot + newer events only', async () => {
    const { system, journal, snapshots } = makeSystem();
    await snapshots.save('acct-snap', 3, { balance: 500 }); // "seq up to 3 already in state"
    await journal.append<Event>('acct-snap', [
      { kind: 'deposited', amount: 10 },   // seq 1 — before snapshot
      { kind: 'deposited', amount: 10 },   // seq 2 — before snapshot
      { kind: 'deposited', amount: 10 },   // seq 3 — at snapshot
      { kind: 'deposited', amount: 50 },   // seq 4 — AFTER snapshot, MUST be applied
    ], 0);
    const seen: unknown[] = [];
    system.actorOf(Props.create(() => new Account('acct-snap', m => seen.push(m))), 'a');
    await sleep(30);
    expect(seen).toContainEqual({ ready: 550 });
    await system.terminate();
  });
});

describe('PersistentActor — stash during persist', () => {
  test('commands arriving during persist are processed AFTER the persist completes', async () => {
    const { system } = makeSystem();
    const order: string[] = [];

    class Slow extends PersistentActor<'ping' | 'fast', 'pinged' | 'fast', { count: number }> {
      readonly persistenceId = 'slow-1';
      initialState() { return { count: 0 }; }
      onEvent(s: { count: number }): { count: number } { return { count: s.count + 1 }; }
      async onCommand(_s: unknown, cmd: 'ping' | 'fast'): Promise<void> {
        if (cmd === 'ping') {
          order.push('persist-start');
          await this.persist('pinged', () => {
            order.push('persist-done');
          });
        } else if (cmd === 'fast') {
          order.push('fast-ran');
        }
      }
    }

    const ref = system.actorOf(Props.create(() => new Slow()), 'slow');
    ref.tell('ping');
    ref.tell('fast');
    ref.tell('fast');
    await sleep(40);

    // The two "fast" commands must wait for the persist to finish.
    expect(order).toEqual(['persist-start', 'persist-done', 'fast-ran', 'fast-ran']);
    await system.terminate();
  });
});

describe('PersistentActor — snapshots', () => {
  test('snapshot policy every N events triggers a snapshot at the right seq', async () => {
    const { system, snapshots } = makeSystem();

    class Counter extends PersistentActor<'inc', 'ticked', { n: number }> {
      readonly persistenceId = 'ctr';
      initialState() { return { n: 0 }; }
      onEvent(s: { n: number }): { n: number } { return { n: s.n + 1 }; }
      snapshotPolicy() { return everyNEvents<{ n: number }, 'ticked'>(3); }
      async onCommand(_s: unknown, _cmd: 'inc'): Promise<void> {
        await this.persist('ticked');
      }
    }

    const ref = system.actorOf(Props.create(() => new Counter()), 'c');
    for (let i = 0; i < 7; i++) ref.tell('inc');
    await sleep(40);

    const latest = (await snapshots.loadLatest<{ n: number }>('ctr')).toNullable();
    // After 7 events, the newest snapshot should be at seq 6 (most recent multiple of 3).
    expect(latest?.sequenceNr).toBe(6);
    expect(latest?.state.n).toBe(6);
    await system.terminate();
  });
});

describe('PersistentActor — persistAll atomic batch', () => {
  test('persistAll appends every event with sequential seqs', async () => {
    const { system, journal } = makeSystem();
    class Batch extends PersistentActor<'go', number, number[]> {
      readonly persistenceId = 'batch';
      initialState() { return []; }
      onEvent(s: number[], e: number): number[] { return [...s, e]; }
      async onCommand(_s: unknown, _cmd: 'go'): Promise<void> {
        await this.persistAll([1, 2, 3]);
      }
    }
    const ref = system.actorOf(Props.create(() => new Batch()), 'b');
    ref.tell('go');
    await sleep(30);
    const events = await journal.read<number>('batch', 1);
    expect(events.map(e => e.event)).toEqual([1, 2, 3]);
    expect(events.map(e => e.sequenceNr)).toEqual([1, 2, 3]);
    await system.terminate();
  });
});

describe('PersistentActor — tagsFor', () => {
  test('tags are attached to every persisted event', async () => {
    const { system, journal } = makeSystem();

    class Tagged extends PersistentActor<'go', { op: string }, number> {
      readonly persistenceId = 'tagged';
      initialState(): number { return 0; }
      onEvent(s: number): number { return s + 1; }
      override tagsFor(): readonly string[] { return ['orders']; }
      async onCommand(): Promise<void> { await this.persist({ op: 'x' }); }
    }
    const ref = system.actorOf(Props.create(() => new Tagged()), 'tg');
    ref.tell('go');
    await sleep(30);
    const [evt] = await journal.read('tagged', 1);
    expect(evt?.tags).toEqual(['orders']);
    await system.terminate();
  });
});
