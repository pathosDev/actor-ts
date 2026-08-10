/**
 * Journal-integrity checks on the replay path (#122).
 *
 * `replayState` used to fold whatever `journal.read` handed it and
 * assign `sequenceNr` from the last entry delivered, so a shuffled
 * stream both reordered history and left recovery one sequence short —
 * the phantom `JournalConcurrencyError` on the first `persist` after a
 * restart.
 *
 * No built-in journal misbehaves this way (they all sort, Cassandra
 * explicitly), which is the point: the checks defend the plugin
 * contract, so the only way to exercise them is a journal written to
 * break it.  Hence `ScriptedJournal` — it returns exactly the stream a
 * test dictates.
 */
import { describe, expect, test } from 'bun:test';
import type { Journal } from '../../../src/persistence/Journal.js';
import type { PersistentEvent } from '../../../src/persistence/JournalTypes.js';
import { InMemorySnapshotStore } from '../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import type { ReplayRequest, ReplayResult } from '../../../src/persistence/Replay.js';
import { JournalIntegrityError, replayState } from '../../../src/persistence/Replay.js';

type AddedEvent = { readonly kind: 'added'; readonly amount: number };
type CounterState = { readonly total: number };

const PERSISTENCE_ID = 'counter';

const foldCounter = (state: CounterState, event: AddedEvent): CounterState =>
  ({ total: state.total + event.amount });

function entry(sequenceNr: number, amount: number): PersistentEvent<AddedEvent> {
  return { persistenceId: PERSISTENCE_ID, sequenceNr, event: { kind: 'added', amount }, timestamp: 0 };
}

/**
 * Returns a fixed stream regardless of the requested window.  `highest`
 * is separate from the stream so a test can stage a snapshot without
 * tripping `assertTrustworthySnapshot` first — the two checks are
 * independent and each deserves its own failure.
 */
class ScriptedJournal implements Journal {
  constructor(
    private readonly stream: ReadonlyArray<PersistentEvent<AddedEvent>>,
    private readonly highest?: number,
  ) {}

  async append<E = unknown>(): Promise<PersistentEvent<E>[]> {
    throw new Error('ScriptedJournal is read-only');
  }

  async read<E = unknown>(): Promise<PersistentEvent<E>[]> {
    return [...this.stream] as unknown as PersistentEvent<E>[];
  }

  async highestSeq(): Promise<number> {
    if (this.highest !== undefined) return this.highest;
    return this.stream.reduce((top, event) => Math.max(top, event.sequenceNr), 0);
  }

  async delete(): Promise<void> {}

  async persistenceIds(): Promise<string[]> { return [PERSISTENCE_ID]; }
}

function replay(
  journal: Journal,
  extra: Partial<ReplayRequest<AddedEvent, CounterState>> = {},
): Promise<ReplayResult<CounterState>> {
  return replayState<AddedEvent, CounterState>({
    journal,
    persistenceId: PERSISTENCE_ID,
    initialState: () => ({ total: 0 }),
    fold: foldCounter,
    ...extra,
  });
}

describe('replayState journal integrity', () => {
  test('folds a well-formed stream unchanged', async () => {
    const result = await replay(new ScriptedJournal([entry(1, 1), entry(2, 2), entry(3, 3)]));

    expect(result.state).toEqual({ total: 6 });
    expect(result.sequenceNr).toBe(3);
    expect(result.eventsApplied).toBe(3);
  });

  test('an empty stream is not an integrity failure', async () => {
    const result = await replay(new ScriptedJournal([]));

    expect(result.state).toEqual({ total: 0 });
    expect(result.sequenceNr).toBe(0);
  });

  test('refuses the shuffled stream from the report', async () => {
    // The exploit from #122: [1, 3, 2] folds a withdrawal before its
    // deposit and ends with sequenceNr=2 while the journal holds 3.
    //
    // It is reported as a gap, not as a reorder, and that is not a
    // near miss: a permutation of a contiguous range always jumps
    // *forward* before it steps back, so contiguity catches it one
    // entry earlier than the backwards test would.  The message names
    // the first thing that is actually wrong at that point.
    const journal = new ScriptedJournal([entry(1, 1), entry(3, 3), entry(2, 2)]);

    await expect(replay(journal)).rejects.toThrow(JournalIntegrityError);
    await expect(replay(journal)).rejects.toThrow(/expected sequenceNr=2, got 3/);
  });

  test('refuses a sequence number that goes backwards', async () => {
    const journal = new ScriptedJournal([entry(1, 1), entry(2, 2), entry(1, 1)]);

    await expect(replay(journal)).rejects.toThrow(/out of order/);
  });

  test('refuses a repeated sequence number', async () => {
    const journal = new ScriptedJournal([entry(1, 1), entry(2, 2), entry(2, 2)]);

    await expect(replay(journal)).rejects.toThrow(/out of order/);
  });

  test('refuses a hole in the middle of the stream', async () => {
    // The half with an in-tree trigger: Cassandra claims a sequence
    // range before writing it, so a crash inside that window leaves
    // exactly this shape behind.
    const journal = new ScriptedJournal([entry(1, 1), entry(2, 2), entry(4, 4)]);

    await expect(replay(journal)).rejects.toThrow(JournalIntegrityError);
    await expect(replay(journal)).rejects.toThrow(/gap: expected sequenceNr=3, got 4/);
  });

  test('refuses a malformed sequence number', async () => {
    // 2^53 is an integer to `Number.isInteger` but not a safe one, and
    // past it `n + 1 === n` — contiguity would hold vacuously forever.
    for (const sequenceNr of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 53]) {
      const journal = new ScriptedJournal([entry(sequenceNr, 1)]);
      await expect(replay(journal)).rejects.toThrow(/malformed sequenceNr/);
    }
  });

  test('refuses an event the snapshot it started from already covers', async () => {
    const snapshotStore = new InMemorySnapshotStore();
    await snapshotStore.save(PERSISTENCE_ID, 5, { total: 5 });
    const journal = new ScriptedJournal([entry(4, 4)], 9);

    await expect(replay(journal, { snapshotStore })).rejects.toThrow(/already accounts for/);
  });

  test('refuses events past the requested bound', async () => {
    const journal = new ScriptedJournal([entry(1, 1), entry(2, 2), entry(3, 3)]);

    await expect(replay(journal, { toSequenceNr: 2 })).rejects.toThrow(/past the requested bound of 2/);
  });

  test('carries the persistence id and the offending sequence number', async () => {
    const journal = new ScriptedJournal([entry(1, 1), entry(4, 4)]);

    const failure = await replay(journal).then(() => null, (e: unknown) => e as JournalIntegrityError);
    expect(failure).toBeInstanceOf(JournalIntegrityError);
    expect(failure!.persistenceId).toBe(PERSISTENCE_ID);
    expect(failure!.sequenceNr).toBe(4);
    expect(failure!.name).toBe('JournalIntegrityError');
  });
});

describe('replayState compacted prefix', () => {
  test('refuses a stream starting past the fold, by default', async () => {
    // Recovery's case: events 1–2 were compacted away and no snapshot
    // covers them, so the current state is simply not reconstructible.
    const journal = new ScriptedJournal([entry(3, 3), entry(4, 4)]);

    await expect(replay(journal)).rejects.toThrow(JournalIntegrityError);
    await expect(replay(journal)).rejects.toThrow(/cannot be reconstructed/);
  });

  test('folds it anyway when the caller allows a compacted prefix', async () => {
    // Time travel's case: a read-only question about the past, answered
    // with what survives plus the sequence it actually reached.
    const journal = new ScriptedJournal([entry(3, 3), entry(4, 4)]);

    const result = await replay(journal, { allowCompactedPrefix: true });

    expect(result.state).toEqual({ total: 7 });
    expect(result.sequenceNr).toBe(4);
    expect(result.eventsApplied).toBe(2);
  });

  test('allowing a compacted prefix does not excuse a hole further in', async () => {
    const journal = new ScriptedJournal([entry(3, 3), entry(4, 4), entry(6, 6)]);

    await expect(replay(journal, { allowCompactedPrefix: true }))
      .rejects.toThrow(/gap: expected sequenceNr=5, got 6/);
  });

  test('allowing a compacted prefix does not excuse a sequence going backwards', async () => {
    const journal = new ScriptedJournal([entry(3, 3), entry(4, 4), entry(3, 3)]);

    await expect(replay(journal, { allowCompactedPrefix: true })).rejects.toThrow(/out of order/);
  });
});
