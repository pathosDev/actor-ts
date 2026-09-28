import { type Option } from '../../util/Option.js';
import { MAX_PERSISTENCE_ID_LENGTH } from '../Constants.js';
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

  async loadSequence(projection: string, persistenceId: string): Promise<number> {
    return this.seq.get(projection)?.get(persistenceId) ?? 0;
  }
  async saveSequence(projection: string, persistenceId: string, seqNr: number): Promise<void> {
    let inner = this.seq.get(projection);
    if (!inner) { inner = new Map(); this.seq.set(projection, inner); }
    inner.set(persistenceId, seqNr);
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
 * The half of a durable-state offset key that is not the projection name.
 *
 * `token` is wire vocabulary: it sits inside every cursor key already
 * written, so it can never change without orphaning stored cursors.  `role`
 * is what the offset-store API calls that half, and exists only so the
 * refusal below can name it — a by-tag projection told to shorten its
 * "persistenceId" would go looking for an id it never had.
 *
 * Both constants stay in this file under the clause the constants policy
 * reserves for wire vocabulary whose meaning *is* the codec beside it: the
 * two tokens are the offset-key format, and away from the function that
 * composes the key they mean nothing.
 */
type OffsetKeyScope = {
  readonly token: 'seq' | 'tag';
  readonly role: 'persistenceId' | 'tag';
};

const SEQUENCE_SCOPE: OffsetKeyScope = { token: 'seq', role: 'persistenceId' };
const TAG_SCOPE: OffsetKeyScope = { token: 'tag', role: 'tag' };

/**
 * Compose the durable-state key for one projection cursor, refusing a
 * composite the backend could not store intact (#1507).
 *
 * The cursor is *not* stored under the caller's `persistenceId`: it is
 * stored under `<projection>|<token>|<half>`, and that composite is what
 * lands in `durable_state.persistence_id`, which `MariaDbDialect` declares
 * `VARCHAR(255)` and `MsSqlDialect` `NVARCHAR(255)` — the width
 * {@link MAX_PERSISTENCE_ID_LENGTH} names.  So the framework can manufacture
 * a key no caller ever wrote: a 250-character id passes
 * `assertValidPersistenceId` on its own, and `orders-projection|seq|` in
 * front of it does not fit.
 *
 * It is refused here rather than left to the driver because the backends
 * disagree and none of the answers is one an operator can act on.  Strict
 * MariaDB (the default since 10.2.4) raises error 1406 and SQL Server raises
 * a truncation error — loud, but attributed to a column the caller never
 * named.  MariaDB with strict mode off truncates to 255, and two projections
 * whose names share a prefix then share one cursor row, which is invisible
 * from inside the process: the projection keeps running and silently skips
 * events.  Postgres and SQLite (`TEXT`) store the whole thing, so the same
 * code works until the read model moves.  One bound on all of them is what
 * makes a projection portable.
 *
 * Both halves go into the message because neither alone identifies the
 * trouble — the same id under a shorter projection name is fine, and
 * renaming the projection is usually the cheaper fix of the two.
 *
 * Loads are refused as well as writes, deliberately departing from
 * `assertValidPersistenceId`'s write-only rule.  There the read stays open
 * so data already stored under a since-invalidated id keeps coming back;
 * here the composite is a key the *store* builds, so a load that returned
 * would hand the projection a cursor it can never commit — running the
 * handler over and over while writing nothing.  Failing before the first
 * event is the better half of that trade.
 */
function offsetKey(projection: string, scope: OffsetKeyScope, half: string): string {
  const key = `${projection}|${scope.token}|${half}`;
  if (key.length > MAX_PERSISTENCE_ID_LENGTH) {
    throw new Error(
      `Projection offset key is ${key.length} characters, over the `
      + `${MAX_PERSISTENCE_ID_LENGTH}-character durable_state.persistence_id column: `
      + `projection ${JSON.stringify(projection)} (${projection.length}) `
      + `+ "|${scope.token}|" + ${scope.role} ${JSON.stringify(half)} (${half.length}). `
      + `Shorten the projection name or the ${scope.role} — a longer key is rejected by `
      + 'SQL Server and by strict-mode MariaDB, and silently truncated when strict mode '
      + "is off, which merges two projections' cursors into one row.",
    );
  }
  return key;
}

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
 *
 * The one constraint this adds over {@link InMemoryOffsetStore} is a length
 * bound: the composite key is a durable-state `persistenceId` and inherits
 * that column's width, which leaves the second half
 * `MAX_PERSISTENCE_ID_LENGTH - projectionName.length - 5` characters.  See
 * {@link offsetKey} for what each backend does without it.
 */
export class DurableStateOffsetStore implements OffsetStore {
  private readonly cache = new Map<string, { revision: number }>();

  constructor(private readonly store: DurableStateStore) {}

  async loadSequence(projection: string, persistenceId: string): Promise<number> {
    const rec = await this.load<{ value: number }>(this.seqKey(projection, persistenceId));
    return rec?.value ?? 0;
  }
  async saveSequence(projection: string, persistenceId: string, seqNr: number): Promise<void> {
    await this.save(this.seqKey(projection, persistenceId), { value: seqNr });
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

  private seqKey(projection: string, persistenceId: string): string {
    return offsetKey(projection, SEQUENCE_SCOPE, persistenceId);
  }
  private offKey(projection: string, tag: string): string {
    return offsetKey(projection, TAG_SCOPE, tag);
  }

  private async load<T>(key: string): Promise<T | null> {
    const option: Option<{ revision: number; state: T }> = await this.store.load<T>(key);
    if (option.isNone()) return null;
    this.cache.set(key, { revision: option.value.revision });
    return option.value.state;
  }

  private async save<T>(key: string, state: T): Promise<void> {
    const expected = this.cache.get(key)?.revision ?? 0;
    const next = await this.store.upsert<T>(key, expected, state);
    this.cache.set(key, { revision: next.revision });
  }
}
