import { Actor } from '../Actor.js';
import type { Journal } from './Journal.js';
import type { PersistentEvent, Snapshot } from './JournalTypes.js';
import { PersistenceExtensionId } from './PersistenceExtension.js';
import type {
  CompressionConfig,
  EncryptionConfig,
  PersistenceOptions,
} from './PersistenceOptions.js';
import type { SnapshotStore } from './SnapshotStore.js';
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
 *           this.sender?.tell({ ok: s.balance });
 *         });
 *       }
 *     }
 *   }
 */
export abstract class PersistentActor<Command, Event, State> extends Actor<Command> {
  abstract readonly persistenceId: string;

  /** Default initial state when no snapshot and no events exist. */
  abstract initialState(): State;

  /** Pure state-update function — MUST be deterministic. */
  abstract onEvent(state: State, event: Event): State;

  /** Handle an incoming command — typically calls `persist(event, cb)`. */
  abstract onCommand(state: State, command: Command): void | Promise<void>;

  /** Called once recovery finishes, with the final replayed state. */
  onRecoveryComplete(_state: State): void | Promise<void> {}

  /** Called when recovery itself throws.  Default = propagate to supervision. */
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

  /* ----------------------------- Lifecycle API ----------------------------- */

  override async preStart(): Promise<void> {
    const ext = this.system.extension(PersistenceExtensionId);
    this._journal = ext.journal;
    this._snapshotStore = ext.snapshotStore;
    try {
      await this.recover();
    } catch (e) {
      this.onRecoveryFailure(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private async recover(): Promise<void> {
    this._state = this.initialState();
    this._seq = 0;
    const snapAdapter = this.snapshotAdapter();
    const evAdapter = this.eventAdapter();
    const persistOptions = this.persistenceOptions();
    this.log.debug(`[persistence] '${this.persistenceId}' recovery starting`);
    const snapshot = await this._snapshotStore.loadLatest<unknown>(this.persistenceId, persistOptions);
    if (snapshot.isSome()) {
      const snapSeq = snapshot.value.sequenceNr;
      // Security: validate the snapshot's claimed seq number BEFORE
      // trusting it for replay.  An attacker with write access to
      // the snapshot store (shared bucket, co-tenant, insider) could
      // craft a snapshot with `sequenceNr = MAX_SAFE_INTEGER` (or
      // NaN, Infinity, -1, etc.); the old code accepted it and
      // skipped event replay entirely, recovering with the
      // attacker's chosen state.  Two-layer check:
      //   1. seq must be a finite non-negative integer
      //   2. seq must not exceed what the journal can corroborate
      if (!Number.isInteger(snapSeq) || snapSeq < 0) {
        throw new Error(
          `[persistence] '${this.persistenceId}' snapshot has malformed sequenceNr=${snapSeq} ` +
          `— refusing to recover from a corrupted or tampered snapshot`,
        );
      }
      // Cross-check against the journal's highest seq: a snapshot that
      // claims to be AHEAD of the journal but the journal *has*
      // events for this pid is the classic attack vector — the
      // attacker pumps the seq sky-high so all real events get
      // skipped during replay.  An empty journal is fine (legitimate
      // when state-only snapshots survive a journal compaction or
      // migration).
      const journalHigh = await this._journal.highestSeq(this.persistenceId);
      if (journalHigh > 0 && snapSeq > journalHigh) {
        throw new Error(
          `[persistence] '${this.persistenceId}' snapshot claims sequenceNr=${snapSeq} ` +
          `but journal's highest seq is ${journalHigh} — refusing to recover from a ` +
          `corrupted or tampered snapshot (would silently skip event replay)`,
        );
      }
      this._state = decodeState<State>(snapshot.value.state, snapAdapter);
      this._seq = snapSeq;
      this.log.debug(`[persistence] '${this.persistenceId}' loaded snapshot @seq=${this._seq}`);
    }
    const events = await this._journal.read<unknown>(this.persistenceId, this._seq + 1);
    for (const ev of events) {
      const decoded = decodeEvent<Event>(ev.event, evAdapter);
      this._state = this.onEvent(this._state, decoded);
      this._seq = ev.sequenceNr;
    }
    this.log.debug(
      `[persistence] '${this.persistenceId}' recovery complete: replayed ${events.length} event(s), seq=${this._seq}`,
    );
    this._recovering = false;
    await this.onRecoveryComplete(this._state);
    // Any commands that arrived during recovery are already stashed by the
    // ActorCell — release them now so the actor processes them in order.
    this.context.unstashAll();
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
    cb?: (state: State) => void | Promise<void>,
  ): Promise<void> {
    await this.persistAll([event], cb);
  }

  /** Persist several events atomically.  Must also be awaited in onCommand. */
  protected async persistAll(
    events: ReadonlyArray<Event>,
    cb?: (state: State) => void | Promise<void>,
  ): Promise<void> {
    if (events.length === 0) { await cb?.(this._state); return; }
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
      const written = await this._journal.append<unknown>(
        this.persistenceId, wireEvents, this._seq, tags,
      );
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
      await cb?.(this._state);
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

  /** Delete snapshots and events up to `toSeq` for compaction. */
  protected async deleteHistory(toSeq: number): Promise<void> {
    await this._snapshotStore.delete(this.persistenceId, toSeq);
    await this._journal.delete(this.persistenceId, toSeq);
  }

  /** Read back the persisted events — handy for tests. */
  protected async readEvents(fromSeq = 1, toSeq?: number): Promise<PersistentEvent<Event>[]> {
    return this._journal.read<Event>(this.persistenceId, fromSeq, toSeq);
  }
}
