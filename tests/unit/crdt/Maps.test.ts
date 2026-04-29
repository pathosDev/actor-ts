/**
 * Hand-rolled scenarios for the four map-shaped CRDTs added in #45.
 * The property tests in `CrdtProperties.test.ts` verify the algebraic
 * laws across hundreds of random samples; this file focuses on the
 * concrete day-to-day usage patterns each type is designed for and
 * the specific corner cases the issue called out:
 *
 *   - Concurrent puts on **different** keys (independent merge).
 *   - Concurrent puts on the **same** key (conflict resolution
 *     semantics: LWW arbitrates; OR-Map merges inner CRDTs;
 *     MV retains both branches).
 *   - ORMap with a nested ORSet — exercises the inner-CRDT decode
 *     callback on `fromJSON` and the per-key inner merge on `merge`.
 */
import { describe, expect, test } from 'bun:test';
import {
  GCounter, GCounterMap, LWWMap, MVRegister, ORMap, ORSet,
  decodeCrdt, type CrdtJson,
} from '../../../src/crdt/index.js';

/* =============================== LWWMap =============================== */

describe('LWWMap — typical workload', () => {
  test('per-user settings: independent keys merge without contention', () => {
    // Two replicas write disjoint user settings; merge sees the union.
    const a = LWWMap.empty<string, string>()
      .put('node-a', 'alice/theme', 'dark', 100)
      .put('node-a', 'alice/lang', 'en', 100);
    const b = LWWMap.empty<string, string>()
      .put('node-b', 'bob/theme', 'light', 100)
      .put('node-b', 'bob/lang', 'de', 100);
    const m = a.merge(b);
    expect(m.size).toBe(4);
    expect(m.get('alice/theme')).toBe('dark');
    expect(m.get('bob/lang')).toBe('de');
  });

  test('feature flag flip: newer write wins, older value disappears', () => {
    const a = LWWMap.empty<string, boolean>()
      .put('a', 'flag.beta', false, 1_000);
    const b = LWWMap.empty<string, boolean>()
      .put('b', 'flag.beta', true, 2_000);
    expect(a.merge(b).get('flag.beta')).toBe(true);
    expect(b.merge(a).get('flag.beta')).toBe(true);
  });

  test('removed key stays removed under a slow gossip from the original writer', () => {
    // A writes value, B reads it (via merge), B removes it, then A
    // gossips its original (older) value back to B.  The remove must
    // win — that's the LWW + tombstone story.
    const a = LWWMap.empty<string, string>().put('a', 'k', 'v', 100);
    const b = a.remove('b', 'k', 200);     // tombstone @ 200
    expect(b.has('k')).toBe(false);
    expect(b.merge(a).has('k')).toBe(false); // re-merging the older state
  });

  test('non-string keys with custom identity', () => {
    interface UserId { tenant: string; id: number }
    const m = LWWMap.empty<UserId, string>({ identity: (u) => `${u.tenant}:${u.id}` })
      .put('a', { tenant: 't1', id: 1 }, 'alice', 100)
      .put('a', { tenant: 't1', id: 2 }, 'bob', 100);
    expect(m.get({ tenant: 't1', id: 1 })).toBe('alice');
    expect(m.size).toBe(2);
  });
});

/* ============================== ORMap ================================ */

describe('ORMap — typical workload', () => {
  test('shopping cart: each cart is an ORSet; concurrent adds union', () => {
    const empty = ORMap.empty<string, ORSet<string>>();
    const aliceFromA = empty.update('a', 'cart-alice', () => ORSet.empty<string>(),
      (c) => c.add('a', 'apple'));
    const aliceFromB = empty.update('b', 'cart-alice', () => ORSet.empty<string>(),
      (c) => c.add('b', 'banana'));
    const merged = aliceFromA.merge(aliceFromB);
    expect(new Set(merged.get('cart-alice')!.value())).toEqual(new Set(['apple', 'banana']));
  });

  test('per-tenant counters: each tenant has its own GCounter', () => {
    const empty = ORMap.empty<string, GCounter>();
    const a = empty
      .update('node-a', 'tenant-1', () => GCounter.empty(), (c) => c.increment('node-a', 5))
      .update('node-a', 'tenant-2', () => GCounter.empty(), (c) => c.increment('node-a', 2));
    const b = empty
      .update('node-b', 'tenant-1', () => GCounter.empty(), (c) => c.increment('node-b', 3));
    const m = a.merge(b);
    expect(m.get('tenant-1')!.value()).toBe(8);     // per-replica sum
    expect(m.get('tenant-2')!.value()).toBe(2);
  });

  test('add-wins on key concurrent with remove', () => {
    const empty = ORMap.empty<string, ORSet<string>>();
    const a0 = empty.update('A', 'cart-1', () => ORSet.empty<string>(),
      (c) => c.add('A', 'apple'));
    const a1 = a0.remove('cart-1');                                  // A removes
    const b1 = a0.update('B', 'cart-1', () => ORSet.empty<string>(), // B re-adds
      (c) => c.add('B', 'banana'));
    const merged = a1.merge(b1);
    expect(merged.has('cart-1')).toBe(true);                         // add wins
    expect(new Set(merged.get('cart-1')!.value()))
      .toEqual(new Set(['apple', 'banana']));
  });

  test('JSON round-trip with the DistributedData inner-decoder', () => {
    // Same shape DD uses internally — wire the global `decodeCrdt`
    // dispatcher as the inner-value decoder.
    const m = ORMap.empty<string, ORSet<string>>()
      .update('A', 'cart-1', () => ORSet.empty<string>(),
        (s) => s.add('A', 'apple'))
      .update('A', 'cart-2', () => ORSet.empty<string>(),
        (s) => s.add('A', 'cherry'));
    const back = ORMap.fromJSON<string, ORSet<string>>(
      m.toJSON(),
      (json) => decodeCrdt(json as CrdtJson) as ORSet<string>,
    );
    expect(back.size).toBe(2);
    expect(back.get('cart-1')!.value()).toEqual(['apple']);
    expect(back.get('cart-2')!.value()).toEqual(['cherry']);
  });

  test('nested mutation via update preserves sender attribution in the inner ORSet', () => {
    // The replica id passed to update() drives the inner-ORSet's tag —
    // mutations attribute correctly so concurrent removes/adds resolve.
    const m = ORMap.empty<string, ORSet<string>>()
      .update('A', 'k', () => ORSet.empty<string>(), (s) => s.add('A', 'item'))
      .update('A', 'k', () => ORSet.empty<string>(), (s) => s.remove('item'));
    expect(m.get('k')!.has('item')).toBe(false);
  });
});

/* ============================ MVRegister ============================== */

describe('MVRegister — typical workload', () => {
  test('two replicas pick different colours; both survive until a third disambiguates', () => {
    const a = MVRegister.empty<string>().assign('node-a', 'red');
    const b = MVRegister.empty<string>().assign('node-b', 'blue');
    const conflicting = a.merge(b);
    expect(new Set(conflicting.values())).toEqual(new Set(['red', 'blue']));
    expect(conflicting.hasConflict).toBe(true);
    // A user (or admin) sees the conflict and picks "purple" — that
    // assign carries a vc dominating both.
    const resolved = conflicting.assign('admin', 'purple');
    expect(resolved.values()).toEqual(['purple']);
    expect(resolved.hasConflict).toBe(false);
  });

  test('three-way concurrent assigns all survive their merge', () => {
    const a = MVRegister.empty<string>().assign('a', 'A');
    const b = MVRegister.empty<string>().assign('b', 'B');
    const c = MVRegister.empty<string>().assign('c', 'C');
    const m = a.merge(b).merge(c);
    expect(new Set(m.values())).toEqual(new Set(['A', 'B', 'C']));
  });

  test('sequential assigns on the same replica chain to a single value', () => {
    const r = MVRegister.empty<number>()
      .assign('a', 1).assign('a', 2).assign('a', 3);
    expect(r.values()).toEqual([3]);
  });
});

/* ============================ GCounterMap ============================= */

describe('GCounterMap — typical workload', () => {
  test('per-route hit counter: independent routes accumulate separately', () => {
    const a = GCounterMap.empty<string>()
      .increment('node-a', '/api/users', 12)
      .increment('node-a', '/api/login', 3);
    const b = GCounterMap.empty<string>()
      .increment('node-b', '/api/users', 7)
      .increment('node-b', '/api/orders', 5);
    const m = a.merge(b);
    expect(m.value('/api/users')).toBe(19);     // 12 + 7 across replicas
    expect(m.value('/api/login')).toBe(3);
    expect(m.value('/api/orders')).toBe(5);
    expect(m.total()).toBe(27);
    expect(m.size).toBe(3);
  });

  test('idempotent under repeated gossip from the same peer', () => {
    const a = GCounterMap.empty<string>().increment('a', 'tag-1', 5);
    const b = GCounterMap.empty<string>().increment('b', 'tag-1', 3);
    expect(a.merge(b).merge(b).merge(b).value('tag-1')).toBe(8);
  });
});
