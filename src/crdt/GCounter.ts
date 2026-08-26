import { MAX_COUNTER_SLOT } from './Constants.js';
import type { Crdt, ReplicaId } from './Crdt.js';
import {
  assertCounterValue,
  assertPlainObject,
  safeEntries,
} from './CrdtWireValidation.js';

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
 * **One slot is capped** at {@link MAX_COUNTER_SLOT} ≈ 2.2e12, so a
 * saturated counter still sums exactly.  It binds in practice on exactly
 * one shape of counter — raw bytes on a long-lived replica — and the
 * answer there is a coarser unit, kibibytes rather than bytes.
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
   * must be `>= 0` — increments are the only allowed operation — and the
   * resulting slot must stay under {@link MAX_COUNTER_SLOT}.
   *
   * The ceiling is checked here as well as in the decoder because it has to be
   * a property of the *type*, not of one direction of travel.  A slot built
   * past it locally would be legal in memory and rejected by every peer that
   * received it and by this replica's own durable record on the next reload —
   * divergence with a warning line as its only symptom (#720).  Failing on the
   * increment that crosses the line names the operation that did it.
   */
  increment(replica: ReplicaId, delta: number = 1): GCounter {
    if (delta < 0) throw new Error(`GCounter.increment requires delta >= 0, got ${delta}`);
    if (!Number.isFinite(delta)) throw new Error(`GCounter.increment requires a finite delta`);
    const next = new Map(this.state);
    const count = (next.get(replica) ?? 0) + delta;
    if (count > MAX_COUNTER_SLOT) {
      throw new Error(
        `GCounter.increment would put replica '${replica}' at ${count}, `
        + `over the ${MAX_COUNTER_SLOT} ceiling a decoded slot may hold`,
      );
    }
    next.set(replica, count);
    return new GCounter(next);
  }

  /** Total count = sum of every replica's contribution. */
  value(): number {
    let total = 0;
    for (const count of this.state.values()) total += count;
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
    // Merge takes a componentwise maximum, so an out-of-range slot is not a
    // transient error: it becomes that replica's permanent floor across the
    // whole cluster, and `value()` sums whatever is stored (#720).
    assertPlainObject(json.state, 'GCounter.state');
    const state = new Map<string, number>();
    for (const [replicaId, count] of safeEntries(json.state, 'GCounter.state')) {
      assertCounterValue(count, `GCounter.state['${replicaId}']`);
      state.set(replicaId, count);
    }
    return new GCounter(state);
  }

  /** Equality by value — two counters with the same per-replica counts. */
  equals(other: GCounter): boolean {
    if (this.state.size !== other.state.size) return false;
    for (const [replicaId, count] of this.state) {
      if (other.state.get(replicaId) !== count) return false;
    }
    return true;
  }
}

export type GCounterJson = {
  readonly kind: 'GCounter';
  readonly state: Record<ReplicaId, number>;
};
