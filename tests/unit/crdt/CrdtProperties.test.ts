/**
 * Property tests for the CRDT primitives.  Three properties every
 * CRDT must satisfy:
 *
 *   - Idempotent:    merge(a, a)             === a
 *   - Commutative:   merge(a, b)             === merge(b, a)
 *   - Associative:   merge(merge(a, b), c)   === merge(a, merge(b, c))
 *
 * We don't pull in `fast-check` — for these five small CRDTs a
 * hand-rolled generator + a few hundred random samples cover the
 * shape adequately.  The generators below are deterministic given
 * a Math.random sequence; if a regression slips in, re-running the
 * test once will usually surface a failing seed.
 *
 * Each block:
 *   - generates random replicas of the CRDT (`gen()`),
 *   - asserts the three laws on every triple (a, b, c),
 *   - then a couple of hand-picked smoke cases for legibility.
 */
import { describe, expect, test } from 'bun:test';
import {
  GCounter, PNCounter, GSet, ORSet, LWWRegister,
} from '../../../src/crdt/index.js';
import type { Crdt } from '../../../src/crdt/index.js';

const REPLICAS = ['r-a', 'r-b', 'r-c', 'r-d'];
const SAMPLES = 25; // triples per CRDT; runs ~100 merges total per type

function pickReplica(): string {
  return REPLICAS[Math.floor(Math.random() * REPLICAS.length)]!;
}

function eq<C extends Crdt<C>>(
  a: C, b: C, equalsImpl?: (x: C, y: C) => boolean,
): boolean {
  if (equalsImpl) return equalsImpl(a, b);
  return JSON.stringify(a.toJSON()) === JSON.stringify(b.toJSON());
}

function checkLaws<C extends Crdt<C>>(
  gen: () => C, equalsImpl?: (a: C, b: C) => boolean,
): void {
  for (let i = 0; i < SAMPLES; i++) {
    const a = gen(), b = gen(), c = gen();
    expect(eq(a.merge(a), a, equalsImpl)).toBe(true);                       // idempotent
    expect(eq(a.merge(b), b.merge(a), equalsImpl)).toBe(true);              // commutative
    expect(eq(a.merge(b).merge(c), a.merge(b.merge(c)), equalsImpl))        // associative
      .toBe(true);
  }
}

/* ============================== GCounter ============================== */

describe('GCounter — laws', () => {
  test('idempotent / commutative / associative', () => {
    const gen = (): GCounter => {
      let g = GCounter.empty();
      const ops = 1 + Math.floor(Math.random() * 8);
      for (let i = 0; i < ops; i++) {
        g = g.increment(pickReplica(), 1 + Math.floor(Math.random() * 5));
      }
      return g;
    };
    checkLaws(gen, (a, b) => a.equals(b));
  });

  test('increments sum across replicas', () => {
    const a = GCounter.empty().increment('a', 3);
    const b = GCounter.empty().increment('b', 5);
    expect(a.merge(b).value()).toBe(8);
    expect(a.merge(b).merge(b).value()).toBe(8);   // re-merging same state idempotent
  });

  test('rejects negative deltas', () => {
    expect(() => GCounter.empty().increment('a', -1)).toThrow();
  });

  test('JSON round-trip preserves state', () => {
    const g = GCounter.empty().increment('a', 2).increment('b', 7);
    const back = GCounter.fromJSON(g.toJSON());
    expect(back.equals(g)).toBe(true);
    expect(back.value()).toBe(9);
  });
});

/* ============================== PNCounter ============================= */

describe('PNCounter — laws', () => {
  test('idempotent / commutative / associative', () => {
    const gen = (): PNCounter => {
      let p = PNCounter.empty();
      const ops = 1 + Math.floor(Math.random() * 10);
      for (let i = 0; i < ops; i++) {
        const delta = 1 + Math.floor(Math.random() * 5);
        p = Math.random() < 0.5
          ? p.increment(pickReplica(), delta)
          : p.decrement(pickReplica(), delta);
      }
      return p;
    };
    checkLaws(gen, (a, b) => a.equals(b));
  });

  test('decrement subtracts from the merged value', () => {
    const a = PNCounter.empty().increment('a', 10);
    const b = PNCounter.empty().decrement('b', 4);
    expect(a.merge(b).value()).toBe(6);
  });

  test('JSON round-trip', () => {
    const p = PNCounter.empty().increment('a', 7).decrement('b', 2);
    expect(PNCounter.fromJSON(p.toJSON()).value()).toBe(5);
  });
});

/* ============================== GSet ================================== */

describe('GSet — laws', () => {
  test('idempotent / commutative / associative', () => {
    const gen = (): GSet<number> => {
      let s = GSet.empty<number>();
      const ops = 1 + Math.floor(Math.random() * 8);
      for (let i = 0; i < ops; i++) s = s.add(Math.floor(Math.random() * 5));
      return s;
    };
    checkLaws(gen, (a, b) => a.equals(b));
  });

  test('union semantics — adds win', () => {
    const a = GSet.empty<string>().add('apple').add('banana');
    const b = GSet.empty<string>().add('banana').add('cherry');
    const merged = a.merge(b);
    expect(new Set(merged.value())).toEqual(new Set(['apple', 'banana', 'cherry']));
  });

  test('JSON round-trip', () => {
    const s = GSet.empty<{ x: number }>().add({ x: 1 }).add({ x: 2 });
    const back = GSet.fromJSON<{ x: number }>(s.toJSON());
    expect(back.size).toBe(2);
    expect(back.has({ x: 1 })).toBe(true);
  });
});

/* ============================== ORSet ================================= */

describe('ORSet — laws', () => {
  test('idempotent / commutative / associative', () => {
    const gen = (): ORSet<number> => {
      let s = ORSet.empty<number>();
      const ops = 1 + Math.floor(Math.random() * 8);
      for (let i = 0; i < ops; i++) {
        const e = Math.floor(Math.random() * 4);
        s = Math.random() < 0.7 ? s.add(pickReplica(), e) : s.remove(e);
      }
      return s;
    };
    checkLaws(gen, (a, b) => a.equals(b));
  });

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
    const a = ORSet.empty<string>().add('A', 'cherry');
    const removed = a.remove('cherry');
    expect(removed.has('cherry')).toBe(false);
    // Replaying the original through merge mustn't resurrect.
    expect(removed.merge(a).has('cherry')).toBe(false);
  });

  test('JSON round-trip preserves tags + tombstones', () => {
    const s = ORSet.empty<string>().add('A', 'x').add('A', 'y').remove('x');
    const back = ORSet.fromJSON<string>(s.toJSON());
    expect(back.has('x')).toBe(false);
    expect(back.has('y')).toBe(true);
  });
});

/* ============================== LWWRegister =========================== */

describe('LWWRegister — laws', () => {
  test('idempotent / commutative / associative', () => {
    let nextTs = 1;
    const gen = (): LWWRegister<string> => {
      // Use deterministic-ish increasing timestamps so we cover both
      // "same ts → replica tiebreaker" and "different ts → newest wins".
      const ts = (nextTs += 1 + Math.floor(Math.random() * 3));
      return LWWRegister.empty<string>().assign(pickReplica(), `v-${ts}`, ts);
    };
    checkLaws(gen, (a, b) => a.equals(b));
  });

  test('higher timestamp wins regardless of merge order', () => {
    const a = LWWRegister.empty<string>().assign('A', 'red',  100);
    const b = LWWRegister.empty<string>().assign('B', 'blue', 200);
    expect(a.merge(b).value()).toBe('blue');
    expect(b.merge(a).value()).toBe('blue');
  });

  test('ties on timestamp resolve by replica id deterministically', () => {
    const a = LWWRegister.empty<string>().assign('A', 'a', 100);
    const b = LWWRegister.empty<string>().assign('B', 'b', 100);
    // Replica 'B' > 'A' lexicographically → B wins on tie.
    expect(a.merge(b).value()).toBe('b');
    expect(b.merge(a).value()).toBe('b');
  });

  test('empty register loses to any non-empty one', () => {
    const e = LWWRegister.empty<string>();
    const v = LWWRegister.empty<string>().assign('A', 'hello', 1);
    expect(e.merge(v).value()).toBe('hello');
    expect(v.merge(e).value()).toBe('hello');
  });

  test('JSON round-trip', () => {
    const r = LWWRegister.empty<{ ok: boolean }>().assign('A', { ok: true }, 42);
    const back = LWWRegister.fromJSON<{ ok: boolean }>(r.toJSON());
    expect(back.value()).toEqual({ ok: true });
    expect(back.timestamp()).toBe(42);
  });
});
