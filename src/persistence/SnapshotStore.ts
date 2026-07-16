import type { Snapshot } from './JournalTypes.js';
import type { PersistenceOptions } from './PersistenceOptions.js';
import type { Option } from '../util/Option.js';

/**
 * Pluggable snapshot store.  Snapshots short-circuit recovery by fast-
 * forwarding the state machine to a known point, so replay only needs
 * to apply events newer than the snapshot.
 */
export interface SnapshotStore {
  /**
   * Persist a snapshot at `seq` — typically the seq of the latest event
   * applied.  Optional `options` carry per-call preferences from the
   * caller (e.g. compression/encryption set on the actor).  Stores that
   * cannot honour them silently ignore the field.
   */
  save<S = unknown>(
    persistenceId: string,
    seq: number,
    state: S,
    options?: PersistenceOptions,
  ): Promise<Snapshot<S>>;

  /**
   * Load the newest snapshot for `persistenceId`, or None if none exist.
   * `options.encryption` is required when client-side encryption was
   * used at write time — the store has no other way to obtain the
   * master key.  Stores that don't encrypt ignore the field.
   */
  loadLatest<S = unknown>(persistenceId: string, options?: PersistenceOptions): Promise<Option<Snapshot<S>>>;

  /** Load the newest snapshot with `sequenceNr < seq`, or None. */
  loadBefore<S = unknown>(persistenceId: string, seq: number, options?: PersistenceOptions): Promise<Option<Snapshot<S>>>;

  /** Delete snapshots up to and including `toSeq`.  Useful for pruning. */
  delete(persistenceId: string, toSeq: number): Promise<void>;

  /** Best-effort teardown. */
  close?(): Promise<void>;
}
