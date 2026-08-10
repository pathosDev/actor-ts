/**
 * Folding a journal back into state — the algorithm behind
 * `PersistentActor` recovery, extracted so it can also answer "what did
 * this state look like at sequence N?" (#201).
 *
 * Keeping one implementation matters more than the small amount of code
 * involved: the integrity checks below — one for what the snapshot
 * store claims, one for what the journal returns — are
 * security-relevant, and a debugger that reconstructed state by a
 * *slightly* different route would be free to disagree with what the
 * actor actually recovers, which is precisely the thing you are using
 * it to check.  Where the two consumers genuinely need to differ, they
 * say so through `ReplayRequest` rather than by forking the algorithm;
 * `allowCompactedPrefix` is the only such knob.
 */
import type { Journal } from './Journal.js';
import type { PersistentEvent } from './JournalTypes.js';
import type { SnapshotStore } from './SnapshotStore.js';
import type { PersistenceOptions } from './PersistenceOptions.js';
import type { EventAdapter, SnapshotAdapter } from './migration/Adapter.js';
import { decodeEvent, decodeState } from './migration/Envelope.js';

/** Everything a replay needs.  No `ActorSystem` and no actor instance. */
export interface ReplayRequest<Event, State> {
  readonly journal: Journal;
  /** Omit to fold from sequence 1 without a snapshot fast-path. */
  readonly snapshotStore?: SnapshotStore;
  readonly persistenceId: string;
  /** Starting value, as `PersistentActor.initialState()` would return. */
  initialState(): State;
  /** The pure fold — `PersistentActor.onEvent`. */
  fold(state: State, event: Event): State;
  /**
   * Stop after this sequence number.  Omit to replay everything, which
   * is what actor recovery does.
   */
  readonly toSequenceNr?: number;
  readonly eventAdapter?: EventAdapter<Event>;
  readonly snapshotAdapter?: SnapshotAdapter<State>;
  readonly persistenceOptions?: PersistenceOptions;
  /**
   * Tolerate a hole between the point the fold starts at and the first
   * event the journal returns — see `assertTrustworthyHistory`.
   *
   * Off by default, because for actor recovery such a hole means the
   * current state is not reconstructible, and folding the surviving tail
   * onto `initialState()` invents one that never existed.
   *
   * DevTools time travel turns it on.  It browses history through
   * `loadBefore`, so it routinely lands on a window whose covering
   * snapshot has been pruned while the events after the compaction point
   * are still there.  That is a read-only question about the past, not a
   * state anything will be persisted from, and a debugging panel that
   * refuses to open on a compacted entity is worse than one showing a
   * partial fold next to the sequence number it actually reached.
   */
  readonly allowCompactedPrefix?: boolean;
}

/** Outcome of a replay. */
export type ReplayResult<State> = {
  readonly state: State;
  /** Sequence number the state corresponds to; `0` when nothing applied. */
  readonly sequenceNr: number;
  /** Snapshot the fold started from, or `null` for a full replay. */
  readonly fromSnapshotSequenceNr: number | null;
  readonly eventsApplied: number;
};

/**
 * Rejected because a snapshot's claimed sequence number cannot be
 * trusted.  Distinct from a decode failure so a caller can tell
 * "corrupt data" from "someone tampered with the store".
 */
export class SnapshotIntegrityError extends Error {
  constructor(message: string, readonly persistenceId: string, readonly sequenceNr: number) {
    super(message);
    this.name = 'SnapshotIntegrityError';
  }
}

/**
 * Rejected because the event stream a journal returned cannot be
 * folded: out of order, a hole in the middle, a malformed sequence
 * number, or events outside the window that was asked for.
 *
 * Sibling of `SnapshotIntegrityError` rather than the same class,
 * because a journal and a snapshot store are separate trust domains
 * and the first thing an operator needs to know is which of the two
 * broke its contract.  `sequenceNr` is the offending event's.
 */
export class JournalIntegrityError extends Error {
  constructor(message: string, readonly persistenceId: string, readonly sequenceNr: number) {
    super(message);
    this.name = 'JournalIntegrityError';
  }
}

/** What a replayed slice has to fit inside — see `assertTrustworthyHistory`. */
type HistoryBounds = {
  readonly persistenceId: string;
  /** Sequence the fold starts at: a snapshot's, or 0. */
  readonly fromSequenceNr: number;
  /** Upper bound the read asked for, or `undefined` for "everything". */
  readonly toSequenceNr: number | undefined;
  readonly allowCompactedPrefix: boolean;
};

/**
 * Fold a persistence id back into state.
 *
 * With `toSequenceNr` the newest snapshot *before* that point is used,
 * so time travel is as cheap as recovery is; without it the newest
 * snapshot overall, which is what an actor wants on start-up.
 */
export async function replayState<Event, State>(
  request: ReplayRequest<Event, State>,
): Promise<ReplayResult<State>> {
  const { journal, snapshotStore, persistenceId, toSequenceNr, persistenceOptions } = request;

  let state = request.initialState();
  let sequenceNr = 0;
  let fromSnapshotSequenceNr: number | null = null;

  if (snapshotStore !== undefined) {
    const snapshot = toSequenceNr === undefined
      ? await snapshotStore.loadLatest<unknown>(persistenceId, persistenceOptions)
      // `loadBefore` is exclusive, so a snapshot taken exactly AT the
      // target is skipped and its events are replayed instead — the
      // result is identical and the code needs no special case.
      : await snapshotStore.loadBefore<unknown>(persistenceId, toSequenceNr + 1, persistenceOptions);

    if (snapshot.isSome()) {
      const claimed = snapshot.value.sequenceNr;
      await assertTrustworthySnapshot(journal, persistenceId, claimed);
      state = decodeState<State>(snapshot.value.state, request.snapshotAdapter);
      sequenceNr = claimed;
      fromSnapshotSequenceNr = claimed;
    }
  }

  const events = await journal.read<unknown>(persistenceId, sequenceNr + 1, toSequenceNr);
  assertTrustworthyHistory(events, {
    persistenceId,
    fromSequenceNr: sequenceNr,
    toSequenceNr,
    allowCompactedPrefix: request.allowCompactedPrefix === true,
  });
  for (const entry of events) {
    state = request.fold(state, decodeEvent<Event>(entry.event, request.eventAdapter));
    sequenceNr = entry.sequenceNr;
  }

  return { state, sequenceNr, fromSnapshotSequenceNr, eventsApplied: events.length };
}

/**
 * Refuse a snapshot whose sequence number cannot be believed.
 *
 * Two layers, because a snapshot store is a separate trust domain —
 * a shared bucket, a co-tenant, an insider.  Anyone able to write one
 * could otherwise craft `sequenceNr = MAX_SAFE_INTEGER` and have replay
 * skip every real event, recovering into a state of their choosing.
 */
async function assertTrustworthySnapshot(
  journal: Journal,
  persistenceId: string,
  claimed: number,
): Promise<void> {
  if (!Number.isInteger(claimed) || claimed < 0) {
    throw new SnapshotIntegrityError(
      `[persistence] '${persistenceId}' snapshot has malformed sequenceNr=${claimed} `
      + '— refusing to recover from a corrupted or tampered snapshot',
      persistenceId,
      claimed,
    );
  }
  // A snapshot AHEAD of a journal that has events for this id is the
  // classic attack: pump the sequence so replay skips everything.  An
  // empty journal is legitimate — state-only snapshots survive a
  // compaction or a migration.
  const highest = await journal.highestSeq(persistenceId);
  if (highest > 0 && claimed > highest) {
    throw new SnapshotIntegrityError(
      `[persistence] '${persistenceId}' snapshot claims sequenceNr=${claimed} `
      + `but journal's highest seq is ${highest} — refusing to recover from a `
      + 'corrupted or tampered snapshot (would silently skip event replay)',
      persistenceId,
      claimed,
    );
  }
}

/**
 * Refuse an event stream that does not keep the promise `Journal.read`
 * makes: ascending, contiguous, inside the requested window.
 *
 * The fold below *is* recovery, so the order these events arrive in is
 * the order history happened in as far as the actor is concerned.  A
 * journal that returns them shuffled rewrites the past silently —
 * non-commutative events land the wrong way round — and leaves
 * `sequenceNr` on the last *delivered* event rather than the highest
 * one, so the next `persist` sends a stale `expectedSeq` and every
 * append after recovery fails with a `JournalConcurrencyError` that has
 * no visible cause (#122).
 *
 * The two halves are worth different things.  **Ordering** has no
 * in-tree trigger — all eight built-in journals sort, Cassandra
 * explicitly — so it is the plugin contract being enforced against a
 * third-party journal missing an `ORDER BY`, a shared store a co-tenant
 * can write, an eventually-consistent read replica.  **Contiguity**
 * does fire on shipped code: `CassandraJournal.append` claims a
 * sequence range before writing it, and a crash inside that window
 * leaves a hole in the middle of the stream.
 *
 * Runs before the fold rather than inside it, so a stream that fails
 * never reaches user code and no half-applied state exists to reason
 * about.
 */
function assertTrustworthyHistory(
  events: ReadonlyArray<PersistentEvent<unknown>>,
  bounds: HistoryBounds,
): void {
  const { persistenceId, toSequenceNr } = bounds;
  let previous = bounds.fromSequenceNr;
  for (let index = 0; index < events.length; index++) {
    const sequenceNr = events[index]!.sequenceNr;
    // `isSafeInteger`, not `isInteger`: past 2^53 `n + 1 === n`, so a
    // pumped sequence number would satisfy the contiguity test below
    // forever while every real event went unread.
    if (!Number.isSafeInteger(sequenceNr) || sequenceNr < 1) {
      throw new JournalIntegrityError(
        `[persistence] '${persistenceId}' journal returned a malformed sequenceNr=${sequenceNr} `
        + `at position ${index} — refusing to fold an untrustworthy event stream`,
        persistenceId,
        sequenceNr,
      );
    }
    if (sequenceNr <= previous) {
      throw new JournalIntegrityError(
        index === 0
          ? `[persistence] '${persistenceId}' journal returned sequenceNr=${sequenceNr}, which the replay `
            + `start (${previous}) already accounts for — refusing to apply an event twice`
          : `[persistence] '${persistenceId}' journal returned events out of order: sequenceNr=${sequenceNr} `
            + `after ${previous} — refusing to fold history in an order it never happened in`,
        persistenceId,
        sequenceNr,
      );
    }
    if (sequenceNr > previous + 1 && !(index === 0 && bounds.allowCompactedPrefix)) {
      throw new JournalIntegrityError(
        index === 0
          ? `[persistence] '${persistenceId}' history starts at sequenceNr=${sequenceNr} but the fold starts `
            + `at ${previous} — the events in between are gone and no snapshot covers them, so the state `
            + 'cannot be reconstructed (compact only past a snapshot)'
          : `[persistence] '${persistenceId}' journal has a gap: expected sequenceNr=${previous + 1}, got `
            + `${sequenceNr} — refusing to recover a state those missing events never produced`,
        persistenceId,
        sequenceNr,
      );
    }
    if (toSequenceNr !== undefined && sequenceNr > toSequenceNr) {
      throw new JournalIntegrityError(
        `[persistence] '${persistenceId}' journal returned sequenceNr=${sequenceNr} past the requested `
        + `bound of ${toSequenceNr} — refusing to fold events outside the window that was asked for`,
        persistenceId,
        sequenceNr,
      );
    }
    previous = sequenceNr;
  }
}
