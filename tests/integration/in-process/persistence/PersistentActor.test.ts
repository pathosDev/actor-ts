import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  everyNEvents,
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
} from '../../../../src/persistence/index.js';
import { Props } from '../../../../src/Props.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/** Shared domain types for the tests. */
type Command = { kind: 'deposit'; amount: number } | { kind: 'withdraw'; amount: number } | { kind: 'balance' };
type Event = { kind: 'deposited'; amount: number } | { kind: 'withdrew'; amount: number };
type State = { balance: number };

function makeSystem(): { system: ActorSystem; journal: InMemoryJournal; snapshots: InMemorySnapshotStore } {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('persist-unit', systemOptions);
  const journal = new InMemoryJournal();
  const snapshots = new InMemorySnapshotStore();
  const ext = system.extension(PersistenceExtensionId);
  ext.setJournal(journal);
  ext.setSnapshotStore(snapshots);
  return { system, journal, snapshots };
}

class Account extends PersistentActor<Command, Event, State> {
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
  async onCommand(state: State, cmd: Command): Promise<void> {
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
    const ref = system.spawn(Props.create(() => new Account('acct-1', m => seen.push(m))), 'a');
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
    system.spawn(Props.create(() => new Account('acct-7', m => seen.push(m))), 'a');
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
    system.spawn(Props.create(() => new Account('acct-snap', m => seen.push(m))), 'a');
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

    const ref = system.spawn(Props.create(() => new Slow()), 'slow');
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

    const ref = system.spawn(Props.create(() => new Counter()), 'c');
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
    const ref = system.spawn(Props.create(() => new Batch()), 'b');
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
    const ref = system.spawn(Props.create(() => new Tagged()), 'tg');
    ref.tell('go');
    await sleep(30);
    const [evt] = await journal.read('tagged', 1);
    expect(evt?.tags).toEqual(['orders']);
    await system.terminate();
  });
});

/* ------------------------- security: snapshot integrity -------------------------- */

describe('PersistentActor — snapshot integrity hardening', () => {
  /**
   * **Exploit walkthrough (pre-fix).**  `recover()` accepted
   * `snapshot.value.sequenceNr` as authoritative and started event
   * replay from `seq + 1`.  An attacker with write access to the
   * snapshot store (shared bucket, co-tenant, insider) could craft a
   * snapshot with `sequenceNr = Number.MAX_SAFE_INTEGER`.  The actor
   * would:
   *   1. Set `_seq = MAX_SAFE_INTEGER`.
   *   2. Read events from `MAX_SAFE_INTEGER + 1` → journal returns []
   *      (no events at that seq).
   *   3. Skip all legitimate event replay.
   *   4. Recover with the attacker's state.
   *
   * Same trick with `sequenceNr = NaN` / `Infinity` / `-1` produced
   * similar invalid-state recovery.
   *
   * Fix: validate `sequenceNr` is a finite non-negative integer AND
   * not above `journal.highestSeq(pid)` before trusting it for
   * replay.  A mismatch throws — recovery fails loudly rather than
   * silently using a tampered state.
   */
  test('exploit: tampered snapshot with MAX_SAFE_INTEGER seq is refused', async () => {
    const { system, journal, snapshots } = makeSystem();
    // Genuine state: two events, seq=1+2.
    await journal.append('tampered-1',
      [{ kind: 'deposited', amount: 100 }, { kind: 'deposited', amount: 50 }], 0);
    // Attacker writes a malicious snapshot — seq way above what the
    // journal can corroborate.
    await snapshots.save('tampered-1', Number.MAX_SAFE_INTEGER, { balance: 99_999 });

    // Recovery should throw a clear error rather than silently
    // recover with the attacker's state.
    const events: unknown[] = [];
    const ref = system.spawn(Props.create(() => new Account('tampered-1', (m) => events.push(m))), 't1');
    // Wait briefly — recovery error should bubble up; the actor will
    // be terminated by the supervisor.  We assert by checking the
    // actor never reached recovery-complete (which would emit `ready`).
    await sleep(150);
    const ready = events.find((e) => (e as { ready?: number }).ready !== undefined);
    expect(ready).toBeUndefined();
    void ref;
    await system.terminate();
  });

  test('exploit: tampered snapshot with negative seq is refused', async () => {
    const { system, journal, snapshots } = makeSystem();
    await journal.append('tampered-2', [{ kind: 'deposited', amount: 1 }], 0);
    await snapshots.save('tampered-2', -1, { balance: 99_999 });

    const events: unknown[] = [];
    system.spawn(Props.create(() => new Account('tampered-2', (m) => events.push(m))), 't2');
    await sleep(150);
    expect(events.find((e) => (e as { ready?: number }).ready !== undefined)).toBeUndefined();
    await system.terminate();
  });

  test('exploit: tampered snapshot with NaN seq is refused', async () => {
    const { system, journal, snapshots } = makeSystem();
    await journal.append('tampered-3', [{ kind: 'deposited', amount: 1 }], 0);
    await snapshots.save('tampered-3', Number.NaN, { balance: 99_999 });

    const events: unknown[] = [];
    system.spawn(Props.create(() => new Account('tampered-3', (m) => events.push(m))), 't3');
    await sleep(150);
    expect(events.find((e) => (e as { ready?: number }).ready !== undefined)).toBeUndefined();
    await system.terminate();
  });

  test('exploit: snapshot seq even ONE above journal-highest is refused', async () => {
    // Tighter boundary test: journal has 3 events (seq 1, 2, 3), but
    // a tampered snapshot claims seq=4.  Refused even though seq=4
    // is "only" one above.
    const { system, journal, snapshots } = makeSystem();
    await journal.append('tampered-4',
      [{ kind: 'deposited', amount: 10 }, { kind: 'deposited', amount: 20 }, { kind: 'deposited', amount: 30 }], 0);
    await snapshots.save('tampered-4', 4, { balance: 99_999 });

    const events: unknown[] = [];
    system.spawn(Props.create(() => new Account('tampered-4', (m) => events.push(m))), 't4');
    await sleep(150);
    expect(events.find((e) => (e as { ready?: number }).ready !== undefined)).toBeUndefined();
    await system.terminate();
  });

  test('regression: legitimate snapshot at seq=journal-highest recovers normally', async () => {
    const { system, journal, snapshots } = makeSystem();
    await journal.append('legit-1',
      [{ kind: 'deposited', amount: 100 }, { kind: 'deposited', amount: 50 }], 0);
    // Snapshot at seq=2 (the journal's highest) is the standard case.
    await snapshots.save('legit-1', 2, { balance: 150 });

    const events: unknown[] = [];
    const ref = system.spawn(Props.create(() => new Account('legit-1', (m) => events.push(m))), 'l1');
    await sleep(150);
    expect(events).toContainEqual({ ready: 150 });
    void ref;
    await system.terminate();
  });

  test('regression: legitimate snapshot below journal-highest replays remaining events', async () => {
    const { system, journal, snapshots } = makeSystem();
    await journal.append('legit-2',
      [{ kind: 'deposited', amount: 100 },
       { kind: 'deposited', amount: 50 },
       { kind: 'deposited', amount: 25 }], 0);
    // Snapshot at seq=1; events 2+3 still need replay.
    await snapshots.save('legit-2', 1, { balance: 100 });

    const events: unknown[] = [];
    system.spawn(Props.create(() => new Account('legit-2', (m) => events.push(m))), 'l2');
    await sleep(150);
    expect(events).toContainEqual({ ready: 175 });   // 100 + 50 + 25
    await system.terminate();
  });
});
