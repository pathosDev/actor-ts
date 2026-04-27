import {
  DurableStateConcurrencyError,
  type DurableStateRecord,
  type DurableStateStore,
} from '../DurableStateStore.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import { fromNullable, type Option } from '../../util/Option.js';

/**
 * Reference Durable State store backed by a JS Map.  Useful for tests and
 * single-process development; swap for a SQLite/Cassandra store in production.
 */
export class InMemoryDurableStateStore implements DurableStateStore {
  private readonly records = new Map<string, DurableStateRecord<unknown>>();

  async upsert<S>(
    persistenceId: string,
    expectedRevision: number,
    state: S,
    _options?: PersistenceOptions,
  ): Promise<DurableStateRecord<S>> {
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
    this.records.set(persistenceId, record as DurableStateRecord<unknown>);
    return record;
  }

  async load<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<DurableStateRecord<S>>> {
    return fromNullable(this.records.get(persistenceId) as DurableStateRecord<S> | undefined);
  }

  async delete(persistenceId: string): Promise<void> {
    this.records.delete(persistenceId);
  }
}
