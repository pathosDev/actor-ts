import type { Crdt, ReplicaId } from './Crdt.js';

/**
 * Grow-only counter.  Each replica tracks its own monotonic count and
 * the global value is the sum.  Merging takes the max per replica —
 * which means losing or replaying messages is harmless: the counter
 * never goes backwards.
 *
 * Use this when **only increments matter** — page views, message
 * counts, total bytes uploaded.  For workloads that also need
 * decrements (cart sizes, available stock) reach for {@link PNCounter}.
 *
 * **Math sanity:** `merge` is the per-key max of the two state maps,
 * which is the standard join-semilattice on `Map<ReplicaId, ℕ>`.
 *
 *   const a = GCounter.empty().increment('node-a', 3);
 *   const b = GCounter.empty().increment('node-b', 5);
 *   a.merge(b).value()                          // → 8
 *   a.merge(b).merge(b).value()                 // → 8 (idempotent)
 */
export class GCounter implements Crdt<GCounter> {
  private constructor(private readonly state: ReadonlyMap<ReplicaId, number>) {}

  /** A counter at zero. */
  static empty(): GCounter { return new GCounter(new Map()); }

  /**
   * Bump the count for `replica` by `delta` (default `1`).  `delta`
   * must be `>= 0` — increments are the only allowed operation.
   */
  increment(replica: ReplicaId, delta: number = 1): GCounter {
    if (delta < 0) throw new Error(`GCounter.increment requires delta >= 0, got ${delta}`);
    if (!Number.isFinite(delta)) throw new Error(`GCounter.increment requires a finite delta`);
    const next = new Map(this.state);
    next.set(replica, (next.get(replica) ?? 0) + delta);
    return new GCounter(next);
  }

  /** Total count = sum of every replica's contribution. */
  value(): number {
    let total = 0;
    for (const v of this.state.values()) total += v;
    return total;
  }

  merge(other: GCounter): GCounter {
    const next = new Map(this.state);
    for (const [replica, count] of other.state) {
      const ours = next.get(replica) ?? 0;
      if (count > ours) next.set(replica, count);
    }
    return new GCounter(next);
  }

  /* ---------------------------- serialization --------------------------- */

  toJSON(): GCounterJson {
    return { kind: 'GCounter', state: Object.fromEntries(this.state) };
  }

  static fromJSON(json: GCounterJson): GCounter {
    if (json.kind !== 'GCounter') throw new Error(`GCounter.fromJSON: unexpected kind ${json.kind}`);
    return new GCounter(new Map(Object.entries(json.state)));
  }

  /** Equality by value — two counters with the same per-replica counts. */
  equals(other: GCounter): boolean {
    if (this.state.size !== other.state.size) return false;
    for (const [k, v] of this.state) {
      if (other.state.get(k) !== v) return false;
    }
    return true;
  }
}

export interface GCounterJson {
  readonly kind: 'GCounter';
  readonly state: Record<ReplicaId, number>;
}
