/**
 * A many-to-many relation that maintains both directions at once (#1037).
 *
 * **Why.**  {@link BidirectionalMap} removes the lockstep problem for a 1:1
 * relation; this removes it one degree harder.  A subscription registry —
 * one subscriber holds many topics, one topic has many subscribers — is two
 * maps of sets, and dropping a participant means reaching into every set it
 * appears in.  Written by hand that is re-derived at every site, and when
 * the halves drift the failure is silent: a dead subscriber keeps being
 * told, or a topic that nobody holds keeps occupying a cap.
 *
 * **Participants, not entries.**  There is no such thing as an empty
 * participant here.  Removing the last partner deletes the participant from
 * both directions, so `hasLeft` answers "has at least one partner" and
 * {@link BidirectionalMultiMap.inverse} can never hand out a phantom.  An
 * empty `Set` left behind would be the very leak the class exists to
 * prevent.
 *
 * **`size` counts pairs**, not participants — the two rarely agree, and
 * pairs are what a cap is usually written against.
 *
 * **Equality.**  Both directions are backed by `Map` and `Set`, so both use
 * SameValueZero.  `NaN` works as a participant, `0` and `-0` are the same,
 * and two structurally equal objects are two different participants — index
 * a derived string if you need structural identity.  That is what the
 * framework's own call sites do, keying on `ref.path.toString()` rather
 * than on the ref, because a `Terminated` carries the cell's own `self` ref
 * and not the object that subscribed.
 *
 * **Reads hand out the live set.**  {@link BidirectionalMultiMap.get}
 * returns the internal `Set`, typed `ReadonlySet`, rather than a copy.  This
 * is the one place the class is less defensive than its 1:1 sibling, which
 * goes out of its way to keep its invariant unreachable from outside: a
 * caller who casts the result back to `Set` and mutates it corrupts the
 * inverse.  A copy was rejected because the relation is read on fan-out
 * paths — once per published message — where an O(n) allocation per read is
 * not payable.
 *
 * **Persistence.**  Instances survive a journal, snapshot or durable-state
 * round-trip as real instances, with no adapter and no registration — the
 * tagged JSON tree in `src/serialization/JsonTree.ts` knows them the way it
 * knows `Map` and `Set`.  {@link BidirectionalMultiMap.toJSON} additionally
 * covers the cluster wire, which uses bare `JSON.stringify` and does not go
 * through that tree.
 */

/**
 * Wire shape of a {@link BidirectionalMultiMap}.
 *
 * An adjacency list rather than a flat list of pairs: one participant with
 * many partners is the shape every call site has, and repeating the left
 * participant once per pair would double the row for nothing.  Only the
 * forward direction is written — the reverse is fully determined by it, so
 * a decoder is never handed two sources of truth to disagree about.
 */
export type BidirectionalMultiMapJson<L, R> = {
  readonly kind: 'BidirectionalMultiMap';
  readonly entries: readonly (readonly [L, readonly R[]])[];
};

/**
 * Answers every lookup for a participant that has no partners.
 *
 * Module-private and never mutated, so the single shared instance cannot be
 * observed changing.  Handing back one frozen empty set beats allocating a
 * fresh one per miss on paths that ask about absent topics routinely.
 */
const EMPTY: ReadonlySet<never> = new Set<never>();

/**
 * How many pairs the relation holds, in a box rather than a field.
 *
 * {@link BidirectionalMultiMap.inverse} builds a view by pointing a second
 * instance at the same two maps, swapped; a plain counter field would give
 * that view its own copy, and the two would drift apart on the first write
 * through either side.  Sharing the box is what keeps `size` true on both.
 */
type PairCounter = { pairs: number };

export class BidirectionalMultiMap<L, R> {
  /**
   * Left participant → its partners.  Not `readonly`: {@link inverse} points
   * a fresh instance at these same two maps, swapped.  They are never
   * reassigned anywhere else.
   */
  private forward: Map<L, Set<R>>;
  /** Right participant → its partners.  Holds exactly the inverse of {@link forward}. */
  private reverse: Map<R, Set<L>>;
  /** Shared with every view this map hands out — see {@link PairCounter}. */
  private counter: PairCounter;

  /**
   * Builds an empty relation, or one seeded from `pairs`.  Seeding goes
   * through `add`, so a repeated pair in the input is idempotent rather
   * than counted twice.
   */
  constructor(pairs?: Iterable<readonly [L, R]> | null) {
    this.forward = new Map<L, Set<R>>();
    this.reverse = new Map<R, Set<L>>();
    this.counter = { pairs: 0 };
    if (pairs) {
      for (const [left, right] of pairs) this.add(left, right);
    }
  }

  /** Number of pairs — not participants.  Both directions always agree on it. */
  get size(): number {
    return this.counter.pairs;
  }

  /** Relates `left` and `right`.  Adding a pair that already exists is a no-op. */
  add(left: L, right: R): this {
    let partners = this.forward.get(left);
    if (!partners) {
      partners = new Set<R>();
      this.forward.set(left, partners);
    }
    if (partners.has(right)) return this;
    partners.add(right);
    let holders = this.reverse.get(right);
    if (!holders) {
      holders = new Set<L>();
      this.reverse.set(right, holders);
    }
    holders.add(left);
    this.counter.pairs++;
    return this;
  }

  /**
   * Removes one pair from both directions.  `true` if there was one.
   *
   * A participant left with no partners is removed outright — see the note
   * on participants in the class docs.
   */
  delete(left: L, right: R): boolean {
    const partners = this.forward.get(left);
    if (!partners?.delete(right)) return false;
    if (partners.size === 0) this.forward.delete(left);
    const holders = this.reverse.get(right);
    // Guarded by `has`-style narrowing rather than truthiness throughout: a
    // participant may legitimately be `0`, `''`, `false` or `NaN`, and a
    // truthiness check would skip exactly those, stranding them on the other
    // side.
    if (holders) {
      holders.delete(left);
      if (holders.size === 0) this.reverse.delete(right);
    }
    this.counter.pairs--;
    return true;
  }

  /**
   * Everything `left` is related to — the live set, in insertion order.
   * Empty when `left` has no partners, never `undefined`, so a caller can
   * iterate the result without a guard.
   */
  get(left: L): ReadonlySet<R> {
    return this.forward.get(left) ?? (EMPTY as ReadonlySet<R>);
  }

  /** Everything related to `right` — the mirror of {@link get}, and the whole point of the type. */
  getKeys(right: R): ReadonlySet<L> {
    return this.reverse.get(right) ?? (EMPTY as ReadonlySet<L>);
  }

  /**
   * Drops `left` and every pair it held — the `Terminated` case, where one
   * participant stops and has to leave no trace on the other side.  `true`
   * if it held anything.
   */
  deleteLeft(left: L): boolean {
    const partners = this.forward.get(left);
    if (!partners) return false;
    this.forward.delete(left);
    for (const right of partners) {
      const holders = this.reverse.get(right);
      if (!holders) continue;
      holders.delete(left);
      if (holders.size === 0) this.reverse.delete(right);
    }
    this.counter.pairs -= partners.size;
    return true;
  }

  /** Drops `right` and every pair it held — the mirror of {@link deleteLeft}. */
  deleteRight(right: R): boolean {
    const holders = this.reverse.get(right);
    if (!holders) return false;
    this.reverse.delete(right);
    for (const left of holders) {
      const partners = this.forward.get(left);
      if (!partners) continue;
      partners.delete(right);
      if (partners.size === 0) this.forward.delete(left);
    }
    this.counter.pairs -= holders.size;
    return true;
  }

  /** Whether the pair is present. */
  has(left: L, right: R): boolean {
    return this.forward.get(left)?.has(right) ?? false;
  }

  /** Whether `left` has at least one partner. */
  hasLeft(left: L): boolean {
    return this.forward.has(left);
  }

  /** Whether `right` has at least one partner. */
  hasRight(right: R): boolean {
    return this.reverse.has(right);
  }

  /** Drops every pair. */
  clear(): void {
    this.forward.clear();
    this.reverse.clear();
    this.counter.pairs = 0;
  }

  /** The left participants, in insertion order.  Every one has at least one partner. */
  lefts(): MapIterator<L> {
    return this.forward.keys();
  }

  /** The right participants, in insertion order.  Every one has at least one partner. */
  rights(): MapIterator<R> {
    return this.reverse.keys();
  }

  /** Every pair as `[left, right]`, grouped by left participant in insertion order. */
  *entries(): IterableIterator<[L, R]> {
    for (const [left, partners] of this.forward) {
      for (const right of partners) yield [left, right];
    }
  }

  /**
   * Runs `callback` for every pair.
   *
   * The third argument is **this map**, not an internal one.  Handing out
   * the storage would let a callback mutate one direction directly and
   * leave the other stale — the same reasoning as the 1:1 sibling's
   * `forEach`.
   */
  forEach(
    callback: (right: R, left: L, map: BidirectionalMultiMap<L, R>) => void,
    thisArg?: unknown,
  ): void {
    for (const [left, right] of this.entries()) callback.call(thisArg, right, left, this);
  }

  /**
   * The same relation read the other way round — a **view over the same
   * storage**, not a copy.  A write on either side is visible from the
   * other, `size` stays true on both, and `inverse().inverse()` is another
   * view with the original orientation.
   */
  inverse(): BidirectionalMultiMap<R, L> {
    const view = new BidirectionalMultiMap<R, L>();
    view.forward = this.reverse;
    view.reverse = this.forward;
    view.counter = this.counter;
    return view;
  }

  /**
   * Wire shape — the forward adjacency list only, tagged so a decoder can
   * tell what it is.  Honoured by `JSON.stringify`, which is what carries
   * the relation over the cluster wire; persistence stores use the richer
   * `JsonTree` tag instead and never reach this method.
   */
  toJSON(): BidirectionalMultiMapJson<L, R> {
    const entries: [L, R[]][] = [];
    for (const [left, partners] of this.forward) entries.push([left, [...partners]]);
    return { kind: 'BidirectionalMultiMap', entries };
  }

  /**
   * Rebuilds a relation from {@link toJSON} output, restoring the reverse
   * direction from the forward rows.
   *
   * The payload is an array of rows rather than an object, which is why this
   * decoder needs none of the `__proto__` guards a peer-facing object decoder
   * does: participants go into a `Map`, where `'__proto__'` is an ordinary
   * key and reaches no prototype setter.
   */
  static fromJSON<L, R>(json: BidirectionalMultiMapJson<L, R>): BidirectionalMultiMap<L, R> {
    if (json === null || typeof json !== 'object' || json.kind !== 'BidirectionalMultiMap') {
      throw new Error(`BidirectionalMultiMap.fromJSON: unexpected kind ${String(json?.kind)}`);
    }
    if (!Array.isArray(json.entries)) {
      throw new Error('BidirectionalMultiMap.fromJSON: entries must be an array of rows');
    }
    const map = new BidirectionalMultiMap<L, R>();
    for (const row of json.entries) {
      if (!Array.isArray(row) || row.length !== 2 || !Array.isArray(row[1])) {
        throw new Error('BidirectionalMultiMap.fromJSON: each row must be [left, right[]]');
      }
      for (const right of row[1]) map.add(row[0], right);
    }
    return map;
  }

  /** Every pair as `[left, right]` — makes the relation spreadable and `for…of`-able. */
  [Symbol.iterator](): IterableIterator<[L, R]> {
    return this.entries();
  }

  /** Makes `Object.prototype.toString.call(…)` report `[object BidirectionalMultiMap]`. */
  get [Symbol.toStringTag](): string {
    return 'BidirectionalMultiMap';
  }
}
