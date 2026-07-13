/**
 * Property-based tests for CRDT laws (#285).
 *
 * Every CRDT in the framework MUST satisfy three laws for replicas to
 * converge:
 *
 *   1. Commutativity:  merge(a, b)        ≡ merge(b, a)
 *   2. Associativity:  merge(merge(a,b),c) ≡ merge(a, merge(b,c))
 *   3. Idempotence:    merge(a, a)         ≡ a
 *
 * Hand-written tests verify the happy path, but they can't easily
 * stress the edge cases that arise in real distributed scenarios
 * (interleaved increments from 5 replicas, ORSet add+remove
 * sequences with overlapping tags, LWW ties).  fast-check generates
 * those automatically via arbitraries and minimises any failure.
 *
 * The arbitraries below are intentionally small — limited replica
 * pool, bounded delta size — so a single run-time of ~200 random
 * tests completes in well under a second.
 */
import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';
import { GCounter } from '../../../src/crdt/GCounter.js';
import { PNCounter } from '../../../src/crdt/PNCounter.js';
import { GSet } from '../../../src/crdt/GSet.js';
import { ORSet } from '../../../src/crdt/ORSet.js';
import { LWWRegister } from '../../../src/crdt/LWWRegister.js';

const replicaId = fc.constantFrom('node-a', 'node-b', 'node-c', 'node-d', 'node-e');
const positiveDelta = fc.integer({ min: 1, max: 50 });
const element = fc.constantFrom('apple', 'banana', 'cherry', 'date', 'elderberry');

/* ----------------------------- GCounter ----------------------------- */

const gcounterArb: fc.Arbitrary<GCounter> = fc.array(
  fc.record({ replica: replicaId, delta: positiveDelta }),
  { maxLength: 20 },
).map((ops) => ops.reduce((acc, op) => acc.increment(op.replica, op.delta), GCounter.empty()));

describe('GCounter — CRDT laws (property-based)', () => {
  test('commutativity: merge(a, b) ≡ merge(b, a)', () => {
    fc.assert(fc.property(gcounterArb, gcounterArb, (a, b) => {
      expect(a.merge(b).equals(b.merge(a))).toBe(true);
    }));
  });

  test('associativity: merge(merge(a, b), c) ≡ merge(a, merge(b, c))', () => {
    fc.assert(fc.property(gcounterArb, gcounterArb, gcounterArb, (a, b, counter) => {
      expect(a.merge(b).merge(counter).equals(a.merge(b.merge(counter)))).toBe(true);
    }));
  });

  test('idempotence: merge(a, a) ≡ a', () => {
    fc.assert(fc.property(gcounterArb, (a) => {
      expect(a.merge(a).equals(a)).toBe(true);
    }));
  });

  test('value() is the sum of all per-replica increments', () => {
    fc.assert(fc.property(
      fc.array(fc.record({ replica: replicaId, delta: positiveDelta }), { maxLength: 20 }),
      (ops) => {
        // Total stamped should equal max-per-replica sum, which for a
        // single replica's sequence of increments equals the simple sum
        // (operations on the same replica are additive, max is monotonic).
        const counter = ops.reduce((acc, op) => acc.increment(op.replica, op.delta), GCounter.empty());
        // Compute expected: for each replica, sum its deltas.
        const perReplica: Record<string, number> = {};
        for (const op of ops) perReplica[op.replica] = (perReplica[op.replica] ?? 0) + op.delta;
        const expected = Object.values(perReplica).reduce((s, n) => s + n, 0);
        expect(counter.value()).toBe(expected);
      },
    ));
  });
});

/* ----------------------------- PNCounter ----------------------------- */

const pncounterArb: fc.Arbitrary<PNCounter> = fc.array(
  fc.oneof(
    fc.record({ kind: fc.constant('inc' as const), replica: replicaId, delta: positiveDelta }),
    fc.record({ kind: fc.constant('dec' as const), replica: replicaId, delta: positiveDelta }),
  ),
  { maxLength: 20 },
).map((ops) => ops.reduce((acc, op) =>
  op.kind === 'inc'
    ? acc.increment(op.replica, op.delta)
    : acc.decrement(op.replica, op.delta),
  PNCounter.empty(),
));

describe('PNCounter — CRDT laws', () => {
  test('commutativity', () => {
    fc.assert(fc.property(pncounterArb, pncounterArb, (a, b) => {
      expect(a.merge(b).value()).toBe(b.merge(a).value());
    }));
  });

  test('associativity', () => {
    fc.assert(fc.property(pncounterArb, pncounterArb, pncounterArb, (a, b, counter) => {
      expect(a.merge(b).merge(counter).value()).toBe(a.merge(b.merge(counter)).value());
    }));
  });

  test('idempotence', () => {
    fc.assert(fc.property(pncounterArb, (a) => {
      expect(a.merge(a).value()).toBe(a.value());
    }));
  });
});

/* ------------------------------- GSet ------------------------------- */

const gsetArb: fc.Arbitrary<GSet<string>> = fc.array(element, { maxLength: 20 })
  .map((elems) => elems.reduce((acc, e) => acc.add(e), GSet.empty<string>()));

describe('GSet — CRDT laws', () => {
  test('commutativity (set union is symmetric)', () => {
    fc.assert(fc.property(gsetArb, gsetArb, (a, b) => {
      const ab = Array.from(a.merge(b).value()).sort();
      const ba = Array.from(b.merge(a).value()).sort();
      expect(ab).toEqual(ba);
    }));
  });

  test('associativity', () => {
    fc.assert(fc.property(gsetArb, gsetArb, gsetArb, (a, b, counter) => {
      const left = Array.from(a.merge(b).merge(counter).value()).sort();
      const right = Array.from(a.merge(b.merge(counter)).value()).sort();
      expect(left).toEqual(right);
    }));
  });

  test('idempotence', () => {
    fc.assert(fc.property(gsetArb, (a) => {
      const aa = Array.from(a.merge(a).value()).sort();
      const orig = Array.from(a.value()).sort();
      expect(aa).toEqual(orig);
    }));
  });
});

/* ------------------------------- ORSet ------------------------------- */

const orsetArb: fc.Arbitrary<ORSet<string>> = fc.array(
  fc.oneof(
    fc.record({ kind: fc.constant('add' as const), replica: replicaId, element }),
    fc.record({ kind: fc.constant('remove' as const), element }),
  ),
  { maxLength: 20 },
).map((ops) => ops.reduce((acc, op) =>
  op.kind === 'add' ? acc.add(op.replica, op.element) : acc.remove(op.element),
  ORSet.empty<string>(),
));

describe('ORSet — CRDT laws', () => {
  test('commutativity', () => {
    fc.assert(fc.property(orsetArb, orsetArb, (a, b) => {
      const ab = Array.from(a.merge(b).value()).sort();
      const ba = Array.from(b.merge(a).value()).sort();
      expect(ab).toEqual(ba);
    }));
  });

  test('associativity', () => {
    fc.assert(fc.property(orsetArb, orsetArb, orsetArb, (a, b, counter) => {
      const left = Array.from(a.merge(b).merge(counter).value()).sort();
      const right = Array.from(a.merge(b.merge(counter)).value()).sort();
      expect(left).toEqual(right);
    }));
  });

  test('idempotence', () => {
    fc.assert(fc.property(orsetArb, (a) => {
      const aa = Array.from(a.merge(a).value()).sort();
      const orig = Array.from(a.value()).sort();
      expect(aa).toEqual(orig);
    }));
  });
});

/* --------------------------- LWWRegister --------------------------- */

const lwwArb: fc.Arbitrary<LWWRegister<string>> = fc.array(
  fc.record({
    replica: replicaId,
    value: element,
    timestamp: fc.integer({ min: 1, max: 10_000 }),
  }),
  { maxLength: 10 },
).map((ops) => ops.reduce((acc, op) => acc.assign(op.replica, op.value, op.timestamp), LWWRegister.empty<string>()));

describe('LWWRegister — CRDT laws', () => {
  test('commutativity (deterministic for non-tied timestamps)', () => {
    fc.assert(fc.property(lwwArb, lwwArb, (a, b) => {
      // Merge is "latest timestamp wins, ties broken by replica id" — a
      // total order, hence commutative, only when the two registers have
      // distinct (timestamp, replica) ordering keys.  Distinct timestamps
      // resolve by timestamp; equal timestamp + different replica resolve
      // by replica id (the case this test most wants to exercise — see
      // title).  Both stay in scope below.
      //
      // A tie on BOTH timestamp AND replica with differing values has no
      // deterministic winner: merge keeps its left argument, so
      // merge(a,b) and merge(b,a) legitimately disagree.  That input is
      // unreachable in real use — a replica never stamps two values at
      // one timestamp — so we exclude it here rather than inventing an
      // arbitrary value tie-break.  Without this guard the property was
      // seed-dependent flaky (e.g. apple@14/node-b vs banana@14/node-b).
      const ka = a.toJSON();
      const kb = b.toJSON();
      fc.pre(!(ka.timestamp === kb.timestamp && ka.replica === kb.replica));
      expect(a.merge(b).value()).toBe(b.merge(a).value());
    }));
  });

  test('associativity', () => {
    fc.assert(fc.property(lwwArb, lwwArb, lwwArb, (a, b, counter) => {
      expect(a.merge(b).merge(counter).value()).toBe(a.merge(b.merge(counter)).value());
    }));
  });

  test('idempotence', () => {
    fc.assert(fc.property(lwwArb, (a) => {
      expect(a.merge(a).value()).toBe(a.value());
    }));
  });
});
