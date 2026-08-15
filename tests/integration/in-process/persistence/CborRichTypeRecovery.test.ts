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
import { CborSerializer } from '../../../../src/serialization/CborSerializer.js';
import { BidirectionalMap } from '../../../../src/util/BidirectionalMap.js';

import { awaitCondition } from '../../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/**
 * The scenario #1036 was filed about: a store configured with
 * `withSerializer(new CborSerializer())`, chosen for row size or speed, used
 * to lose every `Map`, `Set` and `BidirectionalMap` in the payload — they
 * encoded as `{}` and nothing raised.  A collection went in and an empty
 * object came back.
 *
 * So this actor holds all three plus the rest of the rich types, declares no
 * adapter of any kind, and both durable paths carry them: the event payload
 * (journal) and the state (snapshot).  Snapshotting every 2nd event over a
 * 3-event run means recovery has to fold a stored snapshot AND a trailing
 * journal event, so a failure on either path fails the test.
 *
 * SQLite rather than an in-memory store for the same reason
 * `BidirectionalMapRecovery.test.ts` uses it: an in-memory store that kept
 * object references would pass while a real backend corrupted the row.  Note
 * that the in-memory stores deliberately do not accept a serializer at all.
 */

type RecordReadingCommand = {
  kind: 'recordReading';
  seats: BidirectionalMap<string, number>;
  tags: Set<string>;
  totals: Map<string, bigint>;
};
type Command = RecordReadingCommand;

type ReadingRecordedEvent = {
  kind: 'readingRecorded';
  seats: BidirectionalMap<string, number>;
  tags: Set<string>;
  totals: Map<string, bigint>;
};
type Event = ReadingRecordedEvent;

type State = {
  seats: BidirectionalMap<string, number>;
  tags: Set<string>;
  totals: Map<string, bigint>;
  pattern: RegExp;
  source: URL;
  samples: Float64Array;
};

class Telemetry extends PersistentActor<Command, Event, State> {
  readonly persistenceId: string;

  constructor(persistenceId: string, private readonly replyTo?: (state: State) => void) {
    super();
    this.persistenceId = persistenceId;
  }

  initialState(): State {
    return {
      seats: new BidirectionalMap<string, number>(),
      tags: new Set<string>(),
      totals: new Map<string, bigint>(),
      pattern: /seat-\d+/gi,
      source: new URL('https://example.test/telemetry'),
      samples: new Float64Array([1.5, -0]),
    };
  }

  override snapshotPolicy(): SnapshotPolicy<State, Event> {
    return everyNEvents(2);
  }

  onEvent(state: State, event: Event): State {
    return match(event)
      .with({ kind: 'readingRecorded' }, (e) => this.onReadingRecorded(state, e))
      .exhaustive();
  }

  async onCommand(_state: State, command: Command): Promise<void> {
    await match(command)
      .with({ kind: 'recordReading' }, (c) => this.onRecordReading(c))
      .exhaustive();
  }

  override onRecoveryComplete(state: State): void {
    this.replyTo?.(state);
  }

  private onReadingRecorded(state: State, event: ReadingRecordedEvent): State {
    return {
      ...state,
      seats: new BidirectionalMap([...state.seats, ...event.seats]),
      tags: new Set([...state.tags, ...event.tags]),
      totals: new Map([...state.totals, ...event.totals]),
    };
  }

  private async onRecordReading(command: RecordReadingCommand): Promise<void> {
    await this.persist({
      kind: 'readingRecorded',
      seats: command.seats,
      tags: command.tags,
      totals: command.totals,
    });
  }
}

describe('PersistentActor — rich types through a CBOR store serializer (#1036)', () => {
  test('Map, Set and BidirectionalMap survive journal and snapshot as instances', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('cbor-rich-type-recovery', systemOptions);

    // The whole point: rows are written in the `__serialized__` framing with
    // CBOR bytes inside, not the default tagged JSON.
    const journalOptions = SqliteJournalOptions.create()
      .withPath(':memory:')
      .withSerializer(new CborSerializer());
    const journal = new SqliteJournal(journalOptions);
    const snapshotOptions = SqliteSnapshotStoreOptions.create()
      .withPath(':memory:')
      .withSerializer(new CborSerializer());
    const snapshots = new SqliteSnapshotStore(snapshotOptions);

    const extension = system.extension(PersistenceExtensionId);
    extension.setJournal(journal);
    extension.setSnapshotStore(snapshots);

    const reading = (seat: string, number: number, tag: string, total: bigint): Command => ({
      kind: 'recordReading',
      seats: new BidirectionalMap([[seat, number]]),
      tags: new Set([tag]),
      totals: new Map([[tag, total]]),
    });

    const writer = system.spawn(() => new Telemetry('telemetry-1'), 'writer');
    writer.tell(reading('ada', 1, 'alpha', 10n));
    writer.tell(reading('grace', 2, 'beta', 20n));
    writer.tell(reading('linus', 3, 'gamma', 30n));

    await awaitCondition(async () => (await journal.read('telemetry-1', 1)).length === 3, {
      timeoutMs: 4_000,
      label: 'all three telemetry events reached the SQLite journal',
    });

    // The event payload came back off disk as instances too, not just the
    // snapshot — the journal path is half the promise.
    const storedEvents = await journal.read<Event>('telemetry-1', 1);
    expect(storedEvents[0]?.event.seats).toBeInstanceOf(BidirectionalMap);
    expect(storedEvents[0]?.event.seats.getKey(1)).toBe('ada');
    expect(storedEvents[0]?.event.tags).toBeInstanceOf(Set);
    expect(storedEvents[0]?.event.totals.get('alpha')).toBe(10n);

    const storedSnapshot = (await snapshots.loadLatest<State>('telemetry-1')).toNullable();
    expect(storedSnapshot?.sequenceNr).toBe(2);

    system.stop(writer);
    await sleep(50);

    let recovered: State | undefined;
    system.spawn(() => new Telemetry('telemetry-1', (s) => { recovered = s; }), 'reader');
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

    expect(state.tags).toBeInstanceOf(Set);
    expect([...state.tags].sort()).toEqual(['alpha', 'beta', 'gamma']);

    expect(state.totals).toBeInstanceOf(Map);
    expect(state.totals.get('gamma')).toBe(30n);

    // The rest of the rich types, carried through the snapshot untouched.
    expect(state.pattern).toBeInstanceOf(RegExp);
    expect(state.pattern.flags).toBe('gi');
    expect(state.source).toBeInstanceOf(URL);
    expect(state.source.href).toBe('https://example.test/telemetry');
    expect(state.samples).toBeInstanceOf(Float64Array);
    expect(Object.is(state.samples[1], -0)).toBe(true);

    await system.terminate();
  });
});
