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
 *
 * ## Why all nine types are here (#1372)
 *
 * Four of them — `GCounterMap`, `LWWMap`, `MVRegister`, `ORMap` — used to be
 * checked only by `CrdtProperties.test.ts`, which drove bare `Math.random()`
 * over 25 samples. That has two defects and both matter for a merge law. There
 * is no shrinking, so a failure reports whichever three 40-element maps it
 * happened to draw rather than the two-element pair that actually breaks the
 * law; and there is no seed, so the failure cannot be re-run at all. "It failed
 * once on CI with these three random maps" is close to useless for the shapes
 * these bugs take — #950 (`LWWRegister.merge` returns `this` on a full tie),
 * #955 (departed replicas never pruned), #935 (no tie-break for equal versions)
 * are each two lines when a shrinker reports them.
 *
 * The seed is pinned globally by `tests/setup/property-seed.ts`, loaded through
 * `bunfig.toml`'s `preload`, so every `fc.assert` in the tree shares one seed,
 * one `numRuns` floor and `endOnFailure`. The trade is deliberate and written
 * down in `docs/…/testing/diagnosing-flakes.mdx`: a fixed seed stops the suite
 * finding *new* cases on its own, and a case found by an unlucky nightly and
 * then lost to log rotation was never turned into a regression test anyway.
 *
 * **When a property here fails, copy the shrunk counterexample into an example
 * test beside it before fixing anything.** The corpus at the bottom of this
 * file is where those go.
 */
import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';
import { GCounter } from '../../../src/crdt/GCounter.js';
import { PNCounter } from '../../../src/crdt/PNCounter.js';
import { GSet } from '../../../src/crdt/GSet.js';
import { ORSet } from '../../../src/crdt/ORSet.js';
import { LWWRegister } from '../../../src/crdt/LWWRegister.js';
import { GCounterMap } from '../../../src/crdt/GCounterMap.js';
import { LWWMap } from '../../../src/crdt/LWWMap.js';
import { MVRegister } from '../../../src/crdt/MVRegister.js';
import { ORMap } from '../../../src/crdt/ORMap.js';

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
    fc.record({ kind: fc.constant('increment' as const), replica: replicaId, delta: positiveDelta }),
    fc.record({ kind: fc.constant('decrement' as const), replica: replicaId, delta: positiveDelta }),
  ),
  { maxLength: 20 },
).map((ops) => ops.reduce((acc, op) =>
  op.kind === 'increment'
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

/* ---------------------------- GCounterMap ---------------------------- */

const mapKey = fc.constantFrom('page-views', 'clicks', 'signups');

const gcounterMapArb: fc.Arbitrary<GCounterMap<string>> = fc.array(
  fc.record({ replica: replicaId, key: mapKey, delta: positiveDelta }),
  { maxLength: 20 },
).map((ops) => ops.reduce(
  (acc, op) => acc.increment(op.replica, op.key, op.delta),
  GCounterMap.empty<string>(),
));

describe('GCounterMap — CRDT laws (property-based)', () => {
  test('commutativity: merge(a, b) ≡ merge(b, a)', () => {
    fc.assert(fc.property(gcounterMapArb, gcounterMapArb, (a, b) => {
      expect(a.merge(b).equals(b.merge(a))).toBe(true);
    }));
  });

  test('associativity: merge(merge(a, b), c) ≡ merge(a, merge(b, c))', () => {
    fc.assert(fc.property(gcounterMapArb, gcounterMapArb, gcounterMapArb, (a, b, c) => {
      expect(a.merge(b).merge(c).equals(a.merge(b.merge(c)))).toBe(true);
    }));
  });

  test('idempotence: merge(a, a) ≡ a', () => {
    fc.assert(fc.property(gcounterMapArb, (a) => {
      expect(a.merge(a).equals(a)).toBe(true);
    }));
  });

  test('the merged total is the per-key maximum summed, never a double count', () => {
    // The law tests above would all hold for a merge that dropped every key,
    // so one of them has to look at the value.  Per key the merge takes the
    // per-replica maximum, so a key's merged count is at least either side's.
    fc.assert(fc.property(gcounterMapArb, gcounterMapArb, (a, b) => {
      const merged = a.merge(b);
      for (const key of [...a.keys(), ...b.keys()]) {
        expect(merged.value(key)).toBeGreaterThanOrEqual(Math.max(a.value(key), b.value(key)));
      }
    }));
  });
});

/* ------------------------------- LWWMap ------------------------------- */

/**
 * **The operation is a function of `(replica, timestamp)`, and that is the
 * whole design of this generator** — found the hard way, on the first run.
 *
 * Last-writer-wins is commutative only where `(timestamp, replica)` is a total
 * order over *distinct* writes. A full tie on both, with differing values, has
 * no deterministic winner: merge keeps its left argument, so `merge(a,b)` and
 * `merge(b,a)` legitimately disagree. `LWWRegister`'s own commutativity case
 * documents this at length and excludes it with an `fc.pre`; #950 tracks the
 * underlying behaviour.
 *
 * The first version of this arbitrary drew the value freely and stamped by
 * array index, which does not avoid the tie at all: the two maps are generated
 * independently, so both start at timestamp 1, and a shared key written by the
 * same replica at the same index is exactly the excluded shape. It failed on
 * run 38 — see the corpus entry at the bottom of this file.
 *
 * Deriving both the value and the put/remove choice from the stamp fixes it by
 * modelling reality rather than by filtering afterwards: **a replica writes one
 * thing at one instant.** An `fc.pre` would have thrown most runs away to
 * enforce the same fact from outside.
 */
const lwwMapArb: fc.Arbitrary<LWWMap<string, string>> = fc.array(
  fc.record({ replica: replicaId, key: mapKey }),
  { maxLength: 20 },
).map((ops) => ops.reduce((acc, op, index) => {
  const timestamp = index + 1;
  // Same replica, same instant ⇒ same operation and same value, on both sides.
  return timestamp % 4 === 3
    ? acc.remove(op.replica, op.key, timestamp)
    : acc.put(op.replica, op.key, `${op.replica}@${timestamp}`, timestamp);
}, LWWMap.empty<string, string>()));

describe('LWWMap — CRDT laws (property-based)', () => {
  test('commutativity: merge(a, b) ≡ merge(b, a)', () => {
    fc.assert(fc.property(lwwMapArb, lwwMapArb, (a, b) => {
      expect(a.merge(b).equals(b.merge(a))).toBe(true);
    }));
  });

  test('associativity: merge(merge(a, b), c) ≡ merge(a, merge(b, c))', () => {
    fc.assert(fc.property(lwwMapArb, lwwMapArb, lwwMapArb, (a, b, c) => {
      expect(a.merge(b).merge(c).equals(a.merge(b.merge(c)))).toBe(true);
    }));
  });

  test('idempotence: merge(a, a) ≡ a', () => {
    fc.assert(fc.property(lwwMapArb, (a) => {
      expect(a.merge(a).equals(a)).toBe(true);
    }));
  });

  test('a removal is not a gap: the merged map never resurrects a deleted key', () => {
    // The tombstone half, which the three laws cannot see: they hold equally
    // for a merge that forgets removals, because both sides forget them.
    fc.assert(fc.property(lwwMapArb, (a) => {
      const removed = a.remove('node-a', 'page-views', 100_000);
      expect(removed.merge(a).get('page-views')).toBeUndefined();
      expect(a.merge(removed).get('page-views')).toBeUndefined();
    }));
  });
});

/* ----------------------------- MVRegister ----------------------------- */

const mvRegisterArb: fc.Arbitrary<MVRegister<string>> = fc.array(
  fc.record({ replica: replicaId, value: element }),
  { maxLength: 10 },
).map((ops) => ops.reduce(
  (acc, op) => acc.assign(op.replica, op.value),
  MVRegister.empty<string>(),
));

describe('MVRegister — CRDT laws (property-based)', () => {
  test('commutativity: merge(a, b) ≡ merge(b, a)', () => {
    fc.assert(fc.property(mvRegisterArb, mvRegisterArb, (a, b) => {
      expect(a.merge(b).equals(b.merge(a))).toBe(true);
    }));
  });

  test('associativity: merge(merge(a, b), c) ≡ merge(a, merge(b, c))', () => {
    fc.assert(fc.property(mvRegisterArb, mvRegisterArb, mvRegisterArb, (a, b, c) => {
      expect(a.merge(b).merge(c).equals(a.merge(b.merge(c)))).toBe(true);
    }));
  });

  test('idempotence: merge(a, a) ≡ a', () => {
    fc.assert(fc.property(mvRegisterArb, (a) => {
      expect(a.merge(a).equals(a)).toBe(true);
    }));
  });

  test('a value that both sides agree on is not duplicated by the merge', () => {
    // The multi-value half: concurrent writes are kept, and a *dominated*
    // write is not.  A merge that simply concatenated would satisfy all three
    // laws above and grow without bound.
    fc.assert(fc.property(mvRegisterArb, (a) => {
      const merged = a.merge(a);
      expect(merged.values().length).toBe(a.values().length);
    }));
  });
});

/* -------------------------------- ORMap -------------------------------- */

/**
 * `GCounter` as the value type: `ORMap` requires one that is itself a CRDT, and
 * a counter is the smallest thing that makes the *nested* merge observable.
 * With a value type whose merge is trivial, the map's laws would hold however
 * the nested merge behaved.
 */
const ormapArb: fc.Arbitrary<ORMap<string, GCounter>> = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant('put' as const),
      replica: replicaId,
      key: mapKey,
      delta: positiveDelta,
    }),
    fc.record({ kind: fc.constant('remove' as const), key: mapKey }),
  ),
  { maxLength: 15 },
).map((ops) => ops.reduce((acc, op) => (op.kind === 'remove'
  ? acc.remove(op.key)
  : acc.put(op.replica, op.key, GCounter.empty().increment(op.replica, op.delta))),
ORMap.empty<string, GCounter>()));

describe('ORMap — CRDT laws (property-based)', () => {
  test('commutativity: merge(a, b) ≡ merge(b, a)', () => {
    fc.assert(fc.property(ormapArb, ormapArb, (a, b) => {
      expect(a.merge(b).equals(b.merge(a))).toBe(true);
    }));
  });

  test('associativity: merge(merge(a, b), c) ≡ merge(a, merge(b, c))', () => {
    fc.assert(fc.property(ormapArb, ormapArb, ormapArb, (a, b, c) => {
      expect(a.merge(b).merge(c).equals(a.merge(b.merge(c)))).toBe(true);
    }));
  });

  test('idempotence: merge(a, a) ≡ a', () => {
    fc.assert(fc.property(ormapArb, (a) => {
      expect(a.merge(a).equals(a)).toBe(true);
    }));
  });

  test('the nested value merges rather than one side winning whole', () => {
    // What distinguishes an ORMap from a map of last-writer-wins values, and
    // the property the three laws are blind to: a key present on both sides
    // comes out with the two counters merged, not with either one chosen.
    fc.assert(fc.property(ormapArb, (a) => {
      const left = a.put('node-a', 'signups', GCounter.empty().increment('node-a', 3));
      const right = a.put('node-b', 'signups', GCounter.empty().increment('node-b', 4));
      expect(left.merge(right).get('signups')?.value()).toBe(7);
    }));
  });
});

/* ------------------------- counterexample corpus ------------------------- */

/**
 * Cases a property test found, pinned as plain examples (#1372).
 *
 * The discipline this establishes: **when a property fails, the shrunk
 * counterexample is copied here before anything is fixed.** A property with a
 * pinned seed stops looking for new cases the moment it is green again, so the
 * example is the only thing that keeps the case checked; and the seed that
 * found it lives in a log that rotates.
 *
 * Two entries, and the second one arrived the way the discipline describes:
 * the `LWWMap` property below was added, failed on its 38th case, and the
 * shrunk example was pinned here before the generator was changed.
 */
describe('counterexample corpus', () => {
  test('LWWMap: a tied (timestamp, replica) write of different values is order-dependent', () => {
    // Found by this file's own LWWMap commutativity property on its first run,
    // `{ seed: 1424, path: "37" }`: two maps that both wrote key `clicks` at
    // timestamp 3 from `node-d`, one a value and one a removal.
    //
    // It is `LWWRegister`'s documented tie behaviour reached one level up, not
    // a separate defect — merge keeps its left argument, so the two orders
    // disagree.  Pinned rather than deleted along with the generator that found
    // it: the generator now models "a replica writes one thing at one instant"
    // and can no longer produce this, which means nothing would notice if the
    // merge's behaviour on it ever changed.  #950.
    const withValue = LWWMap.empty<string, string>().put('node-d', 'clicks', 'cherry', 3);
    const withRemoval = LWWMap.empty<string, string>().remove('node-d', 'clicks', 3);

    expect(withValue.merge(withRemoval).get('clicks')).toBe('cherry');
    expect(withRemoval.merge(withValue).get('clicks')).toBeUndefined();
  });

  test('LWWRegister: a full tie on timestamp AND replica has no deterministic winner', () => {
    // Found by the commutativity property above, which was seed-dependent
    // flaky until it excluded this shape: `apple@14/node-b` against
    // `banana@14/node-b`.  Pinned here because the exclusion is a `fc.pre`,
    // and a `pre` documents what is *not* tested — this documents what the
    // behaviour actually is, so a future merge that changed it is a red test
    // rather than a silently narrower property.
    const left = LWWRegister.empty<string>().assign('node-b', 'apple', 14);
    const right = LWWRegister.empty<string>().assign('node-b', 'banana', 14);

    // Merge keeps its left argument on a total tie, so the two orders
    // legitimately disagree.  This is the documented behaviour, not a defect:
    // a replica never stamps two values at one timestamp, so the input is
    // unreachable in real use.
    expect(left.merge(right).value()).toBe('apple');
    expect(right.merge(left).value()).toBe('banana');
  });
});
