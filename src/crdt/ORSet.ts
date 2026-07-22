import type { Crdt, ReplicaId } from './Crdt.js';

/**
 * Observed-Remove Set.  Like a regular set with `add` / `remove` —
 * but with a twist that makes concurrent ops converge: every `add`
 * stamps the element with a **unique tag**, and `remove(e)` removes
 * **only the tags currently present at the removing replica**.
 *
 * Why that matters: if replica A removes `e` while replica B
 * concurrently adds a fresh `e`, B's add carries a tag A never saw,
 * so the merged result still contains `e`.  This is the "add wins"
 * semantics that makes OR-Set a popular choice for shopping carts,
 * presence sets, etc.
 *
 *   // Concurrent add (B) and remove (A)
 *   const a0 = ORSet.empty<string>().add('node-a', 'apple');
 *   const b0 = a0;                                  // both replicas see one entry
 *   const a1 = a0.remove('apple');                  // A removes
 *   const b1 = b0.add('node-b', 'apple');           // B re-adds with a fresh tag
 *   a1.merge(b1).value()                            // → ['apple'] (add wins)
 *
 * **Tag generation**: each add takes a `replicaId` and combines it
 * with a per-replica monotonic counter so tags are unique even
 * across calls in the same millisecond.  The counter is part of the
 * CRDT state; we keep one counter per replica and bump it on every add.
 *
 * **Element identity**.  By default elements are deduplicated by
 * `JSON.stringify(element)` — same caveats as `GSet`: BigInt throws,
 * Map/Set silently over-deduplicate, Date round-trips lossily.  Pass
 * an `identity: (e) => string` option to override:
 *
 *   const cart = ORSet.empty<Item>({ identity: (i) => i.sku });
 */

export interface ORSetOptions<E> {
  /** Custom identity function — see class doc. */
  readonly identity?: (e: E) => string;
}

const defaultIdentity = (e: unknown): string => JSON.stringify(e);

interface ElementEntry<E> {
  readonly element: E;
  readonly tags: ReadonlySet<string>;
}

export class ORSet<E> implements Crdt<ORSet<E>> {
  /**
   * `elements`   — element-key (identity-fn output) → entry holding
   *                the original element instance plus its current
   *                tag set.  Storing the element (not just its
   *                identity-string) lets `value()` return the
   *                original instances even when a custom identity
   *                callback is configured.
   * `tombstones` — tags removed for an element-key.  Veto on merge
   *                so a stale state from a slow peer can't resurrect
   *                an already-removed tag.
   * `counters`   — per-replica monotonic seq used to mint fresh tags.
   */
  private constructor(
    private readonly elements: ReadonlyMap<string, ElementEntry<E>>,
    private readonly tombstones: ReadonlyMap<string, ReadonlySet<string>>,
    private readonly counters: ReadonlyMap<ReplicaId, number>,
    private readonly identity: (e: E) => string,
  ) {}

  static empty<E>(options: ORSetOptions<E> = {}): ORSet<E> {
    return new ORSet<E>(
      new Map(), new Map(), new Map(),
      options.identity ?? (defaultIdentity as (e: E) => string),
    );
  }

  add(replica: ReplicaId, element: E): ORSet<E> {
    const key = this.identity(element);
    const seq = (this.counters.get(replica) ?? 0) + 1;
    const tag = `${replica}#${seq}`;

    const nextElements = new Map(this.elements);
    const existing = nextElements.get(key);
    const tagsForKey = new Set(existing?.tags ?? []);
    tagsForKey.add(tag);
    nextElements.set(key, { element, tags: tagsForKey });

    const nextCounters = new Map(this.counters);
    nextCounters.set(replica, seq);

    return new ORSet<E>(nextElements, this.tombstones, nextCounters, this.identity);
  }

  /**
   * Remove every tag currently present for `element`.  Concurrent
   * adds carrying tags this replica hasn't observed survive the
   * merge — that's the OR-Set "add wins" property.
   */
  remove(element: E): ORSet<E> {
    const key = this.identity(element);
    const existing = this.elements.get(key);
    if (!existing || existing.tags.size === 0) return this;

    const nextElements = new Map(this.elements);
    nextElements.delete(key);

    const nextTombstones = new Map(this.tombstones);
    const tombstoneTags = new Set(nextTombstones.get(key) ?? []);
    for (const tag of existing.tags) tombstoneTags.add(tag);
    nextTombstones.set(key, tombstoneTags);

    return new ORSet<E>(nextElements, nextTombstones, this.counters, this.identity);
  }

  has(element: E): boolean {
    return (this.elements.get(this.identity(element))?.tags.size ?? 0) > 0;
  }

  value(): ReadonlyArray<E> {
    const out: E[] = [];
    for (const entry of this.elements.values()) {
      if (entry.tags.size > 0) out.push(entry.element);
    }
    return out;
  }

  get size(): number {
    let count = 0;
    for (const entry of this.elements.values()) if (entry.tags.size > 0) count++;
    return count;
  }

  merge(other: ORSet<E>): ORSet<E> {
    // 1. Tombstones are unioned — once removed, always removed.
    const mergedTombstones = unionMapOfSets(this.tombstones, other.tombstones);

    // 2. Elements are merged per-key: union the tag sets, drop any
    //    tag that appears in the merged tombstones, then drop empty
    //    entries so `has` / `value` reflect cleanly.
    const allKeys = new Set<string>([...this.elements.keys(), ...other.elements.keys()]);
    const mergedElements = new Map<string, ElementEntry<E>>();
    for (const key of allKeys) {
      const ours = this.elements.get(key);
      const theirs = other.elements.get(key);
      const tomb = mergedTombstones.get(key) ?? EMPTY_SET;
      const merged = new Set<string>();
      if (ours) for (const tag of ours.tags) if (!tomb.has(tag)) merged.add(tag);
      if (theirs) for (const tag of theirs.tags) if (!tomb.has(tag)) merged.add(tag);
      if (merged.size > 0) {
        // Prefer the locally-known element; fall back to the peer's.
        const element = ours?.element ?? theirs?.element as E;
        mergedElements.set(key, { element, tags: merged });
      }
    }

    // 3. Counters: per-replica max so the next-issued tag is fresh
    //    no matter which replica the merged state is used on.
    const mergedCounters = new Map(this.counters);
    for (const [replica, seq] of other.counters) {
      const ours = mergedCounters.get(replica) ?? 0;
      if (seq > ours) mergedCounters.set(replica, seq);
    }

    return new ORSet<E>(mergedElements, mergedTombstones, mergedCounters, this.identity);
  }

  toJSON(): ORSetJson {
    // Wire shape — each element is JSON-stringified verbatim so
    // the default round-trip works.  Custom identity does NOT
    // change the wire shape: callers must pass the same `identity`
    // option to `fromJSON` to reconstruct a set with the same
    // dedup rule.
    const elements: Record<string, string[]> = {};
    const elementValues: Record<string, string> = {};
    for (const [key, entry] of this.elements) {
      elements[key] = Array.from(entry.tags);
      elementValues[key] = JSON.stringify(entry.element);
    }
    return {
      kind: 'ORSet',
      elements,
      elementValues,
      tombstones: mapOfSetsToObject(this.tombstones),
      counters: Object.fromEntries(this.counters),
    };
  }

  static fromJSON<E>(json: ORSetJson, options: ORSetOptions<E> = {}): ORSet<E> {
    if (json.kind !== 'ORSet') throw new Error(`ORSet.fromJSON: unexpected kind ${json.kind}`);
    const identity = options.identity ?? (defaultIdentity as (e: E) => string);
    const elements = new Map<string, ElementEntry<E>>();
    for (const [key, tags] of Object.entries(json.elements)) {
      // Backwards-compat: old wire shape didn't carry
      // `elementValues` — fall back to JSON.parse(key) which is
      // exactly the default-identity round-trip.
      const raw = json.elementValues?.[key];
      const element: E = raw !== undefined
        ? (JSON.parse(raw) as E)
        : (JSON.parse(key) as E);
      elements.set(key, { element, tags: new Set(tags) });
    }
    return new ORSet<E>(
      elements,
      objectToMapOfSets(json.tombstones),
      new Map(Object.entries(json.counters)),
      identity,
    );
  }

  equals(other: ORSet<E>): boolean {
    if (this.elements.size !== other.elements.size) return false;
    for (const [key, entry] of this.elements) {
      const otherEntry = other.elements.get(key);
      if (!otherEntry) return false;
      if (entry.tags.size !== otherEntry.tags.size) return false;
      for (const tag of entry.tags) if (!otherEntry.tags.has(tag)) return false;
    }
    return mapOfSetsEqual(this.tombstones, other.tombstones);
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function unionMapOfSets(
  ours: ReadonlyMap<string, ReadonlySet<string>>,
  theirs: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  const keys = new Set<string>([...ours.keys(), ...theirs.keys()]);
  for (const key of keys) {
    const merged = new Set<string>(ours.get(key) ?? []);
    for (const tag of (theirs.get(key) ?? [])) merged.add(tag);
    if (merged.size > 0) out.set(key, merged);
  }
  return out;
}

function mapOfSetsEqual(
  ours: ReadonlyMap<string, ReadonlySet<string>>,
  theirs: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (ours.size !== theirs.size) return false;
  for (const [key, va] of ours) {
    const vb = theirs.get(key);
    if (!vb || vb.size !== va.size) return false;
    for (const tag of va) if (!vb.has(tag)) return false;
  }
  return true;
}

function mapOfSetsToObject(
  map: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, tagSet] of map) out[key] = Array.from(tagSet);
  return out;
}

function objectToMapOfSets(
  obj: Record<string, string[]>,
): Map<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [key, tagArray] of Object.entries(obj)) out.set(key, new Set(tagArray));
  return out;
}

export interface ORSetJson {
  readonly kind: 'ORSet';
  /** Per-element-key tag list. */
  readonly elements: Record<string, string[]>;
  /** Per-element-key JSON-stringified element value.  Optional for
   *  backwards-compat with v0 wire shape (default identity only). */
  readonly elementValues?: Record<string, string>;
  readonly tombstones: Record<string, string[]>;
  readonly counters: Record<ReplicaId, number>;
}
