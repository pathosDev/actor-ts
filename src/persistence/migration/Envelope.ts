import type {
  EventAdapter,
  JournalEnvelope,
  SnapshotAdapter,
  StoredFrame,
} from './Adapter.js';

/**
 * Wire-format helpers for the `_v / _t / _e` JSON envelope used by
 * `PersistentActor` and `DurableStateActor` when an adapter is active.
 *
 * The envelope rides inside the existing `event` / `state` JSON slot of
 * the journal / snapshot store, so no backend (InMemory, SQLite,
 * Cassandra, object-storage) needs schema changes.  The magic keys are
 * `_v`, `_t`, `_e` — underscore-prefixed to make accidental collisions
 * with domain types vanishingly unlikely.
 */

/** Raised when adapter-driven decoding hits a malformed/legacy payload. */
export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly manifest?: string,
    public readonly version?: number,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** True iff `o` looks like a `JournalEnvelope`. */
export function isEnvelope(o: unknown): o is JournalEnvelope {
  if (typeof o !== 'object' || o === null) return false;
  const env = o as Record<string, unknown>;
  return typeof env._v === 'number'
      && typeof env._t === 'string'
      && '_e' in env;
}

/* ------------------------------ events ----------------------------------- */

/** Wrap a domain event into an envelope using the supplied adapter. */
export function encodeEvent<E, J>(event: E, adapter: EventAdapter<E, J>): JournalEnvelope<J> {
  const frame = adapter.toJournal(event);
  return { _v: frame.version, _t: frame.manifest, _e: frame.payload };
}

/**
 * Decode a value read from the journal.  When `adapter` is undefined the
 * caller has not opted into the migration system — the value is returned
 * as-is and is assumed to be a raw domain event.  When `adapter` is
 * defined, the value MUST be an envelope; otherwise a `MigrationError` is
 * raised (strict mode — see plan §1).
 */
export function decodeEvent<E>(stored: unknown, adapter: EventAdapter<E> | undefined): E {
  if (!adapter) return stored as E;
  if (!isEnvelope(stored)) {
    throw new MigrationError(
      'expected envelope, got raw payload — eventAdapter is configured but the journal '
      + 'contains an event without _v/_t/_e markers.  Either run a one-shot migration '
      + 'script to wrap legacy events, or remove eventAdapter() until you have envelopes '
      + 'on disk.',
    );
  }
  return adapter.fromJournal(toFrame(stored));
}

/* ----------------------------- snapshots --------------------------------- */

/** Wrap a snapshot state into an envelope using the supplied adapter. */
export function encodeState<S, J>(state: S, adapter: SnapshotAdapter<S, J>): JournalEnvelope<J> {
  const frame = adapter.toJournal(state);
  return { _v: frame.version, _t: frame.manifest, _e: frame.payload };
}

/**
 * Decode a state read from the snapshot store / durable-state store.
 * Same strict semantics as `decodeEvent`.
 */
export function decodeState<S>(stored: unknown, adapter: SnapshotAdapter<S> | undefined): S {
  if (!adapter) return stored as S;
  if (!isEnvelope(stored)) {
    throw new MigrationError(
      'expected envelope, got raw payload — a state/snapshot adapter is configured but '
      + 'the persisted state has no _v/_t/_e markers.  Wrap legacy state with a one-shot '
      + 'migration script or drop the adapter until envelopes are on disk.',
    );
  }
  return adapter.fromJournal(toFrame(stored));
}

/* ------------------------------ internal --------------------------------- */

function toFrame(env: JournalEnvelope): StoredFrame {
  return { manifest: env._t, version: env._v, payload: env._e };
}
