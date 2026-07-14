import type { Crdt } from './Crdt.js';

/**
 * Grow-only set.  Adds win unconditionally; removes are not supported.
 * The simplest set CRDT — `merge` is just set union, which is
 * idempotent / commutative / associative for free.
 *
 * Use this when **elements are never removed** — observed visitors,
 * unique log lines, "URLs we've ever crawled".  For sets that need
 * removal use {@link ORSet}.
 *
 * **Element identity**.  By default the set uses
 * `JSON.stringify(element)` as the dedup key — so two structurally-
 * equal plain-JSON values (numbers, strings, plain objects, arrays)
 * deduplicate correctly.  Three failure modes for non-JSON values:
 *
 *   - **`BigInt`** — `JSON.stringify(42n)` THROWS, so `add(42n)`
 *     propagates the throw to the caller.
 *   - **`Map` / `Set`** — `JSON.stringify(new Map([[ 'a', 1 ]]))`
 *     returns `"{}"`, so different Maps deduplicate as if they were
 *     all the same element.
 *   - **`Date`** — round-trips to an ISO string, dedupes correctly,
 *     but `value()` returns a string rather than a Date instance.
 *
 * For non-JSON values, pass an `identity` callback to
 * `GSet.empty({ identity: (e) => e.someStableKey })`.  The callback
 * is consulted on every add / has / merge.  Wire shape (`toJSON`)
 * still requires elements to be JSON-serialisable — custom identity
 * fixes dedup, not persistence.
 */

export interface GSetOptions<E> {
  /** Custom identity function — see class doc. */
  readonly identity?: (e: E) => string;
}

const defaultIdentity = (e: unknown): string => JSON.stringify(e);

export class GSet<E> implements Crdt<GSet<E>> {
  private constructor(
    /** Map<identityKey, element>.  Storing the element (not just the
     *  key) so `value()` returns the original instance even when a
     *  custom identity callback is in use. */
    private readonly elements: ReadonlyMap<string, E>,
    private readonly identity: (e: E) => string,
  ) {}

  static empty<E>(opts: GSetOptions<E> = {}): GSet<E> {
    return new GSet<E>(new Map(), opts.identity ?? (defaultIdentity as (e: E) => string));
  }

  add(element: E): GSet<E> {
    const key = this.identity(element);
    if (this.elements.has(key)) return this;
    const next = new Map(this.elements);
    next.set(key, element);
    return new GSet<E>(next, this.identity);
  }

  has(element: E): boolean {
    return this.elements.has(this.identity(element));
  }

  /** Snapshot of every element currently in the set. */
  value(): ReadonlyArray<E> {
    return Array.from(this.elements.values());
  }

  get size(): number { return this.elements.size; }

  merge(other: GSet<E>): GSet<E> {
    if (other.elements.size === 0) return this;
    if (this.elements.size === 0) return other;
    const next = new Map(this.elements);
    for (const [key, element] of other.elements) {
      if (!next.has(key)) next.set(key, element);
    }
    return new GSet<E>(next, this.identity);
  }

  /**
   * Wire shape: array of JSON-stringified elements.  Custom identity
   * is NOT serialised — `fromJSON` callers must pass the matching
   * `identity` option to reconstruct a set with the same dedup rule.
   * For default identity the JSON-string IS the identity key, so a
   * round-trip produces the same internal state.
   */
  toJSON(): GSetJson {
    return {
      kind: 'GSet',
      elements: Array.from(this.elements.values(), (e) => JSON.stringify(e)),
    };
  }

  static fromJSON<E>(json: GSetJson, opts: GSetOptions<E> = {}): GSet<E> {
    if (json.kind !== 'GSet') throw new Error(`GSet.fromJSON: unexpected kind ${json.kind}`);
    const identity = opts.identity ?? (defaultIdentity as (e: E) => string);
    const map = new Map<string, E>();
    for (const serialized of json.elements) {
      const element = JSON.parse(serialized) as E;
      map.set(identity(element), element);
    }
    return new GSet<E>(map, identity);
  }

  equals(other: GSet<E>): boolean {
    if (this.elements.size !== other.elements.size) return false;
    for (const key of this.elements.keys()) if (!other.elements.has(key)) return false;
    return true;
  }
}

export interface GSetJson {
  readonly kind: 'GSet';
  readonly elements: ReadonlyArray<string>;
}
