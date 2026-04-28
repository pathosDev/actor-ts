import type { Crdt, ReplicaId } from './Crdt.js';

/**
 * Last-Writer-Wins register.  A single value with a timestamp; on
 * `merge` the higher timestamp wins.  Concurrent writes (same ts on
 * two replicas) are resolved deterministically by `replicaId`
 * lexicographic order — same input on every node, same winner.
 *
 * Use this for **single-value state** that's eventually consistent —
 * a user's display name, a feature-flag value, the latest-known
 * health status of a service.  When concurrent writes are common,
 * pick a CRDT that captures both branches (e.g. an OR-Set of values)
 * instead.
 *
 * **Wall-clock pitfall.**  Default timestamps come from `Date.now()`,
 * which can drift between machines and even go backwards on the same
 * machine (NTP correction).  In practice this means a write from a
 * faster-clocked node always wins; if that's a problem, pass a
 * `clock` option backed by a hybrid logical clock (HLC) or a Lamport
 * counter.
 *
 *   const a = LWWRegister.empty<string>().assign('a', 'red');
 *   const b = LWWRegister.empty<string>().assign('b', 'blue');
 *   a.merge(b).value()   // → whichever assign() was called later
 */
export class LWWRegister<V> implements Crdt<LWWRegister<V>> {
  private constructor(
    private readonly _value: V | null,
    private readonly _timestamp: number,
    private readonly _replica: ReplicaId,
  ) {}

  /** Empty register — no value yet.  `value()` returns `null`. */
  static empty<V>(): LWWRegister<V> {
    return new LWWRegister<V>(null, 0, '');
  }

  /**
   * Set the register to `value`, stamped with `timestamp` (default
   * `Date.now()`) on behalf of `replica`.  The timestamp is what
   * `merge` uses to decide who wins — pass an explicit one if you
   * want HLC/Lamport semantics.
   */
  assign(replica: ReplicaId, value: V, timestamp: number = Date.now()): LWWRegister<V> {
    return new LWWRegister<V>(value, timestamp, replica);
  }

  /** Current value, or `null` if no `assign` has been called. */
  value(): V | null { return this._value; }

  /** Timestamp of the last write — `0` for an empty register. */
  timestamp(): number { return this._timestamp; }

  merge(other: LWWRegister<V>): LWWRegister<V> {
    // Empty register loses to any non-empty one.
    if (this._timestamp === 0) return other;
    if (other._timestamp === 0) return this;

    if (other._timestamp > this._timestamp) return other;
    if (other._timestamp < this._timestamp) return this;
    // Tie on timestamp — break by replica id so every node converges
    // to the same winner regardless of arrival order.
    return other._replica > this._replica ? other : this;
  }

  toJSON(): LWWRegisterJson<V> {
    return {
      kind: 'LWWRegister',
      value: this._value,
      timestamp: this._timestamp,
      replica: this._replica,
    };
  }

  static fromJSON<V>(json: LWWRegisterJson<V>): LWWRegister<V> {
    if (json.kind !== 'LWWRegister') throw new Error(`LWWRegister.fromJSON: unexpected kind ${json.kind}`);
    return new LWWRegister<V>(json.value, json.timestamp, json.replica);
  }

  equals(other: LWWRegister<V>): boolean {
    return this._timestamp === other._timestamp
      && this._replica === other._replica
      && JSON.stringify(this._value) === JSON.stringify(other._value);
  }
}

export interface LWWRegisterJson<V> {
  readonly kind: 'LWWRegister';
  readonly value: V | null;
  readonly timestamp: number;
  readonly replica: ReplicaId;
}
