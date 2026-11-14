import type { Crdt, ReplicaId } from './Crdt.js';
import {
  assertPlausibleTimestamp,
  assertString,
} from './CrdtWireValidation.js';

/**
 * Last-Writer-Wins register.  A single value with a timestamp; on
 * `merge` the higher timestamp wins.  Concurrent writes (same ts on
 * two replicas) are resolved deterministically by `replicaId`
 * lexicographic order — same input on every node, same winner — and a
 * write tied on both (one replica, two values, one millisecond) by the
 * value's JSON rendering (#950).
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
    if (other._replica > this._replica) return other;
    if (other._replica < this._replica) return this;
    // A full tie: one replica stamped two values at one timestamp — two writes
    // in one millisecond.  Falling through to `this` made merge keep its left
    // argument, so two nodes receiving the pair in opposite orders kept
    // different values forever (#950).  The value is the last key of the total
    // order: any deterministic comparison works, as long as it never depends
    // on which register is `this`.
    return tieBreakKey(other._value) > tieBreakKey(this._value) ? other : this;
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
    // Last-writer-wins is only as sound as the clocks feeding it: a
    // far-future stamp beats every honest write from here on, and gets
    // re-gossiped so the whole cluster converges on the wedge (#724).
    assertPlausibleTimestamp(json.timestamp, 'LWWRegister.timestamp');
    // The tie-break reads `replica` with `>`, and `>` between a string and a
    // number is false in *both* directions — so a numeric replica id makes
    // `a.merge(b)` and `b.merge(a)` each keep their own value and the two
    // replicas never converge.  An array is the opposite failure: it coerces
    // to its single element, so one holding a high code point wins every tie
    // while not being a string at all.  `assign` can produce neither; only
    // the wire could.
    assertString(json.replica, 'LWWRegister.replica');
    return new LWWRegister<V>(json.value, json.timestamp, json.replica);
  }

  equals(other: LWWRegister<V>): boolean {
    return this._timestamp === other._timestamp
      && this._replica === other._replica
      && JSON.stringify(this._value) === JSON.stringify(other._value);
  }
}

/**
 * The value's rank in a full `(timestamp, replica)` tie (#950).
 *
 * The JSON rendering, because that is what `equals` compares and what the wire
 * carries: two values that render alike are equal registers, so it does not
 * matter which of them merge keeps.  Total over what a register can hold —
 * `JSON.stringify` throws on a `bigint` and answers `undefined` for a function
 * or `undefined`, and a throw inside `merge` would fail a gossip round, so a
 * `bigint` renders as its digits with an `n` and an unrenderable value as an
 * empty key.  Called only on a full tie, so the cost is off the common path.
 */
function tieBreakKey(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? `${inner}n` : inner)) ?? '';
  } catch {
    // A cycle — not a register value anything could gossip — still ranks.
    return '';
  }
}

export type LWWRegisterJson<V> = {
  readonly kind: 'LWWRegister';
  readonly value: V | null;
  readonly timestamp: number;
  readonly replica: ReplicaId;
};
