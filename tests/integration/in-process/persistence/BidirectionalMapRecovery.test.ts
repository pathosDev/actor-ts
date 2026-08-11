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
import { BidirectionalMap } from '../../../../src/util/BidirectionalMap.js';

import { awaitCondition } from '../../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/**
 * The promise #1035 makes is that a `BidirectionalMap` can simply be held in
 * an actor's state — no `SnapshotAdapter`, no serializer registration, no
 * `toJSON` call at the boundary.  That promise is either demonstrated here or
 * it is not made, so this actor deliberately declares **no adapter of any
 * kind** and the assertions check `instanceof`, not just the data.
 *
 * SQLite rather than an in-memory store for the same reason
 * `RichTypePayloadRecovery.test.ts` (#888) uses it: an in-memory store that
 * kept object references would pass this test while a real backend corrupted
 * the row.
 *
 * Both durable paths carry one: the event payload (journal) and the state
 * (snapshot).  Snapshotting every 2nd event over a 3-event run means recovery
 * has to fold a stored snapshot AND a trailing journal event, so a failure on
 * either path fails the test.
 */

type AssignSeatsCommand = { kind: 'assignSeats'; assignments: BidirectionalMap<string, number> };
type Command = AssignSeatsCommand;

type SeatsAssignedEvent = { kind: 'seatsAssigned'; assignments: BidirectionalMap<string, number> };
type Event = SeatsAssignedEvent;

type State = { seats: BidirectionalMap<string, number> };

class SeatingPlan extends PersistentActor<Command, Event, State> {
  readonly persistenceId: string;

  constructor(persistenceId: string, private readonly replyTo?: (state: State) => void) {
    super();
    this.persistenceId = persistenceId;
  }

  initialState(): State {
    return { seats: new BidirectionalMap<string, number>() };
  }

  override snapshotPolicy(): SnapshotPolicy {
    return everyNEvents(2);
  }

  onEvent(state: State, event: Event): State {
    return match(event)
      .with({ kind: 'seatsAssigned' }, (e) => this.onSeatsAssigned(state, e))
      .exhaustive();
  }

  async onCommand(_state: State, command: Command): Promise<void> {
    await match(command)
      .with({ kind: 'assignSeats' }, (c) => this.onAssignSeats(c))
      .exhaustive();
  }

  override onRecoveryComplete(state: State): void {
    this.replyTo?.(state);
  }

  private onSeatsAssigned(state: State, event: SeatsAssignedEvent): State {
    return { seats: new BidirectionalMap([...state.seats, ...event.assignments]) };
  }

  private async onAssignSeats(command: AssignSeatsCommand): Promise<void> {
    await this.persist({ kind: 'seatsAssigned', assignments: command.assignments });
  }
}

describe('PersistentActor — a BidirectionalMap in state, with no adapter (#1035)', () => {
  test('recovers as a real instance with the reverse direction intact', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('bidirectional-map-recovery', systemOptions);
    const journalOptions = SqliteJournalOptions.create().withPath(':memory:');
    const journal = new SqliteJournal(journalOptions);
    const snapshotOptions = SqliteSnapshotStoreOptions.create().withPath(':memory:');
    const snapshots = new SqliteSnapshotStore(snapshotOptions);
    const extension = system.extension(PersistenceExtensionId);
    extension.setJournal(journal);
    extension.setSnapshotStore(snapshots);

    const writer = system.spawn(() => new SeatingPlan('seating-1'), 'writer');
    writer.tell({ kind: 'assignSeats', assignments: new BidirectionalMap([['ada', 1]]) });
    writer.tell({ kind: 'assignSeats', assignments: new BidirectionalMap([['grace', 2]]) });
    writer.tell({ kind: 'assignSeats', assignments: new BidirectionalMap([['linus', 3]]) });

    await awaitCondition(async () => (await journal.read('seating-1', 1)).length === 3, {
      timeoutMs: 4_000,
      label: 'all three seating events reached the SQLite journal',
    });

    // The event payload came back off disk as an instance too, not just the
    // snapshot -- the journal path is half the promise.
    const storedEvents = await journal.read<Event>('seating-1', 1);
    expect(storedEvents[0]?.event.assignments).toBeInstanceOf(BidirectionalMap);
    expect(storedEvents[0]?.event.assignments.getKey(1)).toBe('ada');

    const storedSnapshot = (await snapshots.loadLatest<State>('seating-1')).toNullable();
    expect(storedSnapshot?.sequenceNr).toBe(2);

    system.stop(writer);
    await sleep(50);

    let recovered: State | undefined;
    system.spawn(() => new SeatingPlan('seating-1', (s) => { recovered = s; }), 'reader');
    await awaitCondition(() => recovered !== undefined, {
      timeoutMs: 4_000,
      label: 'the reader finished recovering from snapshot + journal',
    });

    const state = recovered!;
    expect(state.seats).toBeInstanceOf(BidirectionalMap);
    expect([...state.seats].sort()).toEqual([['ada', 1], ['grace', 2], ['linus', 3]]);

    // The half that is never written: reconstructed on decode, or this is a
    // plain object wearing the right data.
    expect(state.seats.getKey(2)).toBe('grace');
    expect(state.seats.hasValue(3)).toBe(true);
    expect(state.seats.inverse().get(1)).toBe('ada');

    await system.terminate();
  });
});
