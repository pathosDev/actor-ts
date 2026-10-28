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
 * say so through `ReplayRequest` rather than by forking the algorithm.
 * There are two such knobs, both off by default and both narrow:
 * `allowCompactedPrefix`, which DevTools turns on, and
 * `snapshotIsOptional`, which actor recovery takes from config.  Where
 * they need to *guard* it differently — recovery puts each store behind
 * its own circuit breaker, time travel behind none — the algorithm is cut
 * into phases instead (see `replayState`), so the guarding stays with the
 * caller and the steps stay here.
 */
import type { Journal } from './Journal.js';
import type { PersistentEvent, Snapshot } from './JournalTypes.js';
import type { Option } from '../util/Option.js';
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
  /**
   * Fall back to a full journal replay when the snapshot store cannot answer
   * at all, instead of failing (`actor-ts.persistence.snapshot-is-optional`,
   * #874).  Off by default.
   *
   * The second knob `ReplayRequest` carries for the same reason the first
   * one does: the two consumers differ here, and saying so is cheaper than
   * forking the algorithm.  Actor recovery supplies it from config; DevTools
   * time travel does not — a panel that answered a question about the past
   * from a fold that silently skipped the snapshot would be showing a state
   * the actor never had.
   *
   * **Three things it does not do**, each deliberate:
   *
   *   - It never applies when `persistenceOptions.integrity` or `.encryption`
   *     is set.  A store rejecting a tampered body and a store that is simply
   *     down both surface as a rejected `loadLatest`, so tolerating one would
   *     tolerate the other and turn #100's integrity control into a retry.
   *   - It never swallows a `SnapshotIntegrityError`, whichever layer raised
   *     it — the check below or a store that verifies its own bodies.
   *   - It does not cover the fold: `assertTrustworthySnapshot` and
   *     `decodeState` run outside the guarded region, so a snapshot that
   *     loaded and then failed to be believed still fails the recovery.
   */
  readonly snapshotIsOptional?: boolean;
  /**
   * Called with the swallowed error when {@link snapshotIsOptional} turns a
   * failed snapshot load into a full replay.
   *
   * A callback rather than a logger because `replayState` takes no
   * `ActorSystem` and must not start taking one — and because the fallback is
   * a fact the *caller* has to be able to report at its own level: for
   * `PersistentActor` it is a `warn` naming the persistence id, and for a
   * consumer that does not set the flag it never fires at all.
   */
  readonly onSnapshotLoadFailure?: (error: Error) => void;
  /**
   * Runs the snapshot-store call — the seam `PersistentActor` puts its
   * snapshot breaker behind (#1496).  Omitted, the store is called directly,
   * which is what DevTools time travel does.
   *
   * It wraps the store call and nothing around it.  The
   * {@link snapshotIsOptional} tolerance sits *outside*, so a breaker that
   * fast-fails while open reads exactly like a store that cannot answer:
   * tolerated where an unreachable store is tolerated, fatal where it is
   * fatal — and never tolerated for an actor that asked for integrity or
   * encryption.  That is only sound because nothing but a failed load opens
   * the breaker `PersistentActor` puts here: an open one says loads have been
   * failing.  A store that refuses saves or deletes and reads fine never opens
   * it, so it cannot fail such an actor's recovery on another entity's
   * account.
   */
  readonly guardSnapshotLoad?: (
    load: () => Promise<Option<Snapshot<unknown>>>,
  ) => Promise<Option<Snapshot<unknown>>>;
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
 * What the journal half of a replay hands the fold: the starting point and
 * the events after it, both already checked against the journal and neither
 * decoded yet.
 */
export type ReplayHistory = {
  /**
   * The snapshot the fold starts from, its claimed sequence number already
   * checked against the journal's head; `null` to start from
   * `initialState()`.
   */
  readonly snapshot: Snapshot<unknown> | null;
  /** The events after it — ascending, contiguous, inside the asked-for window. */
  readonly events: ReadonlyArray<PersistentEvent<unknown>>;
  /**
   * The sequence a fold of this history ends at: the last event's, else the
   * snapshot's, else `0`.  Known before the fold runs, which is what lets a
   * caller decide on a head probe inside its journal call (#628).
   */
  readonly sequenceNr: number;
};

/**
 * Fold a persistence id back into state.
 *
 * With `toSequenceNr` the newest snapshot *before* that point is used,
 * so time travel is as cheap as recovery is; without it the newest
 * snapshot overall, which is what an actor wants on start-up.
 *
 * Three phases, each exported so a caller can guard them separately —
 * `PersistentActor` puts the first behind its snapshot breaker, the second
 * behind its journal breaker, and runs the third behind neither:
 *
 *   1. {@link loadReplaySnapshot} — the snapshot store's one call.
 *   2. {@link readReplayHistory} — the journal's calls and the checks on what
 *      it returned.
 *   3. {@link foldReplayHistory} — decoding and the fold, which is user code
 *      and touches no store.
 *
 * DevTools time travel runs them back to back through this function.  The
 * split is #1496's repair to #874: run inside one journal call, a snapshot
 * store that could not answer and an `onEvent` that could not fold were both
 * counted against a journal that had answered, and ten restarting entities
 * of either kind opened the journal breaker for the whole node.
 */
export async function replayState<Event, State>(
  request: ReplayRequest<Event, State>,
): Promise<ReplayResult<State>> {
  const snapshot = await loadReplaySnapshot(request);
  return foldReplayHistory(request, await readReplayHistory(request, snapshot));
}

/**
 * Phase 1 of {@link replayState}: the snapshot the fold starts from, or `null`
 * when it starts from `initialState()`.
 */
export async function loadReplaySnapshot<Event, State>(
  request: ReplayRequest<Event, State>,
): Promise<Snapshot<unknown> | null> {
  const { snapshotStore, persistenceId, toSequenceNr, persistenceOptions } = request;
  if (snapshotStore === undefined) return null;
  const load = (): Promise<Option<Snapshot<unknown>>> => (toSequenceNr === undefined
    ? snapshotStore.loadLatest<unknown>(persistenceId, persistenceOptions)
    // `loadBefore` is exclusive, so a snapshot taken exactly AT the
    // target is skipped and its events are replayed instead — the
    // result is identical and the code needs no special case.
    : snapshotStore.loadBefore<unknown>(persistenceId, toSequenceNr + 1, persistenceOptions));
  const guard = request.guardSnapshotLoad;
  // `null` is "there is no snapshot to consider", which a tolerated load
  // failure and an empty store reach by different routes and mean the same
  // thing about the fold.  Only the load itself is guarded — the integrity
  // check and the decode in the later phases stay outside on purpose; see
  // `ReplayRequest.snapshotIsOptional`.
  const snapshot = await loadSnapshotOrNull(
    guard === undefined ? load : () => guard(load),
    request,
    persistenceOptions,
  );
  return snapshot !== null && snapshot.isSome() ? snapshot.value : null;
}

/**
 * Phase 2 of {@link replayState}: check the snapshot's claim against the
 * journal's head, read the events after it, and check those.
 *
 * Every journal call a replay makes, plus the verdicts on what the journal
 * returned — and nothing that runs user code, so a guard around this phase
 * counts what the journal said and only that.  `snapshot` is what
 * {@link loadReplaySnapshot} returned for the same `request`.
 */
export async function readReplayHistory<Event, State>(
  request: ReplayRequest<Event, State>,
  snapshot: Snapshot<unknown> | null,
): Promise<ReplayHistory> {
  const { journal, persistenceId, toSequenceNr } = request;
  const fromSequenceNr = snapshot === null ? 0 : snapshot.sequenceNr;
  if (snapshot !== null) await assertTrustworthySnapshot(journal, persistenceId, fromSequenceNr);
  const events = await journal.read<unknown>(persistenceId, fromSequenceNr + 1, toSequenceNr);
  assertTrustworthyHistory(events, {
    persistenceId,
    fromSequenceNr,
    toSequenceNr,
    allowCompactedPrefix: request.allowCompactedPrefix === true,
  });
  return { snapshot, events, sequenceNr: events[events.length - 1]?.sequenceNr ?? fromSequenceNr };
}

/**
 * Phase 3 of {@link replayState}: decode the snapshot and the events and run
 * them through `request.fold`.
 *
 * Synchronous and store-free on purpose.  The fold is user code, and a throw
 * from it — or from an upcaster in `decodeEvent` / `decodeState` — is a
 * verdict on one entity's history that no amount of waiting changes, so it
 * must never be read as the journal being unavailable.  The snapshot is
 * decoded here rather than when it is loaded, after the read: its claim has
 * to be checked against the journal before its state is believed, and the
 * check is a journal call.
 */
export function foldReplayHistory<Event, State>(
  request: ReplayRequest<Event, State>,
  history: ReplayHistory,
): ReplayResult<State> {
  const { snapshot, events } = history;
  let state = snapshot === null
    ? request.initialState()
    : decodeState<State>(snapshot.state, request.snapshotAdapter);
  for (const entry of events) {
    state = request.fold(state, decodeEvent<Event>(entry.event, request.eventAdapter));
  }
  return {
    state,
    sequenceNr: history.sequenceNr,
    fromSnapshotSequenceNr: snapshot === null ? null : snapshot.sequenceNr,
    eventsApplied: events.length,
  };
}

/**
 * Load the covering snapshot, returning `null` instead of throwing when the
 * store could not answer and {@link ReplayRequest.snapshotIsOptional} allows
 * the fold to start from scratch.
 *
 * The two carve-outs are the whole of the security argument, and both are
 * *structural* rather than a matter of recognising the right error class:
 *
 *   - A `SnapshotIntegrityError` is re-thrown whoever raised it.
 *   - An actor whose `persistenceOptions` carry `integrity` or `encryption`
 *     gets no fallback at all.  Those stores reject a body that fails to
 *     verify with a plain `Error` — there is no typed verdict to match on —
 *     so the only way not to swallow a tampered snapshot is not to swallow
 *     anything for an actor that asked for the check.
 *
 * Exported for `ReplicatedEventSourcedActor`, whose recovery loads a snapshot
 * of its own shape and folds no `ReplayRequest` (#1497): it reads only the two
 * fields below, and generic over what `load` yields, so the carve-outs keep
 * this one home instead of a copy that could drift from it.
 */
export async function loadSnapshotOrNull<Loaded>(
  load: () => Promise<Loaded>,
  request: Pick<ReplayRequest<unknown, unknown>, 'snapshotIsOptional' | 'onSnapshotLoadFailure'>,
  persistenceOptions: PersistenceOptions | undefined,
): Promise<Loaded | null> {
  // `{ mode: 'none' }` is a control that was explicitly turned off, so it
  // carries no verdict for a rejection to be mistaken for — the same reading
  // `unhonouredPersistenceOptions` takes of the field.
  const protectedSnapshot = (persistenceOptions?.integrity !== undefined
      && persistenceOptions.integrity.mode !== 'none')
    || (persistenceOptions?.encryption !== undefined
      && persistenceOptions.encryption.mode !== 'none');
  const tolerated = request.snapshotIsOptional === true && !protectedSnapshot;
  if (!tolerated) return load();
  try {
    return await load();
  } catch (e) {
    if (e instanceof SnapshotIntegrityError) throw e;
    request.onSnapshotLoadFailure?.(e instanceof Error ? e : new Error(String(e)));
    return null;
  }
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
