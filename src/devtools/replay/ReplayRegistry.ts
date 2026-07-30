/**
 * Where the time-travel panel finds a fold for a persistence id (#201).
 *
 * Reading a journal needs nothing but the journal.  Turning it back
 * into *state* needs the fold that produced it — `onEvent` — which
 * lives in the user's actor class and cannot be recovered from stored
 * data.  So the registry offers two tiers:
 *
 *   - **registered** — the application passed a fold in
 *     `DevToolsOptions.replayFolds`.  Works for any persistence id,
 *     including ids whose actor is not currently running.
 *   - **auto-captured** — a `PersistentActor` is alive right now, so
 *     its own `initialState` / `onEvent` are borrowed.  Free, and
 *     covers the common case of debugging something you can see.
 *
 * Anything else stays at `'events-only'`: the panel lists and diffs raw
 * events but does not pretend to know the state.
 */
import type { ActorSystem } from '../../ActorSystem.js';
import { PersistentActor } from '../../persistence/PersistentActor.js';
import { LocalActorRef } from '../../internal/LocalActorRef.js';
import type { ReplayRequest } from '../../persistence/Replay.js';
import type { ReplayCapability, ReplayFoldSource } from '../protocol/index.js';

/** A fold supplied by the application. */
export type ReplayFoldRegistration<Event = unknown, State = unknown> = {
  /** Which persistence ids this fold applies to. */
  match(persistenceId: string): boolean;
  initialState(): State;
  fold(state: State, event: Event): State;
  eventAdapter?: ReplayRequest<Event, State>['eventAdapter'];
  snapshotAdapter?: ReplayRequest<Event, State>['snapshotAdapter'];
};

/** A fold the registry managed to find, with its provenance. */
export type ResolvedFold<Event = unknown, State = unknown> = {
  readonly source: ReplayFoldSource;
  initialState(): State;
  fold(state: State, event: Event): State;
  readonly eventAdapter?: ReplayRequest<Event, State>['eventAdapter'];
  readonly snapshotAdapter?: ReplayRequest<Event, State>['snapshotAdapter'];
};

export class ReplayRegistry {
  constructor(
    private readonly system: ActorSystem,
    private readonly registrations: ReadonlyArray<ReplayFoldRegistration>,
    /** Whether to borrow folds from live actors.  Default on. */
    private readonly autoCapture: boolean,
  ) {}

  /** What this persistence id supports. */
  capabilityOf(persistenceId: string): ReplayCapability {
    return this.resolve(persistenceId) === null ? 'events-only' : 'state';
  }

  /** Where a fold for this id came from, or `'none'`. */
  sourceOf(persistenceId: string): ReplayFoldSource {
    return this.resolve(persistenceId)?.source ?? 'none';
  }

  /**
   * Find a fold, preferring an explicit registration.
   *
   * Explicit wins because it is a deliberate statement about how this
   * id folds; auto-capture is a convenience that happens to be
   * available while an actor is running.
   */
  resolve(persistenceId: string): ResolvedFold | null {
    const registered = this.registrations.find((entry) => entry.match(persistenceId));
    if (registered !== undefined) {
      return {
        source: 'registered',
        initialState: () => registered.initialState(),
        fold: (state, event) => registered.fold(state, event),
        ...(registered.eventAdapter === undefined ? {} : { eventAdapter: registered.eventAdapter }),
        ...(registered.snapshotAdapter === undefined ? {} : { snapshotAdapter: registered.snapshotAdapter }),
      };
    }
    return this.autoCapture ? this.captureFromLiveActor(persistenceId) : null;
  }

  /**
   * Borrow `initialState` / `onEvent` from a running `PersistentActor`.
   *
   * Safe because `onEvent` is documented as a pure fold — the same
   * contract recovery already relies on.  An impure one would make the
   * panel disagree with the actor, which is why the panel labels a
   * derived state as auto-captured rather than presenting it as fact.
   */
  private captureFromLiveActor(persistenceId: string): ResolvedFold | null {
    for (const cell of this.system._inspectTree()) {
      const actor = this.actorAt(cell.path);
      if (!(actor instanceof PersistentActor)) continue;
      const persistent = actor as PersistentActor<unknown, unknown, unknown>;
      if (persistent.persistenceId !== persistenceId) continue;
      return {
        source: 'auto-captured',
        initialState: () => persistent.initialState(),
        fold: (state, event) => persistent.onEvent(state, event),
        ...(persistent.eventAdapter() === undefined ? {} : { eventAdapter: persistent.eventAdapter()! }),
        ...(persistent.snapshotAdapter() === undefined
          ? {}
          : { snapshotAdapter: persistent.snapshotAdapter()! }),
      };
    }
    return null;
  }

  private actorAt(path: string): unknown {
    const segments = path.replace(/^actor-ts:\/\/[^/]*/, '').split('/').filter((s) => s.length > 0);
    return this.system._resolvePath(segments).fold(
      () => null as unknown,
      (ref) => (ref instanceof LocalActorRef ? ref.getCell()._actorForInspection() : null),
    );
  }
}
