import type { Snapshot } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { none, some, type Option } from '../../util/Option.js';

/**
 * In-process snapshot store.  Keeps all snapshots per persistenceId;
 * `loadLatest` picks the newest, `loadBefore` the newest `< seq`.
 * Plug-in implementations typically keep only the last N snapshots to
 * save space — the in-memory one doesn't bother.
 */
export class InMemorySnapshotStore implements SnapshotStore {
  private readonly store = new Map<string, Snapshot<unknown>[]>();

  async save<S>(pid: string, seq: number, state: S, _options?: PersistenceOptions): Promise<Snapshot<S>> {
    // In-memory store ignores compression / encryption options.
    const list = this.store.get(pid) ?? [];
    const snap: Snapshot<S> = { persistenceId: pid, sequenceNr: seq, state, timestamp: Date.now() };
    list.push(snap as Snapshot<unknown>);
    // Keep sorted ascending by seq for easy queries.
    list.sort((a, b) => a.sequenceNr - b.sequenceNr);
    this.store.set(pid, list);
    return snap;
  }

  async loadLatest<S>(pid: string, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const list = this.store.get(pid);
    if (!list || list.length === 0) return none;
    return some(list[list.length - 1] as Snapshot<S>);
  }

  async loadBefore<S>(pid: string, seq: number, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const list = this.store.get(pid);
    if (!list || list.length === 0) return none;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.sequenceNr < seq) return some(list[i] as Snapshot<S>);
    }
    return none;
  }

  async delete(pid: string, toSeq: number): Promise<void> {
    const list = this.store.get(pid);
    if (!list) return;
    this.store.set(pid, list.filter(s => s.sequenceNr > toSeq));
  }

  async close(): Promise<void> { this.store.clear(); }
}
