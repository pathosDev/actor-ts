import type { Crdt, CrdtIdentityFunction, ReplicaId } from './Crdt.js';
import { assertPlainObject, safeEntries } from './CrdtWireValidation.js';
import { ORSet, type ORSetJson } from './ORSet.js';

/**
 * Observed-Remove map, where each **value** is itself a CRDT.  Keys
 * follow OR-Set add-wins semantics; values merge per-key via their
 * own `merge`.  The natural fit when you want a logical map and each
 * cell needs its own conflict-free type — e.g. carts where every
 * cart is itself an `ORSet` of items, or per-tenant options where
 * each tenant's options is an `LWWMap`.
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

export type ORMapOptions<K> = {
  readonly identity?: (k: K) => string;
};

const defaultIdentity = (k: unknown): string => JSON.stringify(k);

type Entry<K, V extends Crdt<V>> = {
  readonly key: K;
  readonly value: V;
};

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

  static empty<K, V extends Crdt<V>>(options: ORMapOptions<K> = {}): ORMap<K, V> {
    return new ORMap<K, V>(
      ORSet.empty<string>(),
      new Map(),
      options.identity ?? (defaultIdentity as (k: K) => string),
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
   * empty CRDT.  Equivalent to `put(replica, key, mutator(get(key) ?? factory()))`
   * but with a single re-tag, so concurrent `update` + `remove`
   * resolves the same as concurrent `put` + `remove` would.
   */
  update(
    replica: ReplicaId, key: K,
    factory: () => V, mutator: (current: V) => V,
  ): ORMap<K, V> {
    const current = this.get(key) ?? factory();
    return this.put(replica, key, mutator(current));
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

  /** @see {@link Crdt.customIdentity} */
  customIdentity(): CrdtIdentityFunction | undefined {
    return this.identity === defaultIdentity ? undefined : this.identity;
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
    let count = 0;
    for (const id of this.entries.keys()) if (this.keyset.has(id)) count++;
    return count;
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
      const ours = this.entries.get(id);
      const theirs = other.entries.get(id);
      if (ours && theirs) {
        mergedEntries.set(id, { key: ours.key, value: ours.value.merge(theirs.value) });
      } else if (ours) {
        mergedEntries.set(id, ours);
      } else if (theirs) {
        mergedEntries.set(id, theirs);
      }
    }
    return new ORMap<K, V>(mergedKeyset, mergedEntries, this.identity);
  }

  toJSON(): ORMapJson {
    // Each value is a CRDT — its toJSON is the standard discriminated shape.
    //
    // `Object.fromEntries`, not assignment: entry ids are identity-function output,
    // so a custom identity can yield `__proto__`, and an assignment hands that
    // to the inherited setter instead of storing it — the entry silently never
    // reaches a peer or the durable record (#767).
    return {
      kind: 'ORMap',
      keyset: this.keyset.toJSON(),
      values: Object.fromEntries(
        Array.from(this.entries, ([id, entry]) => [id, entry.value.toJSON()] as const),
      ),
      keyValues: Object.fromEntries(
        Array.from(this.entries, ([id, entry]) => [id, JSON.stringify(entry.key)] as const),
      ),
    };
  }

  /**
   * Reconstruct an ORMap.  `decodeValue` must build the inner CRDT
   * from its JSON shape — typically `(json) => SomeCrdt.fromJSON(json)`.
   * The `DistributedData` extension provides a `decodeCrdt` that
   * dispatches across every registered CRDT kind.
   *
   * **Re-keying.**  As in `ORSet.fromJSON`, a custom `identity` files every
   * entry under the key *this* replica would have chosen rather than the one
   * the sender wrote, and ids that collapse merge their inner CRDTs (#766).
   * An ORMap has a second index to keep in step: `keyset` is an
   * `ORSet<string>` whose *elements are the entry ids*, so re-keying `entries`
   * without it would leave `get`/`has`/`keys` consulting a membership set
   * filed under ids that no longer exist.  {@link remapKeysetIds} rewrites
   * the ids inside the keyset frame and hands the result to `ORSet.fromJSON`
   * with an explicit identity, so the keyset's own re-key does the rest —
   * including unioning the tag sets of two ids that collapse and carrying
   * their tombstones across.
   *
   * **Not covered:** the identity of a *nested* value.  `decodeValue` sees
   * only the inner frame, and an empty template has no inner instance to read
   * an identity from, so an `ORMap` of `ORSet`s recovers the outer key
   * identity and leaves each inner set on the default.
   */
  static fromJSON<K, V extends Crdt<V>>(
    json: ORMapJson,
    decodeValue: (json: unknown) => V,
    options: ORMapOptions<K> = {},
  ): ORMap<K, V> {
    if (json.kind !== 'ORMap') {
      throw new Error(`ORMap.fromJSON: unexpected kind ${json.kind}`);
    }
    const custom = options.identity;
    const identity = custom ?? (defaultIdentity as (k: K) => string);
    assertPlainObject(json.values, 'ORMap.values');
    const entries = new Map<string, Entry<K, V>>();
    /** Wire entry id → the id this replica files it under.  Empty unless re-keyed. */
    const localIds = new Map<string, string>();
    // `safeEntries` rather than `Object.entries`: this decoder is a peer-facing
    // boundary like the keyset's, and was missing both of its guards — the
    // entry ceiling and the `__proto__` rejection (#698, #767).
    for (const [wireId, valueJson] of safeEntries(json.values, 'ORMap.values')) {
      const raw = json.keyValues?.[wireId];
      const key = raw !== undefined ? (JSON.parse(raw) as K) : (JSON.parse(wireId) as K);
      const value = decodeValue(valueJson);
      const id = custom === undefined ? wireId : custom(key);
      if (id !== wireId) localIds.set(wireId, id);
      const existing = entries.get(id);
      entries.set(id, existing === undefined
        ? { key, value }
        : { key: existing.key, value: existing.value.merge(value) });
    }
    const keyset = localIds.size === 0
      ? ORSet.fromJSON<string>(json.keyset)
      : ORSet.fromJSON<string>(remapKeysetIds(json.keyset, localIds), { identity: keysetIdentity });
    return new ORMap<K, V>(keyset, entries, identity);
  }

  equals(other: ORMap<K, V>): boolean {
    if (!this.keyset.equals(other.keyset)) return false;
    // Compare entries only for keys the keyset reports as live.  Stale
    // entries (kept around in `entries` to support associative merges)
    // are an implementation detail that mustn't leak into equality.
    for (const id of this.keyset.value()) {
      const ours = this.entries.get(id);
      const theirs = other.entries.get(id);
      if (!ours || !theirs) return ours === theirs;
      if (typeof (ours.value as { equals?: unknown }).equals === 'function') {
        if (!(ours.value as unknown as { equals(otherEntry: V): boolean }).equals(theirs.value)) return false;
      } else if (JSON.stringify(ours.value.toJSON()) !== JSON.stringify(theirs.value.toJSON())) {
        return false;
      }
    }
    return true;
  }
}

/**
 * The keyset's own identity, spelled out rather than left implicit.
 *
 * `keyset` is an `ORSet<string>` on the default identity, which for a string
 * `s` is exactly `JSON.stringify(s)` — so passing this changes nothing about
 * *which* key an element lands under.  What it changes is that `ORSet`'s
 * re-key path runs at all: that path is what reads each element back out of
 * `elementValues`, and {@link remapKeysetIds} has just rewritten those to the
 * local ids.
 */
const keysetIdentity = (id: string): string => JSON.stringify(id);

/**
 * Rewrite a keyset frame so its elements are *this* replica's entry ids.
 *
 * Only `elementValues` is touched, and that is the whole trick: the element
 * keys and the tombstone keys are left exactly as they arrived, so `ORSet`'s
 * decode sees a set whose elements have moved and re-files them itself —
 * unioning the tags of two ids that collapse onto one, and carrying each
 * tombstone bucket along with the element it belongs to.  Doing it here
 * instead would mean a second implementation of both.
 *
 * `elementValues` is written for every element key rather than patched,
 * because a frame from a pre-`elementValues` peer has none and `ORSet` would
 * then fall back to parsing the element key — which is the wire id, not the
 * local one.  A key that does not decode to a string is left alone; `ORSet`
 * validates the frame properly a moment later and reports it in its own
 * words.
 */
function remapKeysetIds(keyset: ORSetJson, localIds: ReadonlyMap<string, string>): ORSetJson {
  const elements: unknown = keyset?.elements;
  if (typeof elements !== 'object' || elements === null || Array.isArray(elements)) return keyset;
  const elementValues = Object.fromEntries(
    Object.keys(elements).map((elementKey) => {
      const encoded = keyset.elementValues?.[elementKey] ?? elementKey;
      const wireId = parseIdString(encoded);
      const localId = wireId === undefined ? undefined : localIds.get(wireId);
      return [elementKey, localId === undefined ? encoded : JSON.stringify(localId)] as const;
    }),
  );
  return { ...keyset, elementValues };
}

/** `JSON.parse` narrowed to strings — `undefined` for anything else, a failed parse included. */
function parseIdString(encoded: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(encoded);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export type ORMapJson = {
  readonly kind: 'ORMap';
  readonly keyset: ORSetJson;
  /** Per-key inner-CRDT JSON.  Decoder supplied at fromJSON time. */
  readonly values: Record<string, unknown>;
  readonly keyValues?: Record<string, string>;
};
