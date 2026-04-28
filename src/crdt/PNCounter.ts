import type { Crdt, ReplicaId } from './Crdt.js';
import { GCounter, type GCounterJson } from './GCounter.js';

/**
 * Positive/Negative counter — supports both increments and decrements
 * by tracking two grow-only counters: `p` (sum of increments) and
 * `n` (sum of decrements).  Final value = `p.value() - n.value()`.
 *
 * Use this when the count can go up AND down — items in a cart,
 * connected sessions, available inventory.  For pure-increment
 * workloads use the lighter {@link GCounter}.
 *
 *   const a = PNCounter.empty().increment('node-a', 5);
 *   const b = PNCounter.empty().decrement('node-b', 2);
 *   a.merge(b).value()                          // → 3
 */
export class PNCounter implements Crdt<PNCounter> {
  private constructor(
    private readonly p: GCounter,
    private readonly n: GCounter,
  ) {}

  static empty(): PNCounter {
    return new PNCounter(GCounter.empty(), GCounter.empty());
  }

  increment(replica: ReplicaId, delta: number = 1): PNCounter {
    if (delta < 0) throw new Error(`PNCounter.increment requires delta >= 0, got ${delta}`);
    return new PNCounter(this.p.increment(replica, delta), this.n);
  }

  decrement(replica: ReplicaId, delta: number = 1): PNCounter {
    if (delta < 0) throw new Error(`PNCounter.decrement requires delta >= 0, got ${delta}`);
    return new PNCounter(this.p, this.n.increment(replica, delta));
  }

  value(): number { return this.p.value() - this.n.value(); }

  merge(other: PNCounter): PNCounter {
    return new PNCounter(this.p.merge(other.p), this.n.merge(other.n));
  }

  toJSON(): PNCounterJson {
    return { kind: 'PNCounter', p: this.p.toJSON(), n: this.n.toJSON() };
  }

  static fromJSON(json: PNCounterJson): PNCounter {
    if (json.kind !== 'PNCounter') throw new Error(`PNCounter.fromJSON: unexpected kind ${json.kind}`);
    return new PNCounter(GCounter.fromJSON(json.p), GCounter.fromJSON(json.n));
  }

  equals(other: PNCounter): boolean {
    return this.p.equals(other.p) && this.n.equals(other.n);
  }
}

export interface PNCounterJson {
  readonly kind: 'PNCounter';
  readonly p: GCounterJson;
  readonly n: GCounterJson;
}
