import { describe, expect, test } from 'bun:test';
import type { Journal } from '../../../src/persistence/Journal.js';
import type { PersistentEvent, Snapshot } from '../../../src/persistence/JournalTypes.js';
import type { SnapshotStore } from '../../../src/persistence/SnapshotStore.js';
import { none, some, type Option } from '../../../src/util/Option.js';
import { replayState, SnapshotIntegrityError } from '../../../src/persistence/Replay.js';

/**
 * #874 — `actor-ts.persistence.snapshot-is-optional`.
 *
 * The feature is one line of behaviour ("fall back to a full journal replay")
 * wrapped around a security question, and it is the question these tests are
 * mostly about.  A snapshot store that verifies integrity rejects a *tampered*
 * body the same way it reports being *unreachable* — both are a rejected
 * `loadLatest` — so a fallback that recognised outages by error class would
 * turn #100's integrity control into a retry the first time someone crafted a
 * body that failed to verify.
 *
 * The answer here is structural rather than a matter of matching the right
 * error: an actor whose `persistenceOptions` carry `integrity` or
 * `encryption` gets no fallback at all.
 */

type AddedEvent = { readonly kind: 'added'; readonly amount: number };
type CounterState = { readonly total: number };

const PERSISTENCE_ID = 'counter';

function event(sequenceNr: number, amount: number): PersistentEvent<AddedEvent> {
  return { persistenceId: PERSISTENCE_ID, sequenceNr, event: { kind: 'added', amount }, timestamp: 0 };
}

/** A journal holding a fixed, well-formed stream. */
class StreamJournal implements Journal {
  constructor(private readonly stream: ReadonlyArray<PersistentEvent<AddedEvent>>) {}
  async append<E = unknown>(): Promise<PersistentEvent<E>[]> { throw new Error('read-only'); }
  async read<E = unknown>(_id: string, fromSeq: number): Promise<PersistentEvent<E>[]> {
    return this.stream.filter((e) => e.sequenceNr >= fromSeq) as unknown as PersistentEvent<E>[];
  }
  async highestSeq(): Promise<number> { return this.stream[this.stream.length - 1]?.sequenceNr ?? 0; }
  async delete(): Promise<void> {}
  async persistenceIds(): Promise<string[]> { return [PERSISTENCE_ID]; }
}

/** A snapshot store whose reads throw whatever the test hands it. */
class FailingSnapshotStore implements SnapshotStore {
  constructor(private readonly error: Error) {}
  async save<S>(): Promise<Snapshot<S>> { throw this.error; }
  async loadLatest<S>(): Promise<Option<Snapshot<S>>> { throw this.error; }
  async loadBefore<S>(): Promise<Option<Snapshot<S>>> { throw this.error; }
  async delete(): Promise<void> {}
}

const request = (
  snapshotStore: SnapshotStore,
  overrides: Partial<Parameters<typeof replayState<AddedEvent, CounterState>>[0]> = {},
) => ({
  journal: new StreamJournal([event(1, 10), event(2, 5)]),
  snapshotStore,
  persistenceId: PERSISTENCE_ID,
  initialState: (): CounterState => ({ total: 0 }),
  fold: (state: CounterState, e: AddedEvent): CounterState => ({ total: state.total + e.amount }),
  ...overrides,
});

describe('replayState — snapshotIsOptional', () => {
  test('off by default: a snapshot store that cannot answer fails the replay', async () => {
    const store = new FailingSnapshotStore(new Error('bucket is unreachable'));

    await expect(replayState<AddedEvent, CounterState>(request(store)))
      .rejects.toThrow('bucket is unreachable');
  });

  test('on: the fold falls back to the whole journal and reports the failure', async () => {
    const store = new FailingSnapshotStore(new Error('bucket is unreachable'));
    const reported: Error[] = [];

    const result = await replayState<AddedEvent, CounterState>(request(store, {
      snapshotIsOptional: true,
      onSnapshotLoadFailure: (error) => { reported.push(error); },
    }));

    expect(result.state).toEqual({ total: 15 });
    expect(result.sequenceNr).toBe(2);
    expect(result.fromSnapshotSequenceNr).toBeNull();
    expect(result.eventsApplied).toBe(2);
    expect(reported.map((e) => e.message)).toEqual(['bucket is unreachable']);
  });

  test('on: a SnapshotIntegrityError is still fatal', async () => {
    // Whichever layer raised it — this replay's own check, or a store that
    // verifies its bodies.  "The snapshot cannot be trusted" is not "the
    // snapshot store is down".
    const store = new FailingSnapshotStore(
      new SnapshotIntegrityError('claims a sequence ahead of the journal', PERSISTENCE_ID, 99),
    );
    const reported: Error[] = [];

    await expect(replayState<AddedEvent, CounterState>(request(store, {
      snapshotIsOptional: true,
      onSnapshotLoadFailure: (error) => { reported.push(error); },
    }))).rejects.toBeInstanceOf(SnapshotIntegrityError);
    expect(reported).toEqual([]);
  });

  test('on: an actor that asked for integrity gets no fallback, whatever the error', async () => {
    // The load carries `persistenceOptions.integrity`, so the store's
    // rejection may be a failed HMAC.  A store that rejects a tampered body
    // with a plain `Error` — which is what the object-storage backend does —
    // is indistinguishable from one that is down, so the only safe reading is
    // that neither is tolerated.
    const store = new FailingSnapshotStore(new Error('bucket is unreachable'));
    const reported: Error[] = [];

    await expect(replayState<AddedEvent, CounterState>(request(store, {
      snapshotIsOptional: true,
      onSnapshotLoadFailure: (error) => { reported.push(error); },
      persistenceOptions: { integrity: { mode: 'hmac-sha256', integrityKey: new Uint8Array(32) } },
    }))).rejects.toThrow('bucket is unreachable');
    expect(reported).toEqual([]);
  });

  test('on: an actor that asked for encryption gets no fallback either', async () => {
    const store = new FailingSnapshotStore(new Error('bucket is unreachable'));

    await expect(replayState<AddedEvent, CounterState>(request(store, {
      snapshotIsOptional: true,
      persistenceOptions: { encryption: { mode: 'sse-s3' } },
    }))).rejects.toThrow('bucket is unreachable');
  });

  test('on: a store that answers normally is still used', async () => {
    // The flag must not become "never read a snapshot".
    const store: SnapshotStore = {
      async save<S>(): Promise<Snapshot<S>> { throw new Error('unused'); },
      async loadLatest<S>(): Promise<Option<Snapshot<S>>> {
        return some({
          persistenceId: PERSISTENCE_ID, sequenceNr: 1, state: { total: 10 }, timestamp: 0,
        } as unknown as Snapshot<S>);
      },
      async loadBefore<S>(): Promise<Option<Snapshot<S>>> { return none; },
      async delete(): Promise<void> {},
    };

    const result = await replayState<AddedEvent, CounterState>(
      request(store, { snapshotIsOptional: true }),
    );

    expect(result.fromSnapshotSequenceNr).toBe(1);
    expect(result.state).toEqual({ total: 15 });
  });
});
