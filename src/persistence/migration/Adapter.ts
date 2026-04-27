/**
 * Schema-evolution adapters for persistent actors.
 *
 * The actor framework stores events / state as opaque JSON in the journal
 * and snapshot store.  When a domain type evolves (new field, renamed
 * field, type change), already-persisted history must still be replayable
 * — the user supplies an `EventAdapter` (for events) or a `SnapshotAdapter`
 * / `StateAdapter` (for snapshots and durable state) which:
 *
 *   - tags every value written with a stable `manifest` string and a
 *     numeric `version` (the wire-format envelope is `{ _v, _t, _e }`,
 *     applied transparently by `PersistentActor` / `DurableStateActor`),
 *   - on read, takes the stored triple `{ manifest, version, payload }`
 *     and returns a current-version domain value, typically by delegating
 *     to a `MigrationChain` of pure upcaster functions.
 *
 * The adapter contract is intentionally separate from the wire envelope:
 * adapters return / accept *triples*, the actor is responsible for the
 * `_v / _t / _e` JSON shape.  That keeps user code focused on the domain
 * mapping and lets us evolve the wire format later without breaking
 * adapters.
 */

/** Wire-format envelope written into the `event` / `state` JSON slot. */
export interface JournalEnvelope<P = unknown> {
  /** Schema version of the payload — monotonic, increments per breaking change. */
  readonly _v: number;
  /** Manifest — stable type identity, e.g. `'BankAccount.Deposited'`. */
  readonly _t: string;
  /** The (possibly-old) payload itself. */
  readonly _e: P;
}

/** Stored shape that adapters see on the read path — the unwrapped envelope. */
export interface StoredFrame {
  readonly manifest: string;
  readonly version: number;
  readonly payload: unknown;
}

/** Triple emitted by adapters on the write path — the actor wraps this into an envelope. */
export interface OutboundFrame<JournalShape = unknown> {
  readonly manifest: string;
  readonly version: number;
  readonly payload: JournalShape;
}

/**
 * Adapter for `PersistentActor` events.  `DomainEvent` is the *current*
 * event union the actor knows; `JournalShape` defaults to the same type
 * but may diverge if the user wants to store a slimmer wire representation.
 */
export interface EventAdapter<DomainEvent, JournalShape = DomainEvent> {
  /** Stable identifier for the *current* event variant — used as `_t` on disk. */
  manifest(event: DomainEvent): string;
  /** Convert a domain event to the journal triple. */
  toJournal(event: DomainEvent): OutboundFrame<JournalShape>;
  /** Inverse: take any past version off disk, return a current-version domain event. */
  fromJournal(stored: StoredFrame): DomainEvent;
}

/**
 * Adapter for `PersistentActor` snapshots.  Structurally identical to
 * `EventAdapter` but kept as a separate type so signatures read clearly
 * (a `snapshotAdapter()` returning an `EventAdapter` would be misleading).
 */
export interface SnapshotAdapter<DomainState, StoredShape = DomainState> {
  manifest(state: DomainState): string;
  toJournal(state: DomainState): OutboundFrame<StoredShape>;
  fromJournal(stored: StoredFrame): DomainState;
}

/**
 * Adapter for `DurableStateActor` — same shape as `SnapshotAdapter`, alias
 * for naming clarity at the actor level.
 */
export type StateAdapter<DomainState> = SnapshotAdapter<DomainState>;
