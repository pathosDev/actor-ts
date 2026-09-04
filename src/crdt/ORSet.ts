import { TAG_ENTROPY_CHARACTERS } from './Constants.js';
import type { Crdt, CrdtIdentityFunction, ReplicaId } from './Crdt.js';
import { randomId } from '../util/RandomString.js';
import {
  assertPlainObject,
  assertStringArray,
  safeEntries,
} from './CrdtWireValidation.js';

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
 * with {@link TAG_ENTROPY_CHARACTERS} random hex characters, so a tag
 * is unique across calls in the same millisecond and — the part that
 * matters on an open wire — unguessable ahead of being issued.
 *
 * **Element identity**.  By default elements are deduplicated by
 * `JSON.stringify(element)` — same caveats as `GSet`: BigInt throws,
 * Map/Set silently over-deduplicate, Date round-trips lossily.  Pass
 * an `identity: (e) => string` option to override:
 *
 *   const cart = ORSet.empty<Item>({ identity: (i) => i.sku });
 */

export type ORSetOptions<E> = {
  /** Custom identity function — see class doc. */
  readonly identity?: (e: E) => string;
};

const defaultIdentity = (e: unknown): string => JSON.stringify(e);

type ElementEntry<E> = {
  readonly element: E;
  readonly tags: ReadonlySet<string>;
};

export class ORSet<E> implements Crdt<ORSet<E>> {
  /**
   * `elements`   — element-key (identity-function output) → entry holding
   *                the original element instance plus its current
   *                tag set.  Storing the element (not just its
   *                identity-string) lets `value()` return the
   *                original instances even when a custom identity
   *                callback is configured.
   * `tombstones` — tags removed for an element-key.  Veto on merge
   *                so a stale state from a slow peer can't resurrect
   *                an already-removed tag.
   */
  private constructor(
    private readonly elements: ReadonlyMap<string, ElementEntry<E>>,
    private readonly tombstones: ReadonlyMap<string, ReadonlySet<string>>,
    private readonly identity: (e: E) => string,
  ) {}

  static empty<E>(options: ORSetOptions<E> = {}): ORSet<E> {
    return new ORSet<E>(
      new Map(), new Map(),
      options.identity ?? (defaultIdentity as (e: E) => string),
    );
  }

  add(replica: ReplicaId, element: E): ORSet<E> {
    const key = this.identity(element);
    // Minted here and nowhere else: a tag has to survive merges and
    // serialization byte-identical, since every comparison it takes part in —
    // tombstone veto, tag-set union, `equals` — is string equality.
    //
    // Drawn against both halves of that comparison (#1146).  A repeat of a live
    // tag would union into the same set and lose nothing; a repeat of a
    // *tombstoned* one is the case worth the check, because the veto that stops
    // a slow peer resurrecting a removed tag cannot tell it apart from this
    // add — the element would simply fail to appear on the next merge, with no
    // error anywhere.  Both maps are already in hand, so the check is two
    // lookups against the 96 bits that make it near-impossible in the first
    // place.
    const tagPrefix = `${replica}#`;
    const liveTags = this.elements.get(key)?.tags;
    const removedTags = this.tombstones.get(key);
    const tag = tagPrefix + randomId(TAG_ENTROPY_CHARACTERS, (suffix) => {
      const candidate = tagPrefix + suffix;
      return liveTags?.has(candidate) === true || removedTags?.has(candidate) === true;
    });

    const nextElements = new Map(this.elements);
    const existing = nextElements.get(key);
    const tagsForKey = new Set(existing?.tags ?? []);
    tagsForKey.add(tag);
    nextElements.set(key, { element, tags: tagsForKey });

    return new ORSet<E>(nextElements, this.tombstones, this.identity);
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

    return new ORSet<E>(nextElements, nextTombstones, this.identity);
  }

  has(element: E): boolean {
    return (this.elements.get(this.identity(element))?.tags.size ?? 0) > 0;
  }

  /** @see {@link Crdt.customIdentity} */
  customIdentity(): CrdtIdentityFunction | undefined {
    return this.identity === defaultIdentity ? undefined : this.identity;
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

    // No third step: tags carry their own entropy, so nothing has to be
    // carried across a merge to keep the next-issued one fresh.
    return new ORSet<E>(mergedElements, mergedTombstones, this.identity);
  }

  toJSON(): ORSetJson {
    // Wire shape — each element is JSON-stringified verbatim so
    // the default round-trip works.  Custom identity does NOT
    // change the wire shape: callers must pass the same `identity`
    // option to `fromJSON` to reconstruct a set with the same
    // dedup rule.
    //
    // Built with `Object.fromEntries` rather than by assignment: an element
    // key is identity-function output, so a custom identity can produce the one
    // string an assignment cannot store — `__proto__` hits the inherited
    // setter and the entry never reaches the wire at all (#767).  Defining
    // the property keeps the encode honest; the decoder is what rejects it.
    return {
      kind: 'ORSet',
      elements: Object.fromEntries(
        Array.from(this.elements, ([key, entry]) => [key, Array.from(entry.tags)] as const),
      ),
      elementValues: Object.fromEntries(
        Array.from(this.elements, ([key, entry]) => [key, JSON.stringify(entry.element)] as const),
      ),
      tombstones: mapOfSetsToObject(this.tombstones),
    };
  }

  /**
   * Rebuild a set from its wire shape, **filed under the caller's identity
   * rather than the sender's**.
   *
   * The re-key is the substance of #766, and it is why forwarding an
   * `identity` option was not on its own enough to fix that issue.  Element
   * keys are identity-function output, so a frame from a peer on the default
   * identity carries `JSON.stringify` keys; filing them verbatim — which is
   * what this decoder used to do — left the custom identity governing only
   * *future* operations, and the element that arrived on the wire stayed a
   * separate entry from the one the application later added under the same
   * SKU.  `GSet.fromJSON` never had the bug because its wire shape is an
   * array and it has always had to compute `identity(element)` itself.
   *
   * Two consequences worth naming:
   *
   *   - Entries that collapse onto one key are **merged**, not overwritten —
   *     tag sets union, and the first element instance seen wins, matching
   *     what `add` does for a key already present.
   *   - The caller's `identity` now runs over **peer-supplied** values.  A
   *     callback that throws on an unexpected shape turns a hostile frame
   *     into a decode failure, which every wire call site already treats as
   *     "drop this value"; it is not a new escalation path, but an identity
   *     function that assumes its argument's shape will see data it did not
   *     produce.
   *
   * With no `identity` option the decode is byte-for-byte what it always was:
   * the re-key is skipped rather than run and found to be a no-op, so the
   * default path gains no `JSON.stringify` per element and no new throw site.
   */
  static fromJSON<E>(json: ORSetJson, options: ORSetOptions<E> = {}): ORSet<E> {
    if (json.kind !== 'ORSet') throw new Error(`ORSet.fromJSON: unexpected kind ${json.kind}`);
    const custom = options.identity;
    const identity = custom ?? (defaultIdentity as (e: E) => string);
    // Tombstones are honoured on merge, so an unvalidated set lets a peer
    // pre-tombstone tags a victim replica has not issued yet — its future
    // adds then vanish on the next merge, silently and permanently (#722).
    assertPlainObject(json.elements, 'ORSet.elements');
    assertPlainObject(json.tombstones, 'ORSet.tombstones');
    for (const [key, tags] of safeEntries(json.tombstones, 'ORSet.tombstones')) {
      assertStringArray(tags, `ORSet.tombstones['${key}']`);
    }
    const elements = new Map<string, ElementEntry<E>>();
    /** Wire element key → the key this replica files it under.  Empty unless re-keyed. */
    const localKeys = new Map<string, string>();
    for (const [wireKey, tags] of safeEntries(json.elements, 'ORSet.elements')) {
      assertStringArray(tags, `ORSet.elements['${wireKey}']`);
      // Backwards-compat: old wire shape didn't carry
      // `elementValues` — fall back to JSON.parse(key) which is
      // exactly the default-identity round-trip.
      const raw = json.elementValues?.[wireKey];
      const element: E = raw !== undefined
        ? (JSON.parse(raw) as E)
        : (JSON.parse(wireKey) as E);
      const key = custom === undefined ? wireKey : custom(element);
      if (key !== wireKey) localKeys.set(wireKey, key);
      const existing = elements.get(key);
      if (existing === undefined) {
        elements.set(key, { element, tags: new Set(tags) });
        continue;
      }
      const mergedTags = new Set(existing.tags);
      for (const tag of tags) mergedTags.add(tag);
      elements.set(key, { element: existing.element, tags: mergedTags });
    }
    return new ORSet<E>(elements, objectToMapOfSets(json.tombstones, localKeys), identity);
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
  // See `toJSON` — assignment would silently drop a `__proto__` element key.
  return Object.fromEntries(
    Array.from(map, ([key, tagSet]) => [key, Array.from(tagSet)] as const),
  );
}

/**
 * Decode the tombstone map, moving each bucket to the key its element now
 * lives under (`localKeys`, from the element re-key above).
 *
 * A bucket whose element is *not* in `localKeys` stays where it arrived, and
 * that covers two different cases.  The ordinary one is the default path,
 * where nothing was re-keyed at all and every bucket keeps its wire key.  The
 * one worth knowing about is an **orphan** bucket — an element removed and
 * never re-added, so the frame carries its tags but no instance to
 * re-identify from.  Its tags still veto anything that arrives under the same
 * key, which is every peer that shares the sender's identity; what they no
 * longer veto is the same element arriving from a peer whose identity differs
 * from the sender's, because the two now file it under different keys.  That
 * residual is confined to a cluster whose replicas disagree about the
 * identity for a key — the misconfiguration this decode exists to stop
 * happening by accident — and closing it properly means keying tombstones by
 * tag rather than by element, which is a wire change.
 */
function objectToMapOfSets(
  obj: Record<string, string[]>,
  localKeys: ReadonlyMap<string, string>,
): Map<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const [wireKey, tagArray] of Object.entries(obj)) {
    const key = localKeys.get(wireKey) ?? wireKey;
    const bucket = out.get(key);
    if (bucket === undefined) out.set(key, new Set(tagArray));
    else for (const tag of tagArray) bucket.add(tag);
  }
  return out;
}

/**
 * Wire shape.
 *
 * A `counters` field used to sit here, carrying the per-replica sequence the
 * old tags were minted from.  Tags no longer come off a counter, so it is gone
 * rather than kept empty — a field nothing maintains reads as state and is
 * one refactor away from being trusted again.  A frame from a pre-#722 peer
 * still carries it; it is simply not read.  The reverse does not hold: such a
 * peer requires the field and rejects a frame without it, which is what makes
 * this a breaking wire change rather than an additive one.
 */
export type ORSetJson = {
  readonly kind: 'ORSet';
  /** Per-element-key tag list. */
  readonly elements: Record<string, string[]>;
  /** Per-element-key JSON-stringified element value.  Optional for
   *  backwards-compat with v0 wire shape (default identity only). */
  readonly elementValues?: Record<string, string>;
  readonly tombstones: Record<string, string[]>;
};
