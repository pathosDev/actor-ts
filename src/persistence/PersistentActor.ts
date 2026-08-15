import { Actor } from '../Actor.js';
import type { Lease } from '../coordination/Lease.js';
import type { Journal } from './Journal.js';
import { JournalConcurrencyError } from './JournalTypes.js';
import type { PersistentEvent, Snapshot } from './JournalTypes.js';
import { PersistenceExtensionId } from './PersistenceExtension.js';
import type {
  CompressionConfig,
  EncryptionConfig,
  PersistenceOptions,
} from './PersistenceOptions.js';
import type { SnapshotStore } from './SnapshotStore.js';
import { replayState } from './Replay.js';
import { assertValidPersistenceId } from './storage/PersistenceIdValidator.js';
import type { EventAdapter, SnapshotAdapter } from './migration/Adapter.js';
import {
  decodeEvent,
  decodeState,
  encodeEvent,
  encodeState,
} from './migration/Envelope.js';

/**
 * How often to take snapshots — called after every event apply.  Returning
 * true means "snapshot the current state".
 */
export type SnapshotPolicy<State, Event> = (
  seq: number,
  state: State,
  event: Event,
) => boolean;

/** Convenience: snapshot every N events. */
export function everyNEvents<State, Event>(n: number): SnapshotPolicy<State, Event> {
  if (n <= 0) throw new Error('everyNEvents expects a positive number');
  return (seq) => seq > 0 && seq % n === 0;
}

/**
 * Classic-style event-sourced actor.  Subclasses override `onCommand`
 * (which decides what to persist), `onEvent` (pure state update from the
 * event), and optionally `onRecoveryComplete`.  Commands are automatically
 * stashed while `persist(...)` is pending, so user code can assume the
 * state is caught up by the time its callback fires.
 *
 *   class AccountActor extends PersistentActor<Command, Event, State> {
 *     readonly persistenceId = 'account-42';
 *     initialState(): State { return { balance: 0 }; }
 *     onEvent(state: State, e: Event): State {
 *       if (e.kind === 'deposited') return { balance: state.balance + e.amount };
 *       return state;
 *     }
 *     onCommand(state: State, command: Command): void {
 *       if (command.kind === 'deposit') {
 *         this.persist({ kind: 'deposited', amount: command.amount }, (s) => {
 *           this.sender.forEach(replyTo => replyTo.tell({ ok: s.balance }));
 *         });
 *       }
 *     }
 *   }
 */
export abstract class PersistentActor<Command, Event, State> extends Actor<Command> {
  abstract readonly persistenceId: string;

  /** Default initial state when no snapshot and no events exist. */
  abstract initialState(): State;

  /**
   * Pure state-update function — MUST be deterministic, and is
   * deliberately synchronous where `onCommand` is async.
   *
   * A command decides and therefore does I/O (`persist` writes to the
   * journal); an event is already a fact, and folding a fact into state
   * is arithmetic.  Anything you would want to `await` here — a read, a
   * notification — is precisely what must NOT run again on recovery.
   * Put it in the `persist` callback or `onRecoveryComplete`, neither of
   * which replay.
   *
   * Read `state` from the parameter, never `this.state`: during replay
   * this runs detached inside `replayState`, before `this.state` has
   * been assigned, and the DevTools time-travel panel borrows it as a
   * free fold.  A handler that reads `this.state` works on the persist
   * path and fails only after a restart.
   */
  abstract onEvent(state: State, event: Event): State;

  /** Handle an incoming command — typically calls `persist(event, afterPersist)`. */
  abstract onCommand(state: State, command: Command): void | Promise<void>;

  /** Called once recovery finishes, with the final replayed state. */
  onRecoveryComplete(_state: State): void | Promise<void> {}

  /**
   * Called when recovery itself throws.
   *
   * A notification, not a decision — recovery failure is terminal either
   * way.  The default rethrows, so the failure reaches supervision as an
   * `ActorInitializationError`.  An override that returns normally takes
   * the failure as handled, and the actor is then stopped: `state` was
   * never assigned and `lastSequenceNr` is unknown, so there is no state
   * in which it could answer a command.  Pending commands go to dead
   * letters rather than disappearing.
   */
  onRecoveryFailure(reason: Error): void { throw reason; }

  /** Snapshot policy — return true to snapshot the current state. */
  snapshotPolicy(): SnapshotPolicy<State, Event> { return () => false; }

  /** Optional tags attached to every persisted event (for Persistence Query). */
  tagsFor(_event: Event): ReadonlyArray<string> | undefined { return undefined; }

  /**
   * Optional event adapter for schema evolution.  When defined, every
   * persisted event is wrapped into a `{ _v, _t, _e }` envelope on the
   * write path and unwrapped (with up-casting through the adapter) on
   * the read path.  Recovery is **strict** when an adapter is set: a
   * raw, non-envelope event in the journal will throw `MigrationError`.
   * See `src/persistence/migration/`.
   */
  eventAdapter(): EventAdapter<Event> | undefined { return undefined; }

  /**
   * Optional snapshot adapter — same semantics as `eventAdapter`, but
   * applied to the `state` blob persisted by the snapshot store.  When
   * a snapshot adapter is set and a stored snapshot is not an envelope,
   * recovery throws.
   */
  snapshotAdapter(): SnapshotAdapter<State> | undefined { return undefined; }

  /**
   * Per-actor compression — overrides the plugin default for THIS actor's
   * snapshots.  Stores that don't compress (in-memory, SQLite, Cassandra)
   * ignore the value.  Returning `undefined` (the default) defers to the
   * plugin's resolver / configured default.
   */
  compression(): CompressionConfig | undefined { return undefined; }

  /**
   * Per-actor encryption — overrides the plugin default for THIS actor's
   * snapshots.  Honoured by stores that encrypt at rest (object-storage);
   * other stores ignore it.  Used on both the write path (encrypt) and
   * the read path (derive subkey from master to decrypt).
   */
  encryption(): EncryptionConfig | undefined { return undefined; }

  /* ----------------------------- Internal state ---------------------------- */

  private _state!: State;
  private _seq = 0;
  private _journal!: Journal;
  private _snapshotStore!: SnapshotStore;
  private _recovering = true;
  /** Set while a persist is in flight — incoming commands get stashed. */
  private _persisting = false;
  private _pendingCallbacks: Array<(state: State) => void | Promise<void>> = [];

  /** Current state — only reliable after recovery. */
  protected get state(): State { return this._state; }

  /** Highest sequence number reflected in `state`. */
  protected get lastSequenceNr(): number { return this._seq; }

  /** True while the actor is still replaying history. */
  protected get recovering(): boolean { return this._recovering; }

  /* ------------------------------- Fencing --------------------------------- */

  private _lease: Lease | null = null;
  /** No lease configured means every instance is its own writer, as before. */
  private _isLeaseHolder = true;
  private _leaseUnsubscribeLost: (() => void) | null = null;

  /**
   * Whether this instance may write.  Always `true` when {@link lease} returns
   * `null`; otherwise it tracks the lease.  Gate side-effecting work on it to
   * avoid the throw from `persist`.
   */
  protected get isLeaseHolder(): boolean { return this._isLeaseHolder; }

  /**
   * Optional fencing (#1166) — return a `Lease` and this entity becomes
   * single-writer: only the holder recovers and persists, and a non-holder
   * refuses to write rather than discovering the conflict at its next append.
   * Default `null`, which is the behaviour every existing actor already has.
   *
   * Why it matters, and why the journal being safe is not enough.  After a
   * partition plus a sharding rebalance — or any orchestration mistake that
   * spawns one entity twice — two instances of a persistence-id both recover
   * and both accept commands.  The conditional write means one of them loses
   * with `JournalConcurrencyError`, so the *journal* stays sound.  The damage
   * is outside it: by the time the loser finds out it has already run
   * `onCommand`, and any non-replayable side effect it performed — charging a
   * card, sending a mail, calling a downstream — is not rolled back.  Until
   * its next `persist` it also serves reads from state it no longer owns.
   *
   * A lease closes that window from the other end: the loser never becomes a
   * writer in the first place, so the side effect never fires twice.
   *
   * Mechanics mirror {@link ReplicatedEventSourcedActor.lease}: `preStart`
   * calls `acquire()` **before recovery**, so an instance that does not own
   * the entity never reads its history either.  Losing the lease flips the
   * actor to non-holder and calls {@link onLeaseLost}; regaining it is
   * restart-driven.
   */
  protected lease(): Lease | null { return null; }

  /**
   * Called when a held lease is lost — a TTL expiry, a fence from another
   * holder, a backend hiccup.  The actor is already a non-holder by the time
   * this runs and every later `persist` will throw.  Default: stop, because a
   * `PersistentActor` that cannot write is not usefully alive; override to
   * keep serving reads instead.
   */
  protected onLeaseLost(_reason: string): void | Promise<void> {
    this.context.stopSelf();
  }

  /* ----------------------------- Lifecycle API ----------------------------- */

  override async preStart(): Promise<void> {
    // Before the journal is even resolved, and deliberately OUTSIDE the
    // recovery guard below: an id that cannot be a storage key is a
    // programming error in this class, not a journal failure, so it must
    // not reach `onRecoveryFailure` — an override that swallows recovery
    // errors would otherwise swallow this one and leave the actor running
    // against a key nobody can address.  It surfaces as an
    // `ActorInitializationError` and supervision decides.
    assertValidPersistenceId(this.persistenceId, 'PersistentActor');
    const ext = this.system.extension(PersistenceExtensionId);
    this._journal = ext.journal;
    this._snapshotStore = ext.snapshotStore;
    // Fencing, before recovery on purpose (#1166): an instance that does not
    // own this entity must not read its history either, or it spends the
    // window until its first write serving answers from state another writer
    // is already moving on.
    await this.acquireLeaseIfConfigured();
    try {
      await this.recover();
    } catch (e) {
      const reason = e instanceof Error ? e : new Error(String(e));
      // Rethrows by default, and then this is the last line that runs:
      // ActorCell.onCreate turns it into an ActorInitializationError and
      // supervision decides.
      this.onRecoveryFailure(reason);
      // The hook returned, so it owns the failure — but it cannot own the
      // actor.  `_state` was never assigned and `_recovering` is still
      // true, so every command would be stashed, silently, until #1025
      // overflows the 1024-entry stash and throws from inside the handler
      // — a supervision restart 1024 messages away from its cause, whose
      // recovery fails and gets swallowed again.  Stop instead.
      //
      // `stopSelf` enqueues a system message, and the cell drains those
      // ahead of every user message, so nothing reaches `onReceive`
      // without a state and whatever is already queued becomes dead
      // letters.
      this.log.error(
        `[persistence] '${this.persistenceId}' recovery failed and onRecoveryFailure `
        + 'returned without rethrowing — stopping the actor',
        reason,
      );
      this.context.stopSelf();
      return;
    }
    // Post-recovery user code, deliberately OUTSIDE the guard above.  A
    // throw in `onRecoveryComplete` is an ordinary actor failure, not a
    // recovery failure: routing it through `onRecoveryFailure` blamed the
    // journal for a bug in the hook, and — with an override that swallows
    // — stranded an actor whose state had recovered perfectly.
    this._recovering = false;
    try {
      await this.onRecoveryComplete(this._state);
    } finally {
      // Only reachable when a subclass starts recovery without awaiting
      // it — on every normal path the commands are still in the mailbox,
      // never the stash.  Draining in `finally` keeps them across a
      // failing hook instead of letting them die with the instance.
      this.context.unstashAll();
    }
  }

  /** Replay snapshot + journal into `_state` / `_seq`.  Runs no user callbacks. */
  private async recover(): Promise<void> {
    this.log.debug(`[persistence] '${this.persistenceId}' recovery starting`);
    // The fold, the snapshot fast-path and the two integrity checks —
    // snapshot (#100) and journal (#122) — all live in `replayState`,
    // shared with the DevTools time-travel panel (#201).  One
    // implementation means a debugger reconstructing state cannot
    // quietly disagree with what the actor itself recovers — which is
    // the whole reason to look at it.
    //
    // Recovery takes the strict end of the journal check: no
    // `allowCompactedPrefix`.  A hole between the starting point and the
    // first surviving event means this entity's *current* state is not
    // reconstructible, and folding the tail onto `initialState()` would
    // hand `onCommand` a state that never existed.  A loud
    // `JournalIntegrityError` through `onRecoveryFailure` is the only
    // honest answer; the panel, which asks about the past rather than
    // the present, opts out of that half.
    const result = await replayState<Event, State>({
      journal: this._journal,
      snapshotStore: this._snapshotStore,
      persistenceId: this.persistenceId,
      initialState: () => this.initialState(),
      fold: (state, event) => this.onEvent(state, event),
      ...(this.eventAdapter() === undefined ? {} : { eventAdapter: this.eventAdapter()! }),
      ...(this.snapshotAdapter() === undefined ? {} : { snapshotAdapter: this.snapshotAdapter()! }),
      ...(this.persistenceOptions() === undefined ? {} : { persistenceOptions: this.persistenceOptions()! }),
    });
    this._state = result.state;
    this._seq = result.sequenceNr;
    if (this._seq === 0) {
      // Replay found nothing — either a brand-new actor, or a journal
      // compacted past everything it held.  Only the journal's high-water
      // mark tells those apart, and `replayState` cannot do it for us: it is
      // shared with DevTools time travel, where the sequence must stay at
      // whatever the requested point in history was.
      //
      // Getting it wrong is permanent.  Since #379 a backend remembers what
      // it deleted, so `highestSeq` still reports N after a full compaction
      // while recovery reported 0 — and the next `persist` sends
      // expectedSeq=0 into a journal that has seen N, failing with
      // `JournalConcurrencyError` on every attempt, forever (#628).
      //
      // For a new actor `highestSeq` is 0, so this costs one query only when
      // there was nothing to replay anyway.
      this._seq = await this._journal.highestSeq(this.persistenceId);
    }
    if (result.fromSnapshotSequenceNr !== null) {
      this.log.debug(`[persistence] '${this.persistenceId}' loaded snapshot @seq=${result.fromSnapshotSequenceNr}`);
    }
    this.log.debug(
      `[persistence] '${this.persistenceId}' recovery complete: replayed ${result.eventsApplied} event(s), seq=${this._seq}`,
    );
  }

  override async postStop(): Promise<void> {
    this._leaseUnsubscribeLost?.();
    this._leaseUnsubscribeLost = null;
    // Release rather than wait out the TTL, so the next owner can start now.
    if (this._lease && this._isLeaseHolder) {
      await this._lease.release().catch(() => { /* best-effort */ });
    }
    this._lease = null;
  }

  /** Acquire the optional fencing lease and wire up its loss handler. */
  private async acquireLeaseIfConfigured(): Promise<void> {
    this._lease = this.lease();
    if (!this._lease) return;
    this._isLeaseHolder = await this._lease.acquire();
    if (!this._isLeaseHolder) {
      this.log.warn(
        `[persistence] '${this.persistenceId}': lease is held elsewhere — `
        + `this instance will not write`,
      );
      return;
    }
    this._leaseUnsubscribeLost = this._lease.onLost((reason) => {
      this._isLeaseHolder = false;
      this.log.warn(
        `[persistence] '${this.persistenceId}': lease lost — this instance may no longer write`,
        { reason },
      );
      try {
        const result = this.onLeaseLost(reason);
        if (result instanceof Promise) result.catch((e) => this.log.warn('onLeaseLost threw', e));
      } catch (e) {
        this.log.warn('onLeaseLost threw', e);
      }
    });
  }

  override async onReceive(message: Command): Promise<void> {
    if (this._recovering || this._persisting) {
      this.context.stash();
      return;
    }
    await this.onCommand(this._state, message);
  }

  /**
   * Persist a single event.  The callback runs once the event has been
   * applied to the state — use it to reply to the sender.  Further
   * incoming commands are deferred until the callback returns.
   */
  protected async persist(
    event: Event,
    afterPersist?: (state: State) => void | Promise<void>,
  ): Promise<void> {
    await this.persistAll([event], afterPersist);
  }

  /** Persist several events atomically.  Must also be awaited in onCommand. */
  protected async persistAll(
    events: ReadonlyArray<Event>,
    afterPersist?: (state: State) => void | Promise<void>,
  ): Promise<void> {
    if (events.length === 0) { await afterPersist?.(this._state); return; }
    // Refuse before writing rather than after: the whole point of the lease is
    // that a non-owner never becomes a writer, so its side effects never fire
    // a second time (#1166).
    if (this._lease && !this._isLeaseHolder) {
      throw new Error(
        `PersistentActor '${this.persistenceId}': cannot persist — this instance does not `
        + `hold the entity's lease (another instance owns it, or the lease was lost). `
        + `Gate on \`this.isLeaseHolder\` to avoid this.`,
      );
    }
    this._persisting = true;
    try {
      // Collect tags from the first event — tags are per-event but a single
      // persistAll keeps them grouped so they share the same tag set.
      const tags = this.tagsFor(events[0]!);
      // If an event adapter is active, wrap each event into a `{_v,_t,_e}`
      // envelope before handing it to the journal.  Domain events stay in-
      // memory unchanged so `onEvent` and `snapshotPolicy` see the original
      // (current-version) shape.
      const evAdapter = this.eventAdapter();
      const wireEvents: ReadonlyArray<unknown> = evAdapter
        ? events.map((e) => encodeEvent(e, evAdapter))
        : events;
      let written: ReadonlyArray<PersistentEvent<unknown>>;
      try {
        written = await this._journal.append<unknown>(
          this.persistenceId, wireEvents, this._seq, tags,
        );
      } catch (e) {
        if (e instanceof JournalConcurrencyError) this.onSecondWriterDetected(e);
        throw e;
      }
      this.log.debug(
        `[persistence] '${this.persistenceId}' persisted ${written.length} event(s) → seq=${written[written.length - 1]?.sequenceNr ?? this._seq}`,
      );
      const policy = this.snapshotPolicy();
      let shouldSnapshot = false;
      for (let i = 0; i < written.length; i++) {
        const pe = written[i]!;
        const domainEvent = events[i]!;  // pre-envelope domain shape
        this._state = this.onEvent(this._state, domainEvent);
        this._seq = pe.sequenceNr;
        if (policy(pe.sequenceNr, this._state, domainEvent)) shouldSnapshot = true;
      }
      if (shouldSnapshot) await this.saveSnapshotNow();
      await afterPersist?.(this._state);
      // Drain any callbacks queued while we were busy (nested persists).
      while (this._pendingCallbacks.length > 0) {
        const next = this._pendingCallbacks.shift()!;
        await next(this._state);
      }
    } finally {
      this._persisting = false;
      // Replay messages stashed during the persist.
      this.context.unstashAll();
    }
  }

  /**
   * A conditional append lost, which means someone else moved this entity's
   * journal head — a second live instance of the same persistence-id (#1166).
   *
   * The important part is what this prevents rather than what it does.  The
   * error propagates out of `persistAll` → `onCommand` → `onReceive` as an
   * ordinary actor failure, and the default supervision answer to that is a
   * *restart* — after which the actor recovers the now-foreign journal head
   * and carries on serving reads and side effects as if it owned the entity.
   * A conflict is not a transient fault to retry through; it is evidence that
   * this instance is the loser of an ownership race, and the only safe answer
   * is to stop.
   *
   * The stop is enqueued as a system command from inside the failing turn, so
   * it is queued ahead of anything the supervisor decides in response to the
   * failure that follows.  `_isLeaseHolder` is cleared too, so any `persist`
   * that still reaches this instance is refused up front rather than racing
   * the teardown.
   *
   * This is the backstop, not the fence: it fires *after* the losing instance
   * has already run `onCommand` for the current command, so a non-replayable
   * side effect in that handler has already happened.  Configure {@link lease}
   * for entities where that matters.
   */
  private onSecondWriterDetected(error: JournalConcurrencyError): void {
    this._isLeaseHolder = false;
    this.log.error(
      `[persistence] '${this.persistenceId}': conditional append lost — another live instance `
      + `owns this entity. Stopping rather than restarting into a stale second writer.`,
      error,
    );
    this.context.stopSelf();
  }

  /** Force a snapshot of the current state. */
  protected async saveSnapshot(): Promise<Snapshot<State>> {
    return this.saveSnapshotNow();
  }

  private async saveSnapshotNow(): Promise<Snapshot<State>> {
    const snapAdapter = this.snapshotAdapter();
    const wire = snapAdapter ? encodeState(this._state, snapAdapter) : this._state;
    // The store is generic over <State>; when we wrap, we store an envelope
    // and the cast simply re-exposes the typed state to the caller.
    return this._snapshotStore.save(
      this.persistenceId, this._seq, wire as unknown as State, this.persistenceOptions(),
    );
  }

  /**
   * Build the per-call `PersistenceOptions` from the actor's hooks.
   * Returns `undefined` when neither hook is set so the store defaults
   * (plugin resolver / config) take effect with zero overhead.
   */
  private persistenceOptions(): PersistenceOptions | undefined {
    const compression = this.compression();
    const encryption = this.encryption();
    if (!compression && !encryption) return undefined;
    return { compression, encryption };
  }

  /**
   * Compact past `toSeq`: drop the events up to and including it, and the
   * snapshots that came *before* it.
   *
   * The snapshot at `toSeq` is deliberately kept.  `SnapshotStore.delete` is
   * documented as inclusive, so deleting up to `toSeq` destroyed the very
   * snapshot the compaction is compacting *past* — leaving an actor with no
   * snapshot and no events, and, before #628, a recovered sequence of 0 that
   * blocked every later `persist` (#629).
   *
   * `toSeq <= 0` prunes nothing, which is what "compact past the beginning"
   * should mean.
   */
  protected async deleteHistory(toSeq: number): Promise<void> {
    if (toSeq <= 0) return;
    await this._snapshotStore.delete(this.persistenceId, toSeq - 1);
    await this._journal.delete(this.persistenceId, toSeq);
  }

  /** Read back the persisted events — handy for tests. */
  protected async readEvents(fromSeq = 1, toSeq?: number): Promise<PersistentEvent<Event>[]> {
    return this._journal.read<Event>(this.persistenceId, fromSeq, toSeq);
  }
}
