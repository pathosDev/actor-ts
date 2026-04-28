import type { ReplicaId } from '../../crdt/Crdt.js';

/**
 * Vector clock — a logical timestamp per replica that captures the
 * "happens-before" relation between events across nodes.
 *
 * For each pair of clocks `a`, `b`:
 *
 *   - **a < b** ("a happens-before b") iff every component of `a` is
 *     `<= b`'s and at least one is strictly less.
 *   - **a == b** iff every component is equal.
 *   - Otherwise the events are **concurrent** — neither preceded
 *     the other, and a conflict resolver decides what wins.
 *
 * Used by {@link ReplicatedEventSourcedActor} to recognise
 * concurrent edits to the same persistenceId from different
 * replicas, and by the {@link ConflictResolver} plug-in to merge
 * those concurrent events deterministically.
 *
 * **Wire shape**: a plain `Record<ReplicaId, number>`.  Empty
 * components are treated as `0`, so omitting them is fine for
 * compactness on the wire.
 */
export type VectorClockData = Readonly<Record<ReplicaId, number>>;

export class VectorClock {
  private constructor(private readonly entries: ReadonlyMap<ReplicaId, number>) {}

  /** All components zero. */
  static empty(): VectorClock { return new VectorClock(new Map()); }

  /** Build from an object literal — omitted entries are treated as 0. */
  static fromData(data: VectorClockData): VectorClock {
    return new VectorClock(new Map(Object.entries(data)));
  }

  /** Get the value for `replica`; missing entries are 0. */
  get(replica: ReplicaId): number { return this.entries.get(replica) ?? 0; }

  /** Bump `replica`'s component by 1 — typically called when persisting. */
  tick(replica: ReplicaId): VectorClock {
    const next = new Map(this.entries);
    next.set(replica, (next.get(replica) ?? 0) + 1);
    return new VectorClock(next);
  }

  /** Component-wise max — used after observing a remote event. */
  merge(other: VectorClock): VectorClock {
    const next = new Map(this.entries);
    for (const [r, v] of other.entries) {
      const ours = next.get(r) ?? 0;
      if (v > ours) next.set(r, v);
    }
    return new VectorClock(next);
  }

  /**
   * Compare with another clock.
   *
   * Returns:
   *   - `'before'`     — every component of `this` is `<= other`
   *                       and at least one is strictly less.
   *   - `'after'`      — every component of `this` is `>= other`
   *                       and at least one is strictly greater.
   *   - `'equal'`      — all components match.
   *   - `'concurrent'` — neither dominates.
   */
  compareTo(other: VectorClock): VectorClockOrder {
    const keys = new Set<ReplicaId>([...this.entries.keys(), ...other.entries.keys()]);
    let lt = false;
    let gt = false;
    for (const k of keys) {
      const a = this.get(k);
      const b = other.get(k);
      if (a < b) lt = true;
      else if (a > b) gt = true;
      if (lt && gt) return 'concurrent';
    }
    if (lt && !gt) return 'before';
    if (!lt && gt) return 'after';
    return 'equal';
  }

  /** True iff `this` strictly happens-before `other`. */
  happensBefore(other: VectorClock): boolean { return this.compareTo(other) === 'before'; }

  /** True iff `this` and `other` are concurrent (neither dominates). */
  isConcurrentWith(other: VectorClock): boolean { return this.compareTo(other) === 'concurrent'; }

  toJSON(): VectorClockData {
    const out: Record<ReplicaId, number> = {};
    for (const [k, v] of this.entries) out[k] = v;
    return out;
  }

  toString(): string {
    const pairs: string[] = [];
    const sorted = Array.from(this.entries.keys()).sort();
    for (const k of sorted) pairs.push(`${k}=${this.entries.get(k)}`);
    return `VC{${pairs.join(', ')}}`;
  }
}

export type VectorClockOrder = 'before' | 'after' | 'equal' | 'concurrent';
