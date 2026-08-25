import {
  DurableStateConcurrencyError,
  type DurableStateRecord,
  type DurableStateStore,
} from '../DurableStateStore.js';
import { JournalError } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import type { StorageLocality } from '../StorageLocality.js';
import { fromNullable, type Option } from '../../util/Option.js';

/**
 * Reference Durable State store backed by a JS Map.  Useful for tests and
 * single-process development; swap for a SQLite/Cassandra store in production.
 * Stored state takes the same `PayloadCodec` round-trip a real store performs
 * (#888), so loads match a real backend and mutations don't alias.
 */
export class InMemoryDurableStateStore implements DurableStateStore {
  private readonly records = new Map<string, DurableStateRecord<unknown>>();
  /** See `InMemoryJournal.storageLocality` — writable for shared in-process fixtures (#1356). */
  storageLocality: StorageLocality = 'node-local';

  async upsert<S>(
    persistenceId: string,
    expectedRevision: number,
    state: S,
    _options?: PersistenceOptions,
  ): Promise<DurableStateRecord<S>> {
    // A bogus revision is a caller bug, not a lost race — reporting it as a
    // concurrency conflict would send the caller into a pointless retry loop.
    // Matches the relational and object-storage stores.
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new JournalError(
        `InMemoryDurableStateStore.upsert: expectedRevision must be a non-negative integer, got ${expectedRevision}`,
      );
    }
    const current = this.records.get(persistenceId);
    const actual = current?.revision ?? 0;
    if (actual !== expectedRevision) {
      throw new DurableStateConcurrencyError(persistenceId, expectedRevision, actual);
    }
    const record: DurableStateRecord<S> = {
      persistenceId,
      revision: actual + 1,
      state,
      timestamp: Date.now(),
    };
    this.records.set(persistenceId, { ...record, state: decodePayload(encodePayload(state)) });
    return record;
  }

  async load<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<DurableStateRecord<S>>> {
    return fromNullable(this.records.get(persistenceId) as DurableStateRecord<S> | undefined);
  }

  async delete(persistenceId: string): Promise<void> {
    this.records.delete(persistenceId);
  }
}
