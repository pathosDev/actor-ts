/**
 * Compaction round-trip: persist → snapshot → deleteHistory → recover →
 * persist again.
 *
 * `deleteHistory` shipped with no caller and no test anywhere in the repo, and
 * both halves of it were wrong in ways that only surface after a restart:
 *
 * - #629 — `SnapshotStore.delete` is documented inclusive, so
 *   `deleteHistory(N)` destroyed the snapshot *at* N, the one it was
 *   compacting past.  The actor was left with no snapshot and no events.
 * - #628 — recovery seeded its sequence only from a snapshot or replayed
 *   events, so a fully compacted journal recovered at 0.  Since #379 the
 *   backends remember what they deleted, so `highestSeq` still reports N —
 *   and `persist` then sends expectedSeq=0 into a journal that has seen N,
 *   failing with `JournalConcurrencyError` on every attempt, permanently.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  InMemoryJournal,
  InMemorySnapshotStore,
  PersistenceExtensionId,
  PersistentActor,
} from '../../../../src/persistence/index.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/**
 * `Ledger` replies to every command, so the reply count *is* the
 * mailbox's progress marker — waiting on it is what the fixed 120 ms
 * sleeps were approximating (#418).  Timeouts here are a failure
 * budget: a healthy run returns on the first poll.
 */
function awaitReports(reports: ReadonlyArray<Report>, count: number, what: string): Promise<void> {
  return awaitCondition(() => reports.length === count, {
    timeoutMs: 4_000,
    label: `${what} (${count} ledger replies)`,
  });
}

type AppendCommand = { kind: 'append'; value: number };
type CompactCommand = { kind: 'compact'; toSeq: number };
type SnapshotCommand = { kind: 'snapshot' };
type ReportCommand = { kind: 'report' };
type Command = AppendCommand | CompactCommand | SnapshotCommand | ReportCommand;

type AppendedEvent = { kind: 'appended'; value: number };
type State = { total: number };

/** Reports either the new total or the error a command failed with. */
type Report = { total: number } | { error: string };

class Ledger extends PersistentActor<Command, AppendedEvent, State> {
  constructor(readonly persistenceId: string, private readonly replyTo: (r: Report) => void) {
    super();
  }

  initialState(): State { return { total: 0 }; }
  onEvent(state: State, event: AppendedEvent): State { return { total: state.total + event.value }; }

  async onCommand(state: State, command: Command): Promise<void> {
    if (command.kind === 'append') {
      try {
        await this.persist({ kind: 'appended', value: command.value }, (s) => this.replyTo({ total: s.total }));
      } catch (e) {
        this.replyTo({ error: String(e instanceof Error ? e.message : e) });
      }
      return;
    }
    if (command.kind === 'snapshot') { await this.saveSnapshot(); this.replyTo({ total: state.total }); return; }
    if (command.kind === 'compact') { await this.deleteHistory(command.toSeq); this.replyTo({ total: state.total }); return; }
    this.replyTo({ total: state.total });
  }
}

function makeSystem(name: string): {
  system: ActorSystem;
  journal: InMemoryJournal;
  snapshots: InMemorySnapshotStore;
} {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  const journal = new InMemoryJournal();
  const snapshots = new InMemorySnapshotStore();
  const extension = system.extension(PersistenceExtensionId);
  extension.setJournal(journal);
  extension.setSnapshotStore(snapshots);
  return { system, journal, snapshots };
}

describe('compaction round-trip', () => {
  test('an actor survives a restart after full compaction (#628, #629)', async () => {
    const { system, journal, snapshots } = makeSystem('compaction-roundtrip');
    const reports: Report[] = [];
    const collect = (r: Report): void => { reports.push(r); };

    const first = system.spawn(() => new Ledger('ledger-1', collect), 'first');
    for (const value of [1, 2, 3]) first.tell({ kind: 'append', value });
    first.tell({ kind: 'snapshot' });
    await awaitReports(reports, 4, 'three appends and the snapshot completed');
    expect(await journal.highestSeq('ledger-1')).toBe(3);

    // Compact past the snapshot: events 1..3 go, the snapshot at 3 stays.
    first.tell({ kind: 'compact', toSeq: 3 });
    await awaitReports(reports, 5, 'deleteHistory(3) completed');
    expect((await journal.read('ledger-1', 1)).length).toBe(0);
    // The journal remembers what it deleted — this is what made the bug
    // permanent rather than merely lossy.
    expect(await journal.highestSeq('ledger-1')).toBe(3);
    // #629: the snapshot the compaction compacted past must still be there.
    expect((await snapshots.loadLatest('ledger-1')).isSome()).toBe(true);

    first.stop();
    // Precondition, not an assertion: nothing downstream reads state that
    // `postStop` produces, so there is no condition to poll for (#418).
    await sleep(80);

    // Restart: state comes from the snapshot, and the sequence must line up
    // with what the journal remembers.
    reports.length = 0;
    const second = system.spawn(() => new Ledger('ledger-1', collect), 'second');
    second.tell({ kind: 'report' });
    await awaitReports(reports, 1, 'the restarted ledger reported its recovered state');
    expect(reports).toEqual([{ total: 6 }]);

    // #628: this used to throw JournalConcurrencyError, for good.
    reports.length = 0;
    second.tell({ kind: 'append', value: 10 });
    await awaitReports(reports, 1, 'the post-compaction append was answered');
    expect(reports).toEqual([{ total: 16 }]);
    expect(await journal.highestSeq('ledger-1')).toBe(4);

    await system.terminate();
  });

  test('recovery of a compacted journal with no snapshot still advances the sequence (#628)', async () => {
    // The harsher variant: nothing to recover state from, but the journal
    // still knows how far it got.  State restarts at zero — that is expected
    // after deleting the only record of it — while writes must keep working.
    const { system, journal, snapshots } = makeSystem('compaction-no-snapshot');
    const reports: Report[] = [];
    const collect = (r: Report): void => { reports.push(r); };

    const first = system.spawn(() => new Ledger('ledger-2', collect), 'first');
    for (const value of [5, 5]) first.tell({ kind: 'append', value });
    await awaitReports(reports, 2, 'both appends reached the journal');
    expect(await journal.highestSeq('ledger-2')).toBe(2);

    await journal.delete('ledger-2', 2);
    await snapshots.delete('ledger-2', 2);
    first.stop();
    await sleep(80);

    reports.length = 0;
    const second = system.spawn(() => new Ledger('ledger-2', collect), 'second');
    second.tell({ kind: 'append', value: 7 });
    await awaitReports(reports, 1, 'the append after a snapshot-less compaction was answered');

    expect(reports).toEqual([{ total: 7 }]);
    expect(await journal.highestSeq('ledger-2')).toBe(3);

    await system.terminate();
  });

  test('a brand-new actor starts at sequence zero', async () => {
    // The high-water lookup must not invent history for an actor that has
    // none — `highestSeq` returns 0 and the clamp is a no-op.
    const { system, journal } = makeSystem('compaction-fresh');
    const reports: Report[] = [];

    const ref = system.spawn(() => new Ledger('ledger-3', (r) => reports.push(r)), 'fresh');
    ref.tell({ kind: 'append', value: 4 });
    await awaitReports(reports, 1, 'the first append of a fresh ledger was answered');

    expect(reports).toEqual([{ total: 4 }]);
    expect(await journal.highestSeq('ledger-3')).toBe(1);

    await system.terminate();
  });
});

describe('deleteHistory', () => {
  test('keeps the snapshot it compacts past, and drops earlier ones (#629)', async () => {
    const { system, snapshots } = makeSystem('delete-history');
    const reports: Report[] = [];
    const collect = (r: Report): void => { reports.push(r); };

    const ref = system.spawn(() => new Ledger('ledger-4', collect), 'a');
    ref.tell({ kind: 'append', value: 1 });
    ref.tell({ kind: 'snapshot' });          // snapshot @1
    ref.tell({ kind: 'append', value: 1 });
    ref.tell({ kind: 'snapshot' });          // snapshot @2
    await awaitReports(reports, 4, 'both appends and both snapshots completed');

    ref.tell({ kind: 'compact', toSeq: 2 });
    await awaitReports(reports, 5, 'deleteHistory(2) completed');

    const latest = await snapshots.loadLatest<State>('ledger-4');
    expect(latest.isSome()).toBe(true);
    expect(latest.toNullable()!.sequenceNr).toBe(2);
    // The earlier one is gone — compaction still prunes.
    expect((await snapshots.loadBefore<State>('ledger-4', 2)).isSome()).toBe(false);

    await system.terminate();
  });

  test('compacting past nothing is a no-op', async () => {
    const { system, journal, snapshots } = makeSystem('delete-history-zero');
    const reports: Report[] = [];

    const ref = system.spawn(() => new Ledger('ledger-5', (r) => reports.push(r)), 'a');
    ref.tell({ kind: 'append', value: 3 });
    ref.tell({ kind: 'snapshot' });
    await awaitReports(reports, 2, 'the append and the snapshot completed');

    ref.tell({ kind: 'compact', toSeq: 0 });
    await awaitReports(reports, 3, 'deleteHistory(0) completed');

    expect((await journal.read('ledger-5', 1)).length).toBe(1);
    expect((await snapshots.loadLatest('ledger-5')).isSome()).toBe(true);

    await system.terminate();
  });
});
