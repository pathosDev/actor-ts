import type { Crdt, ReplicaId } from './Crdt.js';
import { ORSet, type ORSetJson } from './ORSet.js';

/**
 * Observed-Remove map, where each **value** is itself a CRDT.  Keys
 * follow OR-Set add-wins semantics; values merge per-key via their
 * own `merge`.  The natural fit when you want a logical map and each
 * cell needs its own conflict-free type — e.g. carts where every
 * cart is itself an `ORSet` of items, or per-tenant settings where
 * each tenant's settings is an `LWWMap`.
 *
 *   const empty = ORMap.empty<string, ORSet<string>>();
 *   const a = empty.update('alice', 'cart-1', () => ORSet.empty<string>(),
 *               (cart) => cart.add('alice', 'apple'));
 *   const b = empty.update('bob',   'cart-1', () => ORSet.empty<string>(),
 *               (cart) => cart.add('bob', 'banana'));
 *   a.merge(b).get('cart-1')!.value()
 *   // → ['apple', 'banana']  (per-key inner-CRDT merge)
 *
 * **Add-wins for keys.**  Concurrent `put(key) | remove(key)` resolves
 * via the underlying `ORSet`'s tag rules: the `put` carries a tag the
 * `remove` never saw, so it survives.  See {@link ORSet} for the
 * formal mechanism.
 *
 * **Inner-CRDT decoder injection (fromJSON).**  Because the value
 * type is itself a CRDT, deserialisation needs to know **which**
 * CRDT to build for each value.  Pass a `decodeValue: (json) => V`
 * callback to `fromJSON`; the `DistributedData` extension wires its
 * `decodeCrdt` dispatcher in for you.  Standalone usage:
 *
 *   ORMap.fromJSON(json, (v) => ORSet.fromJSON<string>(v as ORSetJson))
 *
 * **Element identity.**  Same JSON-stringify default + `identity`
 * override pattern as the rest of the map types — pass
 * `{ identity: k => ... }` for non-JSON-serialisable keys.
 */

export interface ORMapOptions<K> {
  readonly identity?: (k: K) => string;
}

const defaultIdentity = (k: unknown): string => JSON.stringify(k);

interface Entry<K, V extends Crdt<V>> {
  readonly key: K;
  readonly value: V;
}

export class ORMap<K, V extends Crdt<V>> implements Crdt<ORMap<K, V>> {
  /**
   * Logical structure:
   *   - `keyset`: an `ORSet` of identity-strings (the dedup keys),
   *     handling add-wins semantics for membership.
   *   - `entries`: `identity(K) → { key, value }`, holding the actual
   *     values keyed by the same identity-string.  We store the
   *     original `K` so iteration returns the user's instance.
   *
   * Invariant: every `entries` key is a member of `keyset`.  On merge
   * we drop value entries whose identity is no longer in the merged
   * keyset (i.e. a remove dominated the add).
   */
  private constructor(
    private readonly keyset: ORSet<string>,
    private readonly entries: ReadonlyMap<string, Entry<K, V>>,
    private readonly identity: (k: K) => string,
  ) {}

  static empty<K, V extends Crdt<V>>(opts: ORMapOptions<K> = {}): ORMap<K, V> {
    return new ORMap<K, V>(
      ORSet.empty<string>(),
      new Map(),
      opts.identity ?? (defaultIdentity as (k: K) => string),
    );
  }

  /** Set `key` to `value` on `replica`. */
  put(replica: ReplicaId, key: K, value: V): ORMap<K, V> {
    const id = this.identity(key);
    const nextKeyset = this.keyset.add(replica, id);
    const nextEntries = new Map(this.entries);
    nextEntries.set(id, { key, value });
    return new ORMap<K, V>(nextKeyset, nextEntries, this.identity);
  }

  /**
   * Mutate the value under `key` in place (functionally — returns a
   * new map).  If the key doesn't exist yet, `factory()` provides the
   * empty CRDT.  Equivalent to `put(replica, key, fn(get(key) ?? factory()))`
   * but with a single re-tag, so concurrent `update` + `remove`
   * resolves the same as concurrent `put` + `remove` would.
   */
  update(
    replica: ReplicaId, key: K,
    factory: () => V, fn: (current: V) => V,
  ): ORMap<K, V> {
    const current = this.get(key) ?? factory();
    return this.put(replica, key, fn(current));
  }

  /**
   * Remove `key`.  Concurrent puts with tags this remove never saw
   * survive — keyset-level OR-Set semantics decide liveness.  We keep
   * the value entry around even after a remove because a future merge
   * with a peer that re-added the key needs both sides' inner-CRDT
   * state to compute the right merged value (associativity demands
   * it; without it, `merge(a, b).merge(c)` can drop state that
   * `merge(a, merge(b, c))` would preserve).  Read APIs filter by
   * keyset so stale entries are invisible to users.
   */
  remove(key: K): ORMap<K, V> {
    const id = this.identity(key);
    const nextKeyset = this.keyset.remove(id);
    return new ORMap<K, V>(nextKeyset, this.entries, this.identity);
  }

  /** Read `key` — `undefined` if not present. */
  get(key: K): V | undefined {
    const id = this.identity(key);
    if (!this.keyset.has(id)) return undefined;
    return this.entries.get(id)?.value;
  }

  has(key: K): boolean {
    return this.keyset.has(this.identity(key));
  }

  /** Snapshot of currently-live keys. */
  keys(): ReadonlyArray<K> {
    const out: K[] = [];
    for (const [id, entry] of this.entries) {
      if (this.keyset.has(id)) out.push(entry.key);
    }
    return out;
  }

  /** Snapshot of `[key, value]` pairs. */
  entriesArray(): ReadonlyArray<readonly [K, V]> {
    const out: Array<readonly [K, V]> = [];
    for (const [id, entry] of this.entries) {
      if (this.keyset.has(id)) out.push([entry.key, entry.value] as const);
    }
    return out;
  }

  get size(): number {
    let n = 0;
    for (const id of this.entries.keys()) if (this.keyset.has(id)) n++;
    return n;
  }

  merge(other: ORMap<K, V>): ORMap<K, V> {
    const mergedKeyset = this.keyset.merge(other.keyset);
    const mergedEntries = new Map<string, Entry<K, V>>();

    // Iterate over the union of every id either side has ever seen —
    // not just `mergedKeyset.value()` (the live ids).  An id that's
    // currently tombstoned can be revived by a later merge with a
    // peer holding a fresh add tag; the inner-CRDT merge then needs
    // both sides' historical values.  Read APIs filter by keyset so
    // tombstoned entries stay invisible.
    const allIds = new Set<string>([...this.entries.keys(), ...other.entries.keys()]);
    for (const id of allIds) {
      const a = this.entries.get(id);
      const b = other.entries.get(id);
      if (a && b) {
        mergedEntries.set(id, { key: a.key, value: a.value.merge(b.value) });
      } else if (a) {
        mergedEntries.set(id, a);
      } else if (b) {
        mergedEntries.set(id, b);
      }
    }
    return new ORMap<K, V>(mergedKeyset, mergedEntries, this.identity);
  }

  toJSON(): ORMapJson {
    const values: Record<string, unknown> = {};
    const keyValues: Record<string, string> = {};
    for (const [id, entry] of this.entries) {
      // Each value is a CRDT — its toJSON is the standard discriminated shape.
      values[id] = entry.value.toJSON();
      keyValues[id] = JSON.stringify(entry.key);
    }
    return {
      kind: 'ORMap',
      keyset: this.keyset.toJSON(),
      values,
      keyValues,
    };
  }

  /**
   * Reconstruct an ORMap.  `decodeValue` must build the inner CRDT
   * from its JSON shape — typically `(json) => SomeCrdt.fromJSON(json)`.
   * The `DistributedData` extension provides a `decodeCrdt` that
   * dispatches across every registered CRDT kind.
   */
  static fromJSON<K, V extends Crdt<V>>(
    json: ORMapJson,
    decodeValue: (json: unknown) => V,
    opts: ORMapOptions<K> = {},
  ): ORMap<K, V> {
    if (json.kind !== 'ORMap') {
      throw new Error(`ORMap.fromJSON: unexpected kind ${json.kind}`);
    }
    const identity = opts.identity ?? (defaultIdentity as (k: K) => string);
    const keyset = ORSet.fromJSON<string>(json.keyset);
    const entries = new Map<string, Entry<K, V>>();
    for (const [id, valueJson] of Object.entries(json.values)) {
      const raw = json.keyValues?.[id];
      const key = raw !== undefined ? (JSON.parse(raw) as K) : (JSON.parse(id) as K);
      entries.set(id, { key, value: decodeValue(valueJson) });
    }
    return new ORMap<K, V>(keyset, entries, identity);
  }

  equals(other: ORMap<K, V>): boolean {
    if (!this.keyset.equals(other.keyset)) return false;
    // Compare entries only for keys the keyset reports as live.  Stale
    // entries (kept around in `entries` to support associative merges)
    // are an implementation detail that mustn't leak into equality.
    for (const id of this.keyset.value()) {
      const a = this.entries.get(id);
      const b = other.entries.get(id);
      if (!a || !b) return a === b;
      if (typeof (a.value as { equals?: unknown }).equals === 'function') {
        if (!(a.value as unknown as { equals(o: V): boolean }).equals(b.value)) return false;
      } else if (JSON.stringify(a.value.toJSON()) !== JSON.stringify(b.value.toJSON())) {
        return false;
      }
    }
    return true;
  }
}

export interface ORMapJson {
  readonly kind: 'ORMap';
  readonly keyset: ORSetJson;
  /** Per-key inner-CRDT JSON.  Decoder supplied at fromJSON time. */
  readonly values: Record<string, unknown>;
  readonly keyValues?: Record<string, string>;
}
