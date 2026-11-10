import type { Crdt, CrdtIdentityFunction, ReplicaId } from './Crdt.js';
import { assertPlainObject, safeEntries } from './CrdtWireValidation.js';
import { LWWRegister, type LWWRegisterJson } from './LWWRegister.js';

/**
 * Map of last-writer-wins registers.  Each entry carries its own
 * `(value, timestamp, replicaId)` tuple, and per-key conflict
 * resolution is identical to {@link LWWRegister}: higher timestamp
 * wins, ties broken by replica id.
 *
 * Pattern fits: per-key feature flags, per-user options, profile
 * fields where one writer at a time is normal but eventual
 * consistency across replicas matters.
 *
 *   const m = LWWMap.empty<string, string>()
 *     .put('a', 'theme', 'dark', 100)
 *     .put('b', 'theme', 'light', 200);     // newer wins
 *   m.get('theme')                             // → 'light'
 *
 * **Removal** is implemented as a tombstone — `remove(replica, key,
 * timestamp)` writes a `null`-valued register at the given timestamp.
 * On merge, a newer tombstone wins over an older value (key
 * disappears) and a newer value wins over an older tombstone (key
 * reappears).  `get()` returns `undefined` for tombstoned keys.
 *
 * **Wall-clock pitfall.**  Default timestamp is `Date.now()` — see
 * `LWWRegister`'s class doc for the standard caveats.  Pass an
 * explicit `timestamp` for HLC / Lamport-style semantics.
 *
 * **Element identity.**  Same JSON-stringify default + `identity`
 * override pattern as `GSet` / `ORSet`.  Pass `{ identity: k => ... }`
 * for non-JSON keys.
 */

export type LWWMapOptions<K> = {
  readonly identity?: (k: K) => string;
};

const defaultIdentity = (k: unknown): string => JSON.stringify(k);

type Entry<K, V> = {
  readonly key: K;
  readonly register: LWWRegister<V>;
};

export class LWWMap<K, V> implements Crdt<LWWMap<K, V>> {
  /**
   * `entries` is keyed by `identity(K)`; we keep the original `K`
   * alongside so iteration returns the user's instance verbatim.
   *
   * Each entry's register holds either a real value or `null` (the
   * tombstone marker).  We don't garbage-collect tombstones — they're
   * needed to prevent a stale gossip from resurrecting a removed key.
   */
  private constructor(
    private readonly entries: ReadonlyMap<string, Entry<K, V>>,
    private readonly identity: (k: K) => string,
  ) {}

  static empty<K, V>(options: LWWMapOptions<K> = {}): LWWMap<K, V> {
    return new LWWMap<K, V>(
      new Map(),
      options.identity ?? (defaultIdentity as (k: K) => string),
    );
  }

  /** Set `key` to `value` on behalf of `replica`, stamped at `timestamp`. */
  put(replica: ReplicaId, key: K, value: V, timestamp: number = Date.now()): LWWMap<K, V> {
    const id = this.identity(key);
    const existing = this.entries.get(id);
    const register = (existing?.register ?? LWWRegister.empty<V>())
      .assign(replica, value, timestamp);
    const next = new Map(this.entries);
    next.set(id, { key: existing?.key ?? key, register });
    return new LWWMap<K, V>(next, this.identity);
  }

  /**
   * Tombstone `key` on behalf of `replica`.  Internally an `assign`
   * with a `null` value at the given timestamp — older values are
   * displaced; concurrent values with newer timestamps still win.
   */
  remove(replica: ReplicaId, key: K, timestamp: number = Date.now()): LWWMap<K, V> {
    const id = this.identity(key);
    const existing = this.entries.get(id);
    // The register's internal value-type allows null already (its
    // empty state), so we lean on that.  A tombstone is just a register
    // whose value is null but whose timestamp says "I happened later".
    const register = (existing?.register ?? LWWRegister.empty<V>())
      .assign(replica, null as unknown as V, timestamp);
    const next = new Map(this.entries);
    next.set(id, { key: existing?.key ?? key, register });
    return new LWWMap<K, V>(next, this.identity);
  }

  /** Read `key` — `undefined` for missing keys or tombstones. */
  get(key: K): V | undefined {
    const entry = this.entries.get(this.identity(key));
    if (!entry) return undefined;
    const value = entry.register.value();
    // Tombstones are stored as null; `undefined` is the user-facing
    // "not present" answer for both missing and tombstoned keys.
    return value === null ? undefined : value;
  }

  has(key: K): boolean { return this.get(key) !== undefined; }

  /** @see {@link Crdt.customIdentity} */
  customIdentity(): CrdtIdentityFunction | undefined {
    return this.identity === defaultIdentity ? undefined : this.identity;
  }

  /** Snapshot of currently-live keys (tombstones excluded). */
  keys(): ReadonlyArray<K> {
    const out: K[] = [];
    for (const entry of this.entries.values()) {
      if (entry.register.value() !== null) out.push(entry.key);
    }
    return out;
  }

  /** Snapshot of currently-live `[key, value]` pairs. */
  entriesArray(): ReadonlyArray<readonly [K, V]> {
    const out: Array<readonly [K, V]> = [];
    for (const entry of this.entries.values()) {
      const value = entry.register.value();
      if (value !== null) out.push([entry.key, value] as const);
    }
    return out;
  }

  /** Number of currently-live keys (tombstones excluded). */
  get size(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.register.value() !== null) count++;
    return count;
  }

  merge(other: LWWMap<K, V>): LWWMap<K, V> {
    const next = new Map(this.entries);
    for (const [id, entry] of other.entries) {
      const ours = next.get(id);
      if (!ours) { next.set(id, entry); continue; }
      next.set(id, {
        key: ours.key,
        register: ours.register.merge(entry.register),
      });
    }
    return new LWWMap<K, V>(next, this.identity);
  }

  toJSON(): LWWMapJson<V> {
    // `Object.fromEntries`, not assignment: entry ids are identity-function output,
    // so a custom identity can yield `__proto__` — which an assignment feeds
    // to the inherited setter instead of storing, dropping the entry from
    // every frame and every snapshot with nothing logged (#767).
    return {
      kind: 'LWWMap',
      registers: Object.fromEntries(
        Array.from(this.entries, ([id, entry]) => [id, entry.register.toJSON()] as const),
      ),
      keyValues: Object.fromEntries(
        Array.from(this.entries, ([id, entry]) => [id, JSON.stringify(entry.key)] as const),
      ),
    };
  }

  /**
   * Rebuild a map from its wire shape, filing each entry under the caller's
   * identity rather than the sender's.  See `ORSet.fromJSON` for why the
   * re-key is what #766 needed; two ids that collapse onto one key merge
   * their registers, so the later write wins exactly as it would have if the
   * two had arrived as separate frames.
   */
  static fromJSON<K, V>(
    json: LWWMapJson<V>, options: LWWMapOptions<K> = {},
  ): LWWMap<K, V> {
    if (json.kind !== 'LWWMap') {
      throw new Error(`LWWMap.fromJSON: unexpected kind ${json.kind}`);
    }
    const custom = options.identity;
    const identity = custom ?? (defaultIdentity as (k: K) => string);
    assertPlainObject(json.registers, 'LWWMap.registers');
    const entries = new Map<string, Entry<K, V>>();
    // `safeEntries` rather than `Object.entries`: this decoder is a peer-facing
    // boundary like `ORSet`'s, and was missing both of its guards — the entry
    // ceiling and the `__proto__` rejection (#698, #767).
    for (const [wireId, registerJson] of safeEntries(json.registers, 'LWWMap.registers')) {
      const raw = json.keyValues?.[wireId];
      const key = raw !== undefined ? (JSON.parse(raw) as K) : (JSON.parse(wireId) as K);
      // `LWWRegister.fromJSON` reads `.kind` off its argument, which throws a
      // bare TypeError on `null` rather than the decode error callers act on.
      assertPlainObject(registerJson, `LWWMap.registers['${wireId}']`);
      const register = LWWRegister.fromJSON<V>(registerJson as unknown as LWWRegisterJson<V>);
      const id = custom === undefined ? wireId : custom(key);
      const existing = entries.get(id);
      entries.set(id, existing === undefined
        ? { key, register }
        : { key: existing.key, register: existing.register.merge(register) });
    }
    return new LWWMap<K, V>(entries, identity);
  }

  equals(other: LWWMap<K, V>): boolean {
    if (this.entries.size !== other.entries.size) return false;
    for (const [id, entry] of this.entries) {
      const otherEntry = other.entries.get(id);
      if (!otherEntry) return false;
      if (!entry.register.equals(otherEntry.register)) return false;
    }
    return true;
  }
}

export type LWWMapJson<V> = {
  readonly kind: 'LWWMap';
  readonly registers: Record<string, LWWRegisterJson<V>>;
  readonly keyValues?: Record<string, string>;
};
