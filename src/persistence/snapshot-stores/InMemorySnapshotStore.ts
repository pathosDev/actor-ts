import type { Snapshot } from '../JournalTypes.js';
import type { PersistenceOptionSupport } from '../PersistenceCapabilities.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import type { StorageLocality } from '../StorageLocality.js';
import { none, some, type Option } from '../../util/Option.js';
import type {
  InMemorySnapshotStoreOptions,
  InMemorySnapshotStoreOptionsType,
} from './InMemorySnapshotStoreOptions.js';

/**
 * In-process snapshot store.  `loadLatest` picks the newest snapshot per
 * persistenceId, `loadBefore` the newest `< seq`.  Stored state takes the
 * same `PayloadCodec` round-trip a real store performs (#888): loads see
 * the value a real backend would return, and later mutations of the
 * caller's object no longer alias into the store.
 *
 * Retention is **opt-in** here and bounded by default everywhere else
 * (every persistent store defaults to `keepN: 3`).  The divergence is
 * deliberate — this is the store `PersistenceExtension` installs when
 * nothing is configured, so a default bound would quietly change what
 * every unconfigured application retains.  Set `keepN` to bound it; see
 * {@link InMemorySnapshotStoreOptionsType.keepN}.
 *
 * Re-saving at a sequence number that already exists **replaces that
 * entry** rather than appending a second one, matching the relational
 * stores' `(persistence_id, sequence_nr)` primary key.  Without that,
 * an actor snapshotting repeatedly at an unchanged sequence grew the
 * list without bound even with `keepN` set, because the duplicates
 * counted against the bound and evicted genuinely older sequences.
 */
export class InMemorySnapshotStore implements SnapshotStore {
  private readonly store = new Map<string, Snapshot<unknown>[]>();
  private readonly keepN: number;
  /** See `InMemoryJournal.storageLocality` — writable for shared in-process fixtures (#1356). */
  storageLocality: StorageLocality = 'node-local';

  /**
   * A process-heap map — there is nothing at rest to protect, and nothing
   * here reads `options` (#960).  The reference store declares `false`
   * rather than pretending: an actor whose production store encrypts must
   * not pass its tests against an in-memory store that quietly does not.
   */
  readonly persistenceOptionSupport: PersistenceOptionSupport = {
    encryption: false,
    compression: false,
    integrity: false,
  };

  /** See `InMemoryJournal.mintedStorageIdentity` — one instance, one identity (#1358). */
  private readonly mintedStorageIdentity: string = crypto.randomUUID();

  async storageIdentity(): Promise<string> { return this.mintedStorageIdentity; }

  constructor(options: InMemorySnapshotStoreOptions = {}) {
    this.keepN = (options as InMemorySnapshotStoreOptionsType).keepN ?? 0;
  }

  async save<S>(persistenceId: string, seq: number, state: S, _options?: PersistenceOptions): Promise<Snapshot<S>> {
    // In-memory store ignores compression / encryption / integrity options.
    const stored = decodePayload(encodePayload(state));
    const list = this.store.get(persistenceId) ?? [];
    const snap: Snapshot<S> = { persistenceId, sequenceNr: seq, state, timestamp: Date.now() };
    const row = { ...snap, state: stored } as Snapshot<unknown>;
    const sameSeq = list.findIndex(s => s.sequenceNr === seq);
    if (sameSeq >= 0) {
      // Upsert in place — the list is already sorted and the position is
      // unchanged, so no re-sort is needed.
      list[sameSeq] = row;
    } else {
      list.push(row);
      // Keep sorted ascending by seq for easy queries.
      list.sort((a, b) => a.sequenceNr - b.sequenceNr);
    }
    // Prune the oldest beyond the bound.  `keepN <= 0` keeps everything,
    // the family-wide convention.
    if (this.keepN > 0 && list.length > this.keepN) list.splice(0, list.length - this.keepN);
    this.store.set(persistenceId, list);
    return snap;
  }

  async loadLatest<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const list = this.store.get(persistenceId);
    if (!list || list.length === 0) return none;
    return some(list[list.length - 1] as Snapshot<S>);
  }

  async loadBefore<S>(persistenceId: string, seq: number, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const list = this.store.get(persistenceId);
    if (!list || list.length === 0) return none;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.sequenceNr < seq) return some(list[i] as Snapshot<S>);
    }
    return none;
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    const list = this.store.get(persistenceId);
    if (!list) return;
    this.store.set(persistenceId, list.filter(s => s.sequenceNr > toSeq));
  }

  async close(): Promise<void> { this.store.clear(); }
}
