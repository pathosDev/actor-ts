import { type Option } from '../../util/Option.js';
import type { DurableStateStore } from '../DurableStateStore.js';
import { offsetStart, type Offset } from '../query/PersistenceQuery.js';

/**
 * Per-projection persistent cursor.  The {@link ProjectionActor}
 * loads the offset on `preStart` and writes it back after every
 * successfully-handled event.  The pair of (load → handle event →
 * save) gives at-least-once delivery: the same event can be re-handled
 * if the projection crashes between handle and save, which is exactly
 * why projection handlers must be idempotent.
 *
 * Two flavours of cursor are stored: a simple integer
 * (sequence-based, used by `eventsByPersistenceId`) and the composite
 * {@link Offset} (timestamp-based, used by `eventsByTag`).  The store
 * persists both as plain JSON so the underlying backend doesn't need
 * to know about the difference.
 */
export interface OffsetStore {
  loadSequence(projectionName: string, persistenceId: string): Promise<number>;
  saveSequence(projectionName: string, persistenceId: string, seqNr: number): Promise<void>;

  loadOffset(projectionName: string, tag: string): Promise<Offset>;
  saveOffset(projectionName: string, tag: string, offset: Offset): Promise<void>;

  /** Forget every cursor for `projectionName`.  Used by tests + reset tooling. */
  clear(projectionName: string): Promise<void>;
}

/* ============================ in-memory ============================== */

/**
 * Reference offset store — keeps cursors in a process-local Map.  Use
 * this for tests or for projections whose offsets you're happy to
 * lose on restart (i.e. the projection always replays the full
 * stream).  Not thread-safe across processes.
 */
export class InMemoryOffsetStore implements OffsetStore {
  private readonly seq = new Map<string, Map<string, number>>();
  private readonly off = new Map<string, Map<string, Offset>>();

  async loadSequence(projection: string, pid: string): Promise<number> {
    return this.seq.get(projection)?.get(pid) ?? 0;
  }
  async saveSequence(projection: string, pid: string, seqNr: number): Promise<void> {
    let inner = this.seq.get(projection);
    if (!inner) { inner = new Map(); this.seq.set(projection, inner); }
    inner.set(pid, seqNr);
  }

  async loadOffset(projection: string, tag: string): Promise<Offset> {
    return this.off.get(projection)?.get(tag) ?? offsetStart;
  }
  async saveOffset(projection: string, tag: string, offset: Offset): Promise<void> {
    let inner = this.off.get(projection);
    if (!inner) { inner = new Map(); this.off.set(projection, inner); }
    inner.set(tag, offset);
  }

  async clear(projection: string): Promise<void> {
    this.seq.delete(projection);
    this.off.delete(projection);
  }
}

/* =========================== durable-state =========================== */

/**
 * Persists offsets via any {@link DurableStateStore} — meaning
 * SQLite, Cassandra, S3, filesystem, all become valid offset stores
 * for free, just by reusing the existing plug-in.  Each projection's
 * offsets land under a single durable-state record per
 * (projection, kind) combination, encoded as plain JSON.
 *
 * The revision-based optimistic-concurrency on `DurableStateStore`
 * ensures two concurrent projection instances don't race their
 * cursor writes — the store rejects any save that doesn't carry the
 * caller's expected revision.  The {@link ProjectionActor} itself is
 * single-instance per projection name (or per (projection, shard) in
 * the cluster-wide variant), so contention is the exception, not the
 * rule.
 */
export class DurableStateOffsetStore implements OffsetStore {
  private readonly cache = new Map<string, { revision: number }>();

  constructor(private readonly store: DurableStateStore) {}

  async loadSequence(projection: string, pid: string): Promise<number> {
    const rec = await this.load<{ value: number }>(this.seqKey(projection, pid));
    return rec?.value ?? 0;
  }
  async saveSequence(projection: string, pid: string, seqNr: number): Promise<void> {
    await this.save(this.seqKey(projection, pid), { value: seqNr });
  }

  async loadOffset(projection: string, tag: string): Promise<Offset> {
    const rec = await this.load<Offset>(this.offKey(projection, tag));
    return rec ?? offsetStart;
  }
  async saveOffset(projection: string, tag: string, offset: Offset): Promise<void> {
    await this.save(this.offKey(projection, tag), offset);
  }

  async clear(projection: string): Promise<void> {
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(`${projection}|`)) {
        await this.store.delete(key);
        this.cache.delete(key);
      }
    }
  }

  /* ------------------------------ internals ----------------------------- */

  private seqKey(projection: string, pid: string): string {
    return `${projection}|seq|${pid}`;
  }
  private offKey(projection: string, tag: string): string {
    return `${projection}|tag|${tag}`;
  }

  private async load<T>(key: string): Promise<T | null> {
    const opt: Option<{ revision: number; state: T }> = await this.store.load<T>(key);
    if (opt.isNone()) return null;
    this.cache.set(key, { revision: opt.value.revision });
    return opt.value.state;
  }

  private async save<T>(key: string, state: T): Promise<void> {
    const expected = this.cache.get(key)?.revision ?? 0;
    const next = await this.store.upsert<T>(key, expected, state);
    this.cache.set(key, { revision: next.revision });
  }
}
