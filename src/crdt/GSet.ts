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
 * The element type must be JSON-serializable; equality is by JSON
 * representation (so element objects with the same shape are
 * deduped).
 */
export class GSet<E> implements Crdt<GSet<E>> {
  private constructor(private readonly elements: ReadonlySet<string>) {}

  static empty<E>(): GSet<E> { return new GSet<E>(new Set()); }

  add(element: E): GSet<E> {
    const key = JSON.stringify(element);
    if (this.elements.has(key)) return this;
    const next = new Set(this.elements);
    next.add(key);
    return new GSet<E>(next);
  }

  has(element: E): boolean {
    return this.elements.has(JSON.stringify(element));
  }

  /** Snapshot of every element currently in the set. */
  value(): ReadonlyArray<E> {
    return Array.from(this.elements, (k) => JSON.parse(k) as E);
  }

  get size(): number { return this.elements.size; }

  merge(other: GSet<E>): GSet<E> {
    if (other.elements.size === 0) return this;
    if (this.elements.size === 0) return other;
    const next = new Set(this.elements);
    for (const k of other.elements) next.add(k);
    return new GSet<E>(next);
  }

  toJSON(): GSetJson {
    return { kind: 'GSet', elements: Array.from(this.elements) };
  }

  static fromJSON<E>(json: GSetJson): GSet<E> {
    if (json.kind !== 'GSet') throw new Error(`GSet.fromJSON: unexpected kind ${json.kind}`);
    return new GSet<E>(new Set(json.elements));
  }

  equals(other: GSet<E>): boolean {
    if (this.elements.size !== other.elements.size) return false;
    for (const k of this.elements) if (!other.elements.has(k)) return false;
    return true;
  }
}

export interface GSetJson {
  readonly kind: 'GSet';
  readonly elements: ReadonlyArray<string>;
}
