import { MAX_COUNTER_SLOT, MAX_CRDT_ENTRIES } from './Constants.js';
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

  /**
   * Componentwise maximum, bounded at {@link MAX_CRDT_ENTRIES} slots.
   *
   * **Why a merge needs a bound at all.**  {@link MAX_COUNTER_SLOT} is not an
   * independent number — `Constants.ts` computes it as
   * `MAX_SAFE_INTEGER / MAX_CRDT_ENTRIES`, precisely so that a counter holding
   * the most slots a decoder will accept, each at the ceiling, still sums to a
   * safe integer.  The per-slot ceiling is therefore only sound while the slot
   * *count* is bounded, and merge was the one operation that could raise the
   * count without passing a decoder.  Two counters that each decode — 4096
   * slots apiece — merged to 8192, `value()` returned 18014398509477888, and
   * `fromJSON(merged.toJSON())` threw.  Since every wire call site routes
   * through `decodeOrDrop`, every peer then dropped that key and it stopped
   * converging cluster-wide: a permanent, unrecoverable loss caused by one
   * frame that was valid in every respect the decoder checks (#1407).
   *
   * **What is given up, because something has to be.**  Slots already held are
   * never disturbed: each still takes its componentwise maximum, so no replica
   * loses a count it had, and the local replica's own contribution is safe.
   * Only *new* replica ids compete for the remaining room, and they are
   * admitted in sorted id order so the result does not depend on `Map`
   * iteration order.  What that costs is commutativity **in the overflow case
   * only** — with more than {@link MAX_CRDT_ENTRIES} distinct ids in play,
   * `a.merge(b)` and `b.merge(a)` can keep different newcomers.
   *
   * That is the least-bad of three losses, and the other two are worth naming
   * so this is not re-litigated from scratch: refusing the merge outright makes
   * a CRDT join partial, which callers have no reason to expect and which turns
   * one hostile frame into a throw on the receiving path; evicting the smallest
   * slots keeps the join total but lets a counter go *down*, which is the one
   * thing a grow-only counter promises it will not do.  Losing commutativity in
   * a state the cluster is not designed to reach is cheaper than losing
   * monotonicity in every state, or than the unrecoverable key this replaces.
   *
   * The remaining exposure is that a peer flooding fresh ids can consume the
   * room a genuine new replica needed.  Bounding who may occupy a slot in the
   * first place belongs upstream — pruning departed replicas is #955 — and is
   * not something a value type can decide.
   */
  merge(other: GCounter): GCounter {
    const next = new Map(this.state);
    const newcomers: ReplicaId[] = [];
    for (const [replica, count] of other.state) {
      if (!next.has(replica)) {
        newcomers.push(replica);
        continue;
      }
      const ours = next.get(replica) ?? 0;
      if (count > ours) next.set(replica, count);
    }
    // Sorted rather than in `other`'s iteration order: two replicas that merge
    // the same pair of counters have to reach the same state, and insertion
    // order is a property of how a Map happened to be built.
    newcomers.sort();
    for (const replica of newcomers) {
      if (next.size >= MAX_CRDT_ENTRIES) break;
      next.set(replica, other.state.get(replica)!);
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
