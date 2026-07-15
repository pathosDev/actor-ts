import type { Crdt, ReplicaId } from './Crdt.js';

/**
 * Multi-Value Register.  Like {@link LWWRegister}, but instead of
 * arbitrating concurrent writes via timestamps it **retains every
 * concurrent assignment**.  Reads return the set of "currently
 * competing" values; the application picks one (or surfaces a
 * conflict UI to the user).
 *
 *   const a = MVRegister.empty<string>().assign('a', 'red');
 *   const b = MVRegister.empty<string>().assign('b', 'blue');
 *   a.merge(b).values()      // → ['red', 'blue']  (both retained)
 *
 *   // A subsequent assign that has SEEN both branches subsumes them:
 *   const merged = a.merge(b);
 *   merged.assign('a', 'final').values()    // → ['final']
 *
 * **How it works.**  Each assignment carries a small **vector clock**
 * — `Map<ReplicaId, number>` — recording the maximum-seen version of
 * every replica at the moment the value was written, plus one tick on
 * the writing replica.  On `merge`, entries whose clock is strictly
 * dominated by another entry's clock are discarded; the rest survive
 * as concurrent values.
 *
 * The vector-clock approach is independent of wall-clock time, which
 * is the point: MVRegister's job is to **preserve** concurrent writes
 * rather than arbitrate them.  If you need automatic resolution by
 * recency, use `LWWRegister` instead.
 */

interface MVEntry<V> {
  readonly value: V;
  /** Per-replica version vector at write time. */
  readonly vc: ReadonlyMap<ReplicaId, number>;
}

export class MVRegister<V> implements Crdt<MVRegister<V>> {
  private constructor(private readonly entries: ReadonlyArray<MVEntry<V>>) {}

  static empty<V>(): MVRegister<V> { return new MVRegister<V>([]); }

  /**
   * Assign `value` on behalf of `replica`.  Subsumes everything
   * currently in the register on **this** replica — the new vector
   * clock dominates every previous entry's, so on merge they all
   * lose.  Concurrent assigns on other replicas survive (their
   * clocks are independent of this one's tick).
   */
  assign(replica: ReplicaId, value: V): MVRegister<V> {
    // Compute the per-replica max across all currently-known entries
    // and tick the writing replica by one.  This produces a clock
    // strictly greater than every existing one — so on merge the new
    // entry is the only survivor from this replica's branch.
    const max = new Map<ReplicaId, number>();
    for (const entry of this.entries) {
      for (const [replicaId, version] of entry.vc) {
        if (version > (max.get(replicaId) ?? 0)) max.set(replicaId, version);
      }
    }
    max.set(replica, (max.get(replica) ?? 0) + 1);
    return new MVRegister<V>([{ value, vc: max }]);
  }

  /**
   * Snapshot of currently-live values.  Length is 1 in the common
   * (un-conflicted) case; more than 1 when concurrent writers wrote
   * branches that haven't yet been subsumed by a later assign.
   */
  values(): ReadonlyArray<V> {
    return this.entries.map((e) => e.value);
  }

  /** `true` iff `values().length > 1` — two or more concurrent writes. */
  get hasConflict(): boolean { return this.entries.length > 1; }

  /** Number of currently-live values (typically 1). */
  get size(): number { return this.entries.length; }

  merge(other: MVRegister<V>): MVRegister<V> {
    const all: MVEntry<V>[] = [...this.entries, ...other.entries];
    const survivors: MVEntry<V>[] = [];
    const seen = new Set<string>();
    for (const entry of all) {
      // Drop entry if any sibling strictly dominates it (causally
      // newer writes subsume older ones).
      let keep = true;
      for (const other of all) {
        if (other === entry) continue;
        if (vcStrictlyDominates(other.vc, entry.vc)) { keep = false; break; }
      }
      if (!keep) continue;
      // Dedupe by **full state** (value + vc).  Two entries with the
      // same vc but different values are kept as concurrent — that
      // can only happen on replica-id reuse, which is technically
      // unsupported, but treating them as conflicts keeps merge
      // commutative even in that degenerate case.  Two entries with
      // identical (value, vc) are the same logical state and dedupe
      // to one.
      const key = JSON.stringify([
        entry.value,
        Array.from(entry.vc.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      survivors.push(entry);
    }
    return new MVRegister<V>(survivors);
  }

  toJSON(): MVRegisterJson<V> {
    return {
      kind: 'MVRegister',
      entries: this.entries.map((e) => ({
        value: e.value,
        vc: Object.fromEntries(e.vc),
      })),
    };
  }

  static fromJSON<V>(json: MVRegisterJson<V>): MVRegister<V> {
    if (json.kind !== 'MVRegister') {
      throw new Error(`MVRegister.fromJSON: unexpected kind ${json.kind}`);
    }
    return new MVRegister<V>(
      json.entries.map((e) => ({
        value: e.value,
        vc: new Map(Object.entries(e.vc)),
      })),
    );
  }

  equals(other: MVRegister<V>): boolean {
    if (this.entries.length !== other.entries.length) return false;
    // Order-independent: every entry on this side must have a partner
    // on the other side with the same value + vc.
    return this.entries.every((a) =>
      other.entries.some((b) =>
        JSON.stringify(a.value) === JSON.stringify(b.value)
        && vcEqual(a.vc, b.vc)
      ));
  }
}

/* ------------------------------ helpers --------------------------------- */

function vcEqual(
  left: ReadonlyMap<ReplicaId, number>,
  right: ReadonlyMap<ReplicaId, number>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [replicaId, version] of left) if (right.get(replicaId) !== version) return false;
  return true;
}

/**
 * `a` strictly dominates `b` iff:
 *   - `a[k] >= b[k]` for every replica `k` (including those `b` doesn't
 *     mention — those count as zero on the `b` side), AND
 *   - there exists at least one replica `k` where `a[k] > b[k]`.
 *
 * "Strictly" because equal clocks count as concurrent, not dominating.
 */
function vcStrictlyDominates(
  a: ReadonlyMap<ReplicaId, number>,
  b: ReadonlyMap<ReplicaId, number>,
): boolean {
  let strict = false;
  // Check every replica in b — a must be >= there.
  for (const [k, vb] of b) {
    const va = a.get(k) ?? 0;
    if (va < vb) return false;
    if (va > vb) strict = true;
  }
  // Replicas in a but not b: a > 0 → a is strictly ahead.
  for (const [k, va] of a) {
    if (!b.has(k) && va > 0) strict = true;
  }
  return strict;
}

export interface MVRegisterJson<V> {
  readonly kind: 'MVRegister';
  readonly entries: ReadonlyArray<{
    readonly value: V;
    readonly vc: Record<ReplicaId, number>;
  }>;
}
