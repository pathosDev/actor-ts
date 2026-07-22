import type { Crdt, ReplicaId } from './Crdt.js';
import { GCounter, type GCounterJson } from './GCounter.js';

/**
 * Map of grow-only counters — `Map<K, GCounter>` with a CRDT merge
 * that takes the per-key max across replicas.  The natural fit for
 * "per-tag event count", "per-route hit counter", "per-user
 * impression count" — anything where you want a separate counter per
 * key but don't want to manage one CRDT per dimension by hand.
 *
 *   const m = GCounterMap.empty<string>()
 *     .increment('a', 'page-views', 5)
 *     .increment('a', 'clicks', 1);
 *   m.value('page-views')   // → 5
 *   m.total()                // → 6
 *
 * **Element identity.**  Same JSON-stringify default + `identity`
 * override pattern as `GSet` / `ORSet` — necessary when keys are
 * BigInt, Map, or other types that don't round-trip through
 * `JSON.stringify`.  See `GSet` for the failure modes.
 */

export interface GCounterMapOptions<K> {
  /** Custom identity for non-JSON-serialisable keys.  See class doc. */
  readonly identity?: (k: K) => string;
}

const defaultIdentity = (k: unknown): string => JSON.stringify(k);

export class GCounterMap<K> implements Crdt<GCounterMap<K>> {
  /**
   * `entries` is keyed by `identity(K)`; we store the original `K`
   * alongside the counter so `keys()` returns the user's instances
   * even when a custom identity is in use.
   */
  private constructor(
    private readonly entries: ReadonlyMap<string, { readonly key: K; readonly counter: GCounter }>,
    private readonly identity: (k: K) => string,
  ) {}

  static empty<K>(options: GCounterMapOptions<K> = {}): GCounterMap<K> {
    return new GCounterMap<K>(
      new Map(),
      options.identity ?? (defaultIdentity as (k: K) => string),
    );
  }

  /** Bump the counter under `key` by `delta` (default 1) on `replica`. */
  increment(replica: ReplicaId, key: K, delta: number = 1): GCounterMap<K> {
    if (delta < 0) throw new Error(`GCounterMap.increment requires delta >= 0, got ${delta}`);
    if (!Number.isFinite(delta)) throw new Error('GCounterMap.increment requires ours finite delta');
    const id = this.identity(key);
    const next = new Map(this.entries);
    const existing = next.get(id);
    const counter = (existing?.counter ?? GCounter.empty()).increment(replica, delta);
    next.set(id, { key: existing?.key ?? key, counter });
    return new GCounterMap<K>(next, this.identity);
  }

  /** Read the counter under `key`, or `0` if it doesn't exist. */
  value(key: K): number {
    return this.entries.get(this.identity(key))?.counter.value() ?? 0;
  }

  /** Sum across every key. */
  total(): number {
    let total = 0;
    for (const { counter } of this.entries.values()) total += counter.value();
    return total;
  }

  /** Snapshot of all keys currently tracked. */
  keys(): ReadonlyArray<K> {
    return Array.from(this.entries.values(), (e) => e.key);
  }

  /** Snapshot of `[key, value]` pairs. */
  pairs(): ReadonlyArray<readonly [K, number]> {
    return Array.from(this.entries.values(), (e) => [e.key, e.counter.value()] as const);
  }

  has(key: K): boolean { return this.entries.has(this.identity(key)); }

  get size(): number { return this.entries.size; }

  merge(other: GCounterMap<K>): GCounterMap<K> {
    const next = new Map(this.entries);
    for (const [id, entry] of other.entries) {
      const ours = next.get(id);
      if (!ours) { next.set(id, entry); continue; }
      next.set(id, {
        key: ours.key,
        counter: ours.counter.merge(entry.counter),
      });
    }
    return new GCounterMap<K>(next, this.identity);
  }

  toJSON(): GCounterMapJson {
    const counters: Record<string, GCounterJson> = {};
    const keyValues: Record<string, string> = {};
    for (const [id, entry] of this.entries) {
      counters[id] = entry.counter.toJSON();
      keyValues[id] = JSON.stringify(entry.key);
    }
    return { kind: 'GCounterMap', counters, keyValues };
  }

  static fromJSON<K>(
    json: GCounterMapJson, options: GCounterMapOptions<K> = {},
  ): GCounterMap<K> {
    if (json.kind !== 'GCounterMap') {
      throw new Error(`GCounterMap.fromJSON: unexpected kind ${json.kind}`);
    }
    const identity = options.identity ?? (defaultIdentity as (k: K) => string);
    const entries = new Map<string, { key: K; counter: GCounter }>();
    for (const [id, counterJson] of Object.entries(json.counters)) {
      const raw = json.keyValues?.[id];
      const key = raw !== undefined ? (JSON.parse(raw) as K) : (JSON.parse(id) as K);
      entries.set(id, { key, counter: GCounter.fromJSON(counterJson) });
    }
    return new GCounterMap<K>(entries, identity);
  }

  equals(other: GCounterMap<K>): boolean {
    if (this.entries.size !== other.entries.size) return false;
    for (const [id, entry] of this.entries) {
      const otherEntry = other.entries.get(id);
      if (!otherEntry) return false;
      if (!entry.counter.equals(otherEntry.counter)) return false;
    }
    return true;
  }
}

export interface GCounterMapJson {
  readonly kind: 'GCounterMap';
  /** Per-key counter state, keyed by identity-fn output. */
  readonly counters: Record<string, GCounterJson>;
  /** Per-key JSON-stringified original key.  Optional for backwards
   *  compat — when missing, `JSON.parse(identity-string)` is used. */
  readonly keyValues?: Record<string, string>;
}
