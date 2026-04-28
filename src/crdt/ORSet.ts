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
 */
export class ORSet<E> implements Crdt<ORSet<E>> {
  /**
   * `elements`   — element-key (JSON of E) → set of tag strings.
   * `tombstones` — tags removed for an element-key.  Used as a
   *                veto on merge so a re-replicated state from a
   *                slow peer can't resurrect an already-removed tag.
   *                NOT identical to "elements with no current tags";
   *                we use it specifically for the merge-side check.
   * `counters`   — per-replica monotonic seq used to mint fresh tags.
   */
  private constructor(
    private readonly elements: ReadonlyMap<string, ReadonlySet<string>>,
    private readonly tombstones: ReadonlyMap<string, ReadonlySet<string>>,
    private readonly counters: ReadonlyMap<ReplicaId, number>,
  ) {}

  static empty<E>(): ORSet<E> {
    return new ORSet<E>(new Map(), new Map(), new Map());
  }

  add(replica: ReplicaId, element: E): ORSet<E> {
    const key = JSON.stringify(element);
    const seq = (this.counters.get(replica) ?? 0) + 1;
    const tag = `${replica}#${seq}`;

    const nextElements = new Map(this.elements);
    const tagsForKey = new Set(nextElements.get(key) ?? []);
    tagsForKey.add(tag);
    nextElements.set(key, tagsForKey);

    const nextCounters = new Map(this.counters);
    nextCounters.set(replica, seq);

    return new ORSet<E>(nextElements, this.tombstones, nextCounters);
  }

  /**
   * Remove every tag currently present for `element`.  Concurrent
   * adds carrying tags this replica hasn't observed survive the
   * merge — that's the OR-Set "add wins" property.
   */
  remove(element: E): ORSet<E> {
    const key = JSON.stringify(element);
    const tagsForKey = this.elements.get(key);
    if (!tagsForKey || tagsForKey.size === 0) return this;

    const nextElements = new Map(this.elements);
    nextElements.delete(key);

    const nextTombstones = new Map(this.tombstones);
    const t = new Set(nextTombstones.get(key) ?? []);
    for (const tag of tagsForKey) t.add(tag);
    nextTombstones.set(key, t);

    return new ORSet<E>(nextElements, nextTombstones, this.counters);
  }

  has(element: E): boolean {
    return (this.elements.get(JSON.stringify(element))?.size ?? 0) > 0;
  }

  value(): ReadonlyArray<E> {
    const out: E[] = [];
    for (const [key, tags] of this.elements) {
      if (tags.size > 0) out.push(JSON.parse(key) as E);
    }
    return out;
  }

  get size(): number {
    let count = 0;
    for (const tags of this.elements.values()) if (tags.size > 0) count++;
    return count;
  }

  merge(other: ORSet<E>): ORSet<E> {
    // 1. Tombstones are unioned — once removed, always removed.
    const mergedTombstones = unionMapOfSets(this.tombstones, other.tombstones);

    // 2. Elements are unioned per-key, then any tag also in the
    //    merged tombstones is filtered out.  Empty entries are
    //    dropped so `has` / `value` reflect cleanly.
    const allKeys = new Set<string>([...this.elements.keys(), ...other.elements.keys()]);
    const mergedElements = new Map<string, ReadonlySet<string>>();
    for (const key of allKeys) {
      const a = this.elements.get(key) ?? EMPTY_SET;
      const b = other.elements.get(key) ?? EMPTY_SET;
      const tomb = mergedTombstones.get(key) ?? EMPTY_SET;
      const merged = new Set<string>();
      for (const t of a) if (!tomb.has(t)) merged.add(t);
      for (const t of b) if (!tomb.has(t)) merged.add(t);
      if (merged.size > 0) mergedElements.set(key, merged);
    }

    // 3. Counters: per-replica max so the next-issued tag is fresh
    //    no matter which replica the merged state is used on.
    const mergedCounters = new Map(this.counters);
    for (const [replica, seq] of other.counters) {
      const ours = mergedCounters.get(replica) ?? 0;
      if (seq > ours) mergedCounters.set(replica, seq);
    }

    return new ORSet<E>(mergedElements, mergedTombstones, mergedCounters);
  }

  toJSON(): ORSetJson {
    return {
      kind: 'ORSet',
      elements: mapOfSetsToObject(this.elements),
      tombstones: mapOfSetsToObject(this.tombstones),
      counters: Object.fromEntries(this.counters),
    };
  }

  static fromJSON<E>(json: ORSetJson): ORSet<E> {
    if (json.kind !== 'ORSet') throw new Error(`ORSet.fromJSON: unexpected kind ${json.kind}`);
    return new ORSet<E>(
      objectToMapOfSets(json.elements),
      objectToMapOfSets(json.tombstones),
      new Map(Object.entries(json.counters)),
    );
  }

  equals(other: ORSet<E>): boolean {
    return mapOfSetsEqual(this.elements, other.elements)
      && mapOfSetsEqual(this.tombstones, other.tombstones);
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function unionMapOfSets(
  a: ReadonlyMap<string, ReadonlySet<string>>,
  b: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const merged = new Set<string>(a.get(k) ?? []);
    for (const v of (b.get(k) ?? [])) merged.add(v);
    if (merged.size > 0) out.set(k, merged);
  }
  return out;
}

function mapOfSetsEqual(
  a: ReadonlyMap<string, ReadonlySet<string>>,
  b: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb || vb.size !== va.size) return false;
    for (const t of va) if (!vb.has(t)) return false;
  }
  return true;
}

function mapOfSetsToObject(
  m: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of m) out[k] = Array.from(v);
  return out;
}

function objectToMapOfSets(
  obj: Record<string, string[]>,
): Map<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [k, v] of Object.entries(obj)) out.set(k, new Set(v));
  return out;
}

export interface ORSetJson {
  readonly kind: 'ORSet';
  readonly elements: Record<string, string[]>;
  readonly tombstones: Record<string, string[]>;
  readonly counters: Record<ReplicaId, number>;
}
