import type { Snapshot } from './JournalTypes.js';
import type { PersistenceOptionSupport } from './PersistenceCapabilities.js';
import type { PersistenceOptions } from './PersistenceOptions.js';
import type { StorageLocality } from './StorageLocality.js';
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
   * caller (e.g. compression/encryption set on the actor).  A store that
   * cannot honour a field ignores it here and says so through
   * {@link SnapshotStore.persistenceOptionSupport}, which is what lets the
   * actor be refused at start rather than written unprotected (#960).
   *
   * ### Retention is best-effort; the write is not
   *
   * A store that prunes on save (`keepN` and friends) MUST NOT let a
   * failing prune fail the save.  Once the snapshot itself is durable,
   * `save` resolves — the retention pass runs afterwards and its errors
   * are swallowed.
   *
   * The two operations have opposite failure semantics, which is why
   * they cannot share a `try`.  A failed write means the caller's
   * snapshot does not exist and retrying is correct.  A failed prune
   * means one row too many exists — harmless, self-correcting on the
   * next save, and invisible to `loadLatest`.  Reporting the second as
   * the first tells the caller to retry a write that already succeeded,
   * and an actor that treats a snapshot failure as fatal then dies over
   * a housekeeping error.
   *
   * Implementations must therefore run the prune *outside* the write's
   * error handling.  `save` is still permitted to reject for a genuine
   * write failure, and only for that.
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
   * master key.  Stores that don't encrypt ignore the field and declare
   * that through {@link SnapshotStore.persistenceOptionSupport}; reading
   * with `encryption` set against such a store would otherwise hand the
   * caller plaintext it believes was ciphertext (#960).
   */
  loadLatest<S = unknown>(persistenceId: string, options?: PersistenceOptions): Promise<Option<Snapshot<S>>>;

  /** Load the newest snapshot with `sequenceNr < seq`, or None. */
  loadBefore<S = unknown>(persistenceId: string, seq: number, options?: PersistenceOptions): Promise<Option<Snapshot<S>>>;

  /** Delete snapshots up to and including `toSeq`.  Useful for pruning. */
  delete(persistenceId: string, toSeq: number): Promise<void>;

  /**
   * Where this store's data lives relative to cluster nodes — see
   * {@link StorageLocality}.  Optional; absence means unknown and keeps the
   * cluster's storage advisory silent (#1356).
   */
  readonly storageLocality?: StorageLocality;

  /**
   * Which fields of `PersistenceOptions` this store acts on — see
   * {@link PersistenceOptionSupport}.  Optional; absence means unknown, and
   * an unknown store is never refused (#960).
   */
  readonly persistenceOptionSupport?: PersistenceOptionSupport;

  /**
   * Identity of the database behind this store, minted on first contact and
   * persisted in the database itself — see {@link Journal.storageIdentity}
   * for the full semantics (#1358).  Optional; absence means unknown.
   */
  storageIdentity?(): Promise<string>;

  /** Best-effort teardown. */
  close?(): Promise<void>;
}
