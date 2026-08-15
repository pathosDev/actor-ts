import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  everyNEvents,
  PersistenceExtensionId,
  PersistentActor,
  SqliteJournal,
  SqliteJournalOptions,
  SqliteSnapshotStore,
  SqliteSnapshotStoreOptions,
  type SnapshotPolicy,
} from '../../../../src/persistence/index.js';

import { awaitCondition } from '../../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/**
 * End-to-end proof for #888: rich payload types (Set/Map/Date) survive the
 * FULL persist → real store → kill → recover cycle, including the snapshot
 * path.  In-memory stores masked the corruption for years because they kept
 * object references, so this test deliberately runs on SQLite — the same
 * bare-JSON write path every other real backend used.
 */

type AddMemberCommand = { kind: 'addMember'; name: string; joinedAt: Date };
type Command = AddMemberCommand;

type MemberAddedEvent = { kind: 'memberAdded'; name: string; joinedAt: Date };
type Event = MemberAddedEvent;

type State = {
  members: Set<string>;
  joinedAt: Map<string, Date>;
  lastChange: Date | null;
};

class Roster extends PersistentActor<Command, Event, State> {
  readonly persistenceId: string;
  constructor(persistenceId: string, private readonly replyTo?: (state: State) => void) {
    super();
    this.persistenceId = persistenceId;
  }
  initialState(): State { return { members: new Set(), joinedAt: new Map(), lastChange: null }; }
  // Snapshot after every 2nd event so a 3-event run proves BOTH paths:
  // recovery folds snapshot(seq 2) + journal event 3.
  override snapshotPolicy(): SnapshotPolicy<State, Event> { return everyNEvents(2); }
  onEvent(s: State, e: Event): State {
    return match(e)
      .with({ kind: 'memberAdded' }, (m) => ({
        members: new Set([...s.members, m.name]),
        joinedAt: new Map([...s.joinedAt, [m.name, m.joinedAt]]),
        lastChange: m.joinedAt,
      }))
      .exhaustive();
  }
  override onRecoveryComplete(s: State): void { this.replyTo?.(s); }
  async onCommand(_state: State, command: Command): Promise<void> {
    await match(command)
      .with({ kind: 'addMember' }, (c) => this.onAddMember(c))
      .exhaustive();
  }

  private async onAddMember(command: AddMemberCommand): Promise<void> {
    await this.persist({ kind: 'memberAdded', name: command.name, joinedAt: command.joinedAt });
  }
}

describe('PersistentActor — rich payload types through a real store (#888)', () => {
  test('Set/Map/Date events and snapshots recover as instances after a kill', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('rich-recovery', systemOptions);
    const journalOptions = SqliteJournalOptions.create().withPath(':memory:');
    const journal = new SqliteJournal(journalOptions);
    const snapshotOptions = SqliteSnapshotStoreOptions.create().withPath(':memory:');
    const snapshots = new SqliteSnapshotStore(snapshotOptions);
    const ext = system.extension(PersistenceExtensionId);
    ext.setJournal(journal);
    ext.setSnapshotStore(snapshots);

    const writer = system.spawn(() => new Roster('roster-1'), 'writer');
    writer.tell({ kind: 'addMember', name: 'ada', joinedAt: new Date('2024-01-01T00:00:00.000Z') });
    writer.tell({ kind: 'addMember', name: 'grace', joinedAt: new Date('2024-02-01T00:00:00.000Z') });
    writer.tell({ kind: 'addMember', name: 'linus', joinedAt: new Date('2024-03-01T00:00:00.000Z') });
    // Wait on the third event, not on the snapshot: `persistAll` awaits the
    // snapshot write before returning and stashes commands meanwhile, so
    // event 3 landing implies the snapshot at 2 is durable.  Polling the
    // snapshot for `sequenceNr === 2` would also accept a transient write
    // from a policy that snapshots on every event (#418).
    await awaitCondition(async () => (await journal.read('roster-1', 1)).length === 3, {
      timeoutMs: 4_000, label: 'all three member events reached the SQLite journal',
    });

    // The snapshot policy fired at seq 2, so recovery must fold the stored
    // snapshot AND the trailing journal event — both paths carry rich types.
    const storedSnapshot = (await snapshots.loadLatest<State>('roster-1')).toNullable();
    expect(storedSnapshot?.sequenceNr).toBe(2);

    system.stop(writer);
    // Precondition only — nothing reads what postStop produces.
    await sleep(50);

    let recovered: State | undefined;
    system.spawn(() => new Roster('roster-1', (s) => { recovered = s; }), 'reader');
    await awaitCondition(() => recovered !== undefined, {
      timeoutMs: 4_000, label: 'the reader finished recovering from snapshot + journal',
    });

    expect(recovered).toBeDefined();
    const state = recovered!;
    expect(state.members).toBeInstanceOf(Set);
    expect(Array.from(state.members).sort()).toEqual(['ada', 'grace', 'linus']);
    expect(state.joinedAt).toBeInstanceOf(Map);
    expect(state.joinedAt.get('grace')).toBeInstanceOf(Date);
    expect(state.joinedAt.get('grace')!.toISOString()).toBe('2024-02-01T00:00:00.000Z');
    expect(state.lastChange).toBeInstanceOf(Date);
    expect(state.lastChange!.toISOString()).toBe('2024-03-01T00:00:00.000Z');

    await system.terminate();
  });
});
