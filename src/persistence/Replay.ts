/**
 * Folding a journal back into state — the algorithm behind
 * `PersistentActor` recovery, extracted so it can also answer "what did
 * this state look like at sequence N?" (#201).
 *
 * Keeping one implementation matters more than the small amount of code
 * involved: the snapshot-tampering checks below are security-relevant,
 * and a debugger that reconstructed state by a *slightly* different
 * route would be free to disagree with what the actor actually
 * recovers — which is precisely the thing you are using it to check.
 */
import type { Journal } from './Journal.js';
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
}

/** Outcome of a replay. */
export interface ReplayResult<State> {
  readonly state: State;
  /** Sequence number the state corresponds to; `0` when nothing applied. */
  readonly sequenceNr: number;
  /** Snapshot the fold started from, or `null` for a full replay. */
  readonly fromSnapshotSequenceNr: number | null;
  readonly eventsApplied: number;
}

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
