/**
 * Worked examples for the CRDT primitives — the named cases, not the laws.
 *
 * **The laws moved out (#1372).**  This file used to check idempotence,
 * commutativity and associativity for all nine types with a hand-rolled
 * generator over bare `Math.random()`, 25 triples apiece, and its header said
 * why: *"for these five small CRDTs a hand-rolled generator + a few hundred
 * random samples cover the shape adequately ... if a regression slips in,
 * re-running the test once will usually surface a failing seed."*
 *
 * Both halves of that turned out to be wrong in the same way.  There was no
 * seed to surface — `Math.random()` is unseeded, so a failure could not be
 * re-run at all — and there was no shrinking, so a broken merge law reported
 * whichever three 40-element maps the draw happened to produce rather than the
 * two-element pair that actually breaks it.  For the shapes these bugs take
 * (#950, #955, #935) that is the difference between a two-line report and an
 * afternoon.
 *
 * `Properties.test.ts` now covers all nine under `fast-check`, with shrinking,
 * 120 runs and the seed pinned globally by `tests/setup/property-seed.ts`.  It
 * found a case on its first run, which is the argument in one line.
 *
 * What stays here is what a property test is bad at: the hand-picked cases that
 * say what the type *means* — add-wins under a concurrent remove, a tombstone
 * that an older put must not resurrect, custom identity on a BigInt, JSON
 * round-trips.  Those are legible precisely because they are not random, and
 * no `Math.random()` call is left in the file — the three mentions above are
 * this comment talking about the ones that went.
 */
import { describe, expect, test } from 'bun:test';
import {
  GCounter, PNCounter, GSet, ORSet, LWWRegister,
  GCounterMap, LWWMap, MVRegister, ORMap,
} from '../../../src/crdt/index.js';

/* ============================== GCounter ============================== */

describe('GCounter — laws', () => {
  test('increments sum across replicas', () => {
    const first = GCounter.empty().increment('a', 3);
    const second = GCounter.empty().increment('b', 5);
    expect(first.merge(second).value()).toBe(8);
    expect(first.merge(second).merge(second).value()).toBe(8);   // re-merging same state idempotent
  });

  test('rejects negative deltas', () => {
    expect(() => GCounter.empty().increment('a', -1)).toThrow();
  });

  test('JSON round-trip preserves state', () => {
    const counter = GCounter.empty().increment('a', 2).increment('b', 7);
    const back = GCounter.fromJSON(counter.toJSON());
    expect(back.equals(counter)).toBe(true);
    expect(back.value()).toBe(9);
  });
});

/* ============================== PNCounter ============================= */

describe('PNCounter — laws', () => {
  test('decrement subtracts from the merged value', () => {
    const first = PNCounter.empty().increment('a', 10);
    const second = PNCounter.empty().decrement('b', 4);
    expect(first.merge(second).value()).toBe(6);
  });

  test('JSON round-trip', () => {
    const pnCounter = PNCounter.empty().increment('a', 7).decrement('b', 2);
    expect(PNCounter.fromJSON(pnCounter.toJSON()).value()).toBe(5);
  });
});

/* ============================== GSet ================================== */

describe('GSet — laws', () => {
  test('union semantics — adds win', () => {
    const first = GSet.empty<string>().add('apple').add('banana');
    const second = GSet.empty<string>().add('banana').add('cherry');
    const merged = first.merge(second);
    expect(new Set(merged.value())).toEqual(new Set(['apple', 'banana', 'cherry']));
  });

  test('JSON round-trip', () => {
    const set = GSet.empty<{ x: number }>().add({ x: 1 }).add({ x: 2 });
    const back = GSet.fromJSON<{ x: number }>(set.toJSON());
    expect(back.size).toBe(2);
    expect(back.has({ x: 1 })).toBe(true);
  });
});

/* ============================== ORSet ================================= */

describe('ORSet — laws', () => {
  test('add wins under concurrent add + remove', () => {
    // Both replicas observe one entry, then A removes, B re-adds.
    const a0 = ORSet.empty<string>().add('A', 'apple');
    const b0 = a0;
    const a1 = a0.remove('apple');
    const b1 = b0.add('B', 'apple');                       // tag from B that A never saw
    const merged = a1.merge(b1);
    expect(merged.has('apple')).toBe(true);                // add wins
  });

  test('a sequential remove of a known tag is honoured', () => {
    const first = ORSet.empty<string>().add('A', 'cherry');
    const removed = first.remove('cherry');
    expect(removed.has('cherry')).toBe(false);
    // Replaying the original through merge mustn't resurrect.
    expect(removed.merge(first).has('cherry')).toBe(false);
  });

  test('JSON round-trip preserves tags + tombstones', () => {
    const set = ORSet.empty<string>().add('A', 'x').add('A', 'y').remove('x');
    const back = ORSet.fromJSON<string>(set.toJSON());
    expect(back.has('x')).toBe(false);
    expect(back.has('y')).toBe(true);
  });
});

/* ============================== LWWRegister =========================== */

describe('LWWRegister — laws', () => {
  test('higher timestamp wins regardless of merge order', () => {
    const first = LWWRegister.empty<string>().assign('A', 'red',  100);
    const second = LWWRegister.empty<string>().assign('B', 'blue', 200);
    expect(first.merge(second).value()).toBe('blue');
    expect(second.merge(first).value()).toBe('blue');
  });

  test('ties on timestamp resolve by replica id deterministically', () => {
    const first = LWWRegister.empty<string>().assign('A', 'a', 100);
    const second = LWWRegister.empty<string>().assign('B', 'b', 100);
    // Replica 'B' > 'A' lexicographically → B wins on tie.
    expect(first.merge(second).value()).toBe('b');
    expect(second.merge(first).value()).toBe('b');
  });

  test('empty register loses to any non-empty one', () => {
    const emptyRegister = LWWRegister.empty<string>();
    const assignedRegister = LWWRegister.empty<string>().assign('A', 'hello', 1);
    expect(emptyRegister.merge(assignedRegister).value()).toBe('hello');
    expect(assignedRegister.merge(emptyRegister).value()).toBe('hello');
  });

  test('JSON round-trip', () => {
    const register = LWWRegister.empty<{ ok: boolean }>().assign('A', { ok: true }, 42);
    const back = LWWRegister.fromJSON<{ ok: boolean }>(register.toJSON());
    expect(back.value()).toEqual({ ok: true });
    expect(back.timestamp()).toBe(42);
  });
});

/* ============================== #57 — custom identity =============== */

describe('GSet — custom identity', () => {
  test('default identity uses JSON.stringify, dedupes structurally-equal values', () => {
    const set = GSet.empty<{ x: number }>().add({ x: 1 }).add({ x: 1 }).add({ x: 2 });
    expect(set.size).toBe(2);
  });

  test('custom identity dedupes by user-defined key', () => {
    type Item = { sku: string; name: string };
    const set = GSet.empty<Item>({ identity: (i) => i.sku })
      .add({ sku: 'BOOK', name: 'A' })
      .add({ sku: 'BOOK', name: 'A different name' }) // same sku → dropped
      .add({ sku: 'COFFEE', name: 'C' });
    expect(set.size).toBe(2);
    // The first-added item's `name` wins because subsequent adds
    // with the same key are dropped.
    expect(set.value().find((i) => i.sku === 'BOOK')?.name).toBe('A');
  });

  test('default identity throws on BigInt (the failure mode #57 documents)', () => {
    const set = GSet.empty<bigint>();
    expect(() => set.add(42n)).toThrow();
  });

  test('custom identity makes BigInt usable', () => {
    const set = GSet.empty<bigint>({ identity: (second) => second.toString() })
      .add(42n).add(42n).add(43n);
    expect(set.size).toBe(2);
  });
});

describe('ORSet — custom identity', () => {
  test('custom identity dedupes by user-defined key', () => {
    type Item = { sku: string; price: number };
    const set = ORSet.empty<Item>({ identity: (i) => i.sku })
      .add('replica-a', { sku: 'BOOK', price: 10 })
      .add('replica-a', { sku: 'BOOK', price: 99 })   // same sku
      .add('replica-a', { sku: 'COFFEE', price: 5 });
    expect(set.size).toBe(2);
  });

  test('add-wins still works with custom identity', () => {
    type Item = { sku: string };
    const make = (): ORSet<Item> => ORSet.empty<Item>({ identity: (i) => i.sku });
    const a0 = make().add('A', { sku: 'apple' });
    const a1 = a0.remove({ sku: 'apple' });
    const b1 = a0.add('B', { sku: 'apple' });
    expect(a1.merge(b1).has({ sku: 'apple' })).toBe(true);
  });

  test('JSON round-trip with custom identity recovers element values', () => {
    type Item = { sku: string; name: string };
    const set = ORSet.empty<Item>({ identity: (i) => i.sku })
      .add('A', { sku: 'BOOK', name: 'Designing Data-Intensive Applications' });
    const back = ORSet.fromJSON<Item>(set.toJSON(), { identity: (i) => i.sku });
    expect(back.has({ sku: 'BOOK', name: 'whatever' })).toBe(true);
    expect(back.value()[0]!.name).toBe('Designing Data-Intensive Applications');
  });
});

/* ============================== #45 — additional CRDTs =============== */

/* ----------------------------- GCounterMap ---------------------------- */

describe('GCounterMap — laws', () => {
  test('per-key counters merge independently', () => {
    const first = GCounterMap.empty<string>().increment('a', 'page-views', 3);
    const second = GCounterMap.empty<string>().increment('b', 'clicks', 2);
    const map = first.merge(second);
    expect(map.value('page-views')).toBe(3);
    expect(map.value('clicks')).toBe(2);
    expect(map.total()).toBe(5);
  });

  test('rejects negative deltas', () => {
    expect(() => GCounterMap.empty<string>().increment('a', 'k', -1)).toThrow();
  });

  test('JSON round-trip', () => {
    const map = GCounterMap.empty<string>()
      .increment('a', 'k1', 5)
      .increment('b', 'k2', 3);
    const back = GCounterMap.fromJSON<string>(map.toJSON());
    expect(back.value('k1')).toBe(5);
    expect(back.value('k2')).toBe(3);
    expect(back.total()).toBe(8);
  });

  test('custom identity dedupes by user-defined key', () => {
    type Tag = { name: string; color: string };
    const map = GCounterMap.empty<Tag>({ identity: (t) => t.name })
      .increment('a', { name: 'urgent', color: 'red' }, 2)
      .increment('b', { name: 'urgent', color: 'orange' }, 3);  // same name
    expect(map.size).toBe(1);
    expect(map.value({ name: 'urgent', color: 'whatever' })).toBe(5);
  });
});

/* ------------------------------ LWWMap -------------------------------- */

describe('LWWMap — laws', () => {
  test('higher-timestamp put wins regardless of merge order', () => {
    const first = LWWMap.empty<string, string>().put('A', 'theme', 'dark', 100);
    const second = LWWMap.empty<string, string>().put('B', 'theme', 'light', 200);
    expect(first.merge(second).get('theme')).toBe('light');
    expect(second.merge(first).get('theme')).toBe('light');
  });

  test('newer remove tombstones an older put', () => {
    const first = LWWMap.empty<string, string>().put('A', 'flag', 'on', 100);
    const tombstoned = first.remove('A', 'flag', 200);
    expect(tombstoned.has('flag')).toBe(false);
    // Re-merging the original mustn't resurrect.
    expect(tombstoned.merge(first).has('flag')).toBe(false);
  });

  test('newer put resurrects after an older tombstone', () => {
    const first = LWWMap.empty<string, string>().put('A', 'flag', 'on', 100);
    const tomb = first.remove('A', 'flag', 200);
    const fresh = LWWMap.empty<string, string>().put('A', 'flag', 'on-again', 300);
    expect(tomb.merge(fresh).get('flag')).toBe('on-again');
  });

  test('ties on timestamp resolve by replica id deterministically', () => {
    const first = LWWMap.empty<string, string>().put('A', 'k', 'a-val', 100);
    const second = LWWMap.empty<string, string>().put('B', 'k', 'b-val', 100);
    expect(first.merge(second).get('k')).toBe('b-val');  // 'B' > 'A' lex
    expect(second.merge(first).get('k')).toBe('b-val');
  });

  test('JSON round-trip preserves values + tombstones', () => {
    const map = LWWMap.empty<string, string>()
      .put('A', 'x', 'foo', 1)
      .put('A', 'y', 'bar', 1)
      .remove('A', 'x', 2);
    const back = LWWMap.fromJSON<string, string>(map.toJSON());
    expect(back.has('x')).toBe(false);
    expect(back.get('y')).toBe('bar');
  });
});

/* ----------------------------- MVRegister ----------------------------- */

describe('MVRegister — laws', () => {
  test('concurrent assigns from independent replicas survive', () => {
    const first = MVRegister.empty<string>().assign('a', 'red');
    const second = MVRegister.empty<string>().assign('b', 'blue');
    const map = first.merge(second);
    expect(new Set(map.values())).toEqual(new Set(['red', 'blue']));
    expect(map.hasConflict).toBe(true);
    expect(map.size).toBe(2);
  });

  test('a later assign that has seen both branches subsumes them', () => {
    const first = MVRegister.empty<string>().assign('a', 'red');
    const second = MVRegister.empty<string>().assign('b', 'blue');
    const merged = first.merge(second);
    // Replica A now sees both branches and writes a new value — that
    // value's vc dominates the prior pair, so the merge collapses to it.
    const final = merged.assign('a', 'final');
    expect(final.values()).toEqual(['final']);
    expect(final.hasConflict).toBe(false);
  });

  test('non-concurrent sequential assigns subsume the prior', () => {
    const register = MVRegister.empty<string>()
      .assign('a', 'first')
      .assign('a', 'second')
      .assign('a', 'third');
    expect(register.values()).toEqual(['third']);
  });

  test('JSON round-trip preserves concurrent branches', () => {
    const first = MVRegister.empty<string>().assign('a', 'red');
    const second = MVRegister.empty<string>().assign('b', 'blue');
    const map = first.merge(second);
    const back = MVRegister.fromJSON<string>(map.toJSON());
    expect(new Set(back.values())).toEqual(new Set(['red', 'blue']));
  });
});

/* ------------------------------ ORMap --------------------------------- */

describe('ORMap — laws', () => {
  test('per-key inner-CRDT merge: cart contents from two replicas union', () => {
    const empty = ORMap.empty<string, ORSet<string>>();
    const first = empty.update('alice', 'cart-1', () => ORSet.empty<string>(),
      (third) => third.add('alice', 'apple'));
    const second = empty.update('bob', 'cart-1', () => ORSet.empty<string>(),
      (third) => third.add('bob', 'banana'));
    const map = first.merge(second);
    expect(new Set(map.get('cart-1')!.value())).toEqual(new Set(['apple', 'banana']));
  });

  test('remove key — concurrent put with new tag survives (add wins)', () => {
    const empty = ORMap.empty<string, ORSet<string>>();
    const a0 = empty.update('A', 'k', () => ORSet.empty<string>(),
      (set) => set.add('A', 'item-a'));
    const a1 = a0.remove('k');
    const b1 = a0.update('B', 'k', () => ORSet.empty<string>(),
      (set) => set.add('B', 'item-b'));
    const merged = a1.merge(b1);
    // Add wins on the keyset — B's add tag survives A's remove because
    // A never saw it.  The surviving inner ORSet is b1's, which carries
    // the original A-tagged 'item-a' (B observed it before adding) plus
    // B's own 'item-b'.  ORMap-level remove does not touch the inner
    // CRDT's contents — that would require an explicit `update(.., s
    // => s.remove(...))` instead.
    expect(merged.has('k')).toBe(true);
    expect(new Set(merged.get('k')!.value())).toEqual(new Set(['item-a', 'item-b']));
  });

  test('JSON round-trip with ORSet values preserves inner state', () => {
    const map = ORMap.empty<string, ORSet<string>>()
      .update('A', 'cart-1', () => ORSet.empty<string>(),
        (set) => set.add('A', 'apple').add('A', 'banana'))
      .update('A', 'cart-2', () => ORSet.empty<string>(),
        (set) => set.add('A', 'coffee'));
    const back = ORMap.fromJSON<string, ORSet<string>>(
      map.toJSON(),
      (json) => ORSet.fromJSON<string>(json as ReturnType<ORSet<string>['toJSON']>),
    );
    expect(back.size).toBe(2);
    expect(new Set(back.get('cart-1')!.value())).toEqual(new Set(['apple', 'banana']));
    expect(back.get('cart-2')!.value()).toEqual(['coffee']);
  });

  test('ORMap with GCounter values — totals merge per key', () => {
    const empty = ORMap.empty<string, GCounter>();
    const first = empty.update('a', 'route-/api', () => GCounter.empty(),
      (third) => third.increment('a', 5));
    const second = empty.update('b', 'route-/api', () => GCounter.empty(),
      (third) => third.increment('b', 3));
    const map = first.merge(second);
    expect(map.get('route-/api')!.value()).toBe(8);
  });
});
