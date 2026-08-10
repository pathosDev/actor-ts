/**
 * A `Map` that also answers in the opposite direction (#1035).
 *
 * **Why.**  A reverse index written by hand is two maps that have to be
 * updated in lockstep, and the failure mode when they drift is silent: a
 * stale reverse entry keeps answering for a pair that was already removed.
 * Owning both directions in one object removes that class of bug — every
 * mutation goes through a single place that maintains
 * `forward.size === reverse.size`.
 *
 * **Uniqueness.**  Values are keys of the reverse map, so they are unique:
 * the relation is 1:1 in both directions and `values()` is effectively a set.
 * A one-to-many relation is a different data structure and does not belong
 * here.
 *
 * **Displacement.**  `set` binds the pair unconditionally, evicting whatever
 * held either side before.  `set('a', 1)` followed by `set('b', 1)` therefore
 * leaves a map of size 1 — `'a'` is gone.  This is the one place the class
 * departs from the `Map` contract it implements, and it is deliberate: it
 * keeps the type usable wherever a `Map` is expected, and code that wants to
 * detect the collision instead has {@link BidirectionalMap.trySet}.
 *
 * **Equality.**  Both directions are backed by `Map`, so both use
 * SameValueZero.  `NaN` works as a key and as a value, `0` and `-0` are the
 * same, and two structurally equal objects are two different values — index
 * a derived string if you need structural identity.
 *
 * **Persistence.**  Instances survive a journal, snapshot or durable-state
 * round-trip as real instances, with no adapter and no registration — the
 * tagged JSON tree in `src/serialization/JsonTree.ts` knows them the way it
 * knows `Map` and `Set`.  {@link BidirectionalMap.toJSON} additionally covers
 * the cluster wire, which uses bare `JSON.stringify` and does not go through
 * that tree.
 */

/**
 * Wire shape of a {@link BidirectionalMap}.
 *
 * Only the forward direction is written: the reverse map is fully determined
 * by it, so storing both would double the payload for nothing.
 */
export type BidirectionalMapJson<K, V> = {
  readonly kind: 'BidirectionalMap';
  readonly entries: readonly (readonly [K, V])[];
};

/**
 * SameValueZero, the equality `Map` itself uses for keys.
 *
 * `a !== a` is the NaN test that needs no cast — `Number.isNaN` would demand
 * one, since the operands are `unknown` here.
 */
function sameValueZero(a: unknown, b: unknown): boolean {
  return a === b || (a !== a && b !== b);
}

export class BidirectionalMap<K, V> implements Map<K, V> {
  /**
   * Key → value.  Not `readonly`: {@link BidirectionalMap.inverse} builds a
   * view by pointing a fresh instance at these same two maps, swapped.  They
   * are never reassigned anywhere else.
   */
  private forward: Map<K, V>;
  /** Value → key.  Holds exactly the inverse of {@link forward}. */
  private reverse: Map<V, K>;

  /**
   * Builds an empty map, or one seeded from `entries` the way `new Map(…)`
   * seeds itself.  Seeding goes through `set`, so a duplicate key or a
   * duplicate value in the input resolves last-wins rather than corrupting
   * the invariant.
   */
  constructor(entries?: Iterable<readonly [K, V]> | null) {
    this.forward = new Map<K, V>();
    this.reverse = new Map<V, K>();
    if (entries) {
      for (const [key, value] of entries) this.set(key, value);
    }
  }

  /** Number of pairs.  Both directions always agree on it. */
  get size(): number {
    return this.forward.size;
  }

  /**
   * Binds `key` to `value`, **evicting whatever held either side before** —
   * see the note on displacement in the class docs.  Use
   * {@link BidirectionalMap.trySet} to refuse instead of evicting.
   */
  set(key: K, value: V): this {
    // Guarded by `has`, never by truthiness: `0`, `''`, `false` and `NaN` are
    // ordinary keys and values here, and a truthiness check would skip
    // exactly them, stranding the entry on the other side.
    if (this.forward.has(key)) {
      this.reverse.delete(this.forward.get(key) as V);
    }
    if (this.reverse.has(value)) {
      this.forward.delete(this.reverse.get(value) as K);
    }
    this.forward.set(key, value);
    this.reverse.set(value, key);
    return this;
  }

  /**
   * Binds `key` to `value` only when that removes nothing: `false` — and no
   * mutation at all — if either side is already bound to something else.
   * Re-writing a pair that is already present is a no-op and returns `true`.
   */
  trySet(key: K, value: V): boolean {
    const keyIsBound = this.forward.has(key);
    const valueIsBound = this.reverse.has(value);
    if (keyIsBound || valueIsBound) {
      return keyIsBound && valueIsBound && sameValueZero(this.forward.get(key), value);
    }
    this.forward.set(key, value);
    this.reverse.set(value, key);
    return true;
  }

  /** The value bound to `key`, or `undefined`. */
  get(key: K): V | undefined {
    return this.forward.get(key);
  }

  /**
   * The key bound to `value`, or `undefined` — the whole point of the type.
   * Matches by SameValueZero, so two structurally equal objects are two
   * different values.
   */
  getKey(value: V): K | undefined {
    return this.reverse.get(value);
  }

  /** Whether `key` is bound.  Distinguishes "bound to `undefined`" from "absent". */
  has(key: K): boolean {
    return this.forward.has(key);
  }

  /** Whether `value` is bound.  Matches by SameValueZero, like {@link getKey}. */
  hasValue(value: V): boolean {
    return this.reverse.has(value);
  }

  /** Removes the pair held by `key`, from both directions.  `true` if there was one. */
  delete(key: K): boolean {
    if (!this.forward.has(key)) return false;
    const value = this.forward.get(key) as V;
    this.forward.delete(key);
    this.reverse.delete(value);
    return true;
  }

  /** Removes the pair held by `value`, from both directions.  `true` if there was one. */
  deleteValue(value: V): boolean {
    if (!this.reverse.has(value)) return false;
    const key = this.reverse.get(value) as K;
    this.reverse.delete(value);
    this.forward.delete(key);
    return true;
  }

  /** Drops every pair. */
  clear(): void {
    this.forward.clear();
    this.reverse.clear();
  }

  /**
   * Iterates in insertion order, like `Map.forEach`.
   *
   * The third callback argument is **this map**, not the internal forward
   * one.  Handing out the internal map would let a callback mutate one
   * direction directly and leave the other stale — the invariant has to be
   * unreachable from outside, not merely undocumented.
   */
  forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.forward) callback.call(thisArg, value, key, this);
  }

  /** `[key, value]` pairs, in insertion order. */
  entries(): MapIterator<[K, V]> {
    return this.forward.entries();
  }

  /** The keys, in insertion order. */
  keys(): MapIterator<K> {
    return this.forward.keys();
  }

  /** The values, in insertion order.  Every one is unique, so this is a set. */
  values(): MapIterator<V> {
    return this.forward.values();
  }

  /** `[value, key]` pairs — the reverse direction, in its own insertion order. */
  reverseEntries(): MapIterator<[V, K]> {
    return this.reverse.entries();
  }

  /**
   * The same map, read the other way round — a **view over the same storage**,
   * not a copy.  A write on either side is visible from the other, and
   * `inverse().inverse()` is another view with the original orientation.
   */
  inverse(): BidirectionalMap<V, K> {
    const view = new BidirectionalMap<V, K>();
    view.forward = this.reverse;
    view.reverse = this.forward;
    return view;
  }

  /**
   * The value bound to `key`, inserting `defaultValue` first if there is
   * none.  Inserting goes through `set`, so it can displace whichever key
   * held `defaultValue` before.
   */
  getOrInsert(key: K, defaultValue: V): V {
    if (this.forward.has(key)) return this.forward.get(key) as V;
    this.set(key, defaultValue);
    return defaultValue;
  }

  /**
   * The value bound to `key`, computing and inserting one if there is none.
   * `callback` runs at most once, and only on the inserting path.
   */
  getOrInsertComputed(key: K, callback: (key: K) => V): V {
    if (this.forward.has(key)) return this.forward.get(key) as V;
    const value = callback(key);
    this.set(key, value);
    return value;
  }

  /**
   * The **key** bound to `value`, inserting `defaultKey` first if there is
   * none.  The mirror of {@link getOrInsert} — note it returns a key, not a
   * value.
   */
  getOrInsertKey(value: V, defaultKey: K): K {
    if (this.reverse.has(value)) return this.reverse.get(value) as K;
    this.set(defaultKey, value);
    return defaultKey;
  }

  /**
   * The **key** bound to `value`, computing and inserting one if there is
   * none.  `callback` runs at most once — it typically mints an identifier,
   * so calling it twice would hand back one that was never stored.
   */
  getOrInsertComputedKey(value: V, callback: (value: V) => K): K {
    if (this.reverse.has(value)) return this.reverse.get(value) as K;
    const key = callback(value);
    this.set(key, value);
    return key;
  }

  /**
   * Wire shape — the forward pairs only, tagged so a decoder can tell what it
   * is.  Honoured by `JSON.stringify`, which is what carries the map over the
   * cluster wire; persistence stores use the richer `JsonTree` tag instead
   * and never reach this method.
   */
  toJSON(): BidirectionalMapJson<K, V> {
    return { kind: 'BidirectionalMap', entries: [...this.forward] };
  }

  /**
   * Rebuilds a map from {@link toJSON} output, restoring the reverse
   * direction from the forward pairs.
   *
   * The payload is an array of pairs rather than an object, which is why this
   * decoder needs none of the `__proto__` guards a peer-facing object decoder
   * does: keys go into a `Map`, where `'__proto__'` is an ordinary key and
   * reaches no prototype setter.
   */
  static fromJSON<K, V>(json: BidirectionalMapJson<K, V>): BidirectionalMap<K, V> {
    if (json === null || typeof json !== 'object' || json.kind !== 'BidirectionalMap') {
      throw new Error(`BidirectionalMap.fromJSON: unexpected kind ${String(json?.kind)}`);
    }
    if (!Array.isArray(json.entries)) {
      throw new Error('BidirectionalMap.fromJSON: entries must be an array of pairs');
    }
    return new BidirectionalMap<K, V>(json.entries);
  }

  /** `[key, value]` pairs — makes the map spreadable and `for…of`-able. */
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.forward.entries();
  }

  /** Makes `Object.prototype.toString.call(…)` report `[object BidirectionalMap]`. */
  get [Symbol.toStringTag](): string {
    return 'BidirectionalMap';
  }
}
