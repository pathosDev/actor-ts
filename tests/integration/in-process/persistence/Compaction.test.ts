/**
 * Compaction: `deleteHistory` shipped with no caller and no test anywhere in
 * the repo.
 *
 * #629 — `SnapshotStore.delete` is documented as inclusive, so
 * `deleteHistory(N)` destroyed the snapshot *at* N: the one the compaction
 * was compacting past, and the only thing left holding the state the deleted
 * events had built.
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

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

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
    await sleep(150);

    ref.tell({ kind: 'compact', toSeq: 2 });
    await sleep(120);

    const latest = await snapshots.loadLatest<State>('ledger-4');
    expect(latest.isSome()).toBe(true);
    expect(latest.value.sequenceNr).toBe(2);
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
    await sleep(120);

    ref.tell({ kind: 'compact', toSeq: 0 });
    await sleep(120);

    expect((await journal.read('ledger-5', 1)).length).toBe(1);
    expect((await snapshots.loadLatest('ledger-5')).isSome()).toBe(true);

    await system.terminate();
  });
});
