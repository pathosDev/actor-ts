/**
 * Hostile CRDT payloads (#699 and the specific defects underneath it).
 *
 * `src/cluster/WireValidation.ts` forwards frame kinds it does not know, on
 * the stated grounds that "the extension validates its own payload".
 * DistributedData is named in that list and did not — every `fromJSON`
 * checked `kind` and trusted the rest — so anything `JSON.parse` produced
 * reached the merge machinery.
 *
 * A CRDT absorbing a bad value is worse than a handler throwing on one: the
 * value is kept, merged, re-gossiped and persisted, and grow-only merges
 * never take it back.
 */
import { describe, expect, test } from 'bun:test';
import { decodeCrdt } from '../../../src/crdt/DistributedData.js';
import {
  MAX_COUNTER_SLOT,
  MAX_CRDT_ENTRIES,
  MAX_MV_REGISTER_ENTRIES,
} from '../../../src/crdt/Constants.js';
import { CrdtDecodeError } from '../../../src/crdt/CrdtWireValidation.js';
import { GCounter } from '../../../src/crdt/GCounter.js';
import { GCounterMap } from '../../../src/crdt/GCounterMap.js';
import { LWWMap } from '../../../src/crdt/LWWMap.js';
import { LWWRegister } from '../../../src/crdt/LWWRegister.js';
import { MVRegister } from '../../../src/crdt/MVRegister.js';
import { ORSet } from '../../../src/crdt/ORSet.js';
import { PNCounter } from '../../../src/crdt/PNCounter.js';

/** A payload the type system would reject but the wire happily carries. */
const wire = (value: unknown): never => value as never;

describe('GCounter payloads (#720)', () => {
  test('a non-numeric slot is rejected', () => {
    // `merge` takes a componentwise max and `value()` sums the slots, so a
    // string here makes `value()` return a string cluster-wide.
    expect(() => GCounter.fromJSON(wire({ kind: 'GCounter', state: { a: '9' } })))
      .toThrow(CrdtDecodeError);
  });

  test('a negative or fractional slot is rejected', () => {
    expect(() => GCounter.fromJSON(wire({ kind: 'GCounter', state: { a: -1 } })))
      .toThrow(CrdtDecodeError);
    expect(() => GCounter.fromJSON(wire({ kind: 'GCounter', state: { a: 1.5 } })))
      .toThrow(CrdtDecodeError);
  });

  test('an out-of-range slot is rejected before it can pin a replica', () => {
    // Max never decreases, so accepting this once fixes that replica's
    // counter at the ceiling for the lifetime of the data.
    expect(() => GCounter.fromJSON(wire({ kind: 'GCounter', state: { a: Number.MAX_VALUE } })))
      .toThrow(CrdtDecodeError);
    expect(() => GCounter.fromJSON(wire({ kind: 'GCounter', state: { a: Infinity } })))
      .toThrow(CrdtDecodeError);
    expect(() => GCounter.fromJSON(wire({ kind: 'GCounter', state: { a: NaN } })))
      .toThrow(CrdtDecodeError);
  });

  test('a missing or non-object state is rejected', () => {
    expect(() => GCounter.fromJSON(wire({ kind: 'GCounter' }))).toThrow(CrdtDecodeError);
    expect(() => GCounter.fromJSON(wire({ kind: 'GCounter', state: null }))).toThrow(CrdtDecodeError);
    expect(() => GCounter.fromJSON(wire({ kind: 'GCounter', state: [1, 2] }))).toThrow(CrdtDecodeError);
  });

  test('a well-formed counter still decodes', () => {
    const counter = GCounter.fromJSON(wire({ kind: 'GCounter', state: { a: 3, b: 4 } }));
    expect(counter.value()).toBe(7);
  });
});

describe('GCounter slot ceiling (#720)', () => {
  test('MAX_SAFE_INTEGER is refused — being a safe integer was never a bound', () => {
    // The title's impact: `merge` is a componentwise max, so a slot accepted
    // once is that replica's floor for the lifetime of the key, and no exposed
    // API lowers it again.  `Number.MAX_SAFE_INTEGER` passes every other rule
    // in the decoder, which is exactly why it is the value the attack writes.
    expect(() => GCounter.fromJSON(wire({
      kind: 'GCounter', state: { 'sys@10.0.0.5:2552': Number.MAX_SAFE_INTEGER },
    }))).toThrow(CrdtDecodeError);
  });

  test('the ceiling itself decodes and the first value past it does not', () => {
    const atCeiling = GCounter.fromJSON(wire({
      kind: 'GCounter', state: { a: MAX_COUNTER_SLOT },
    }));
    expect(atCeiling.value()).toBe(MAX_COUNTER_SLOT);
    expect(() => GCounter.fromJSON(wire({
      kind: 'GCounter', state: { a: MAX_COUNTER_SLOT + 1 },
    }))).toThrow(CrdtDecodeError);
  });

  test('no wire-valid counter can sum outside the safe range', () => {
    // This is the property the ceiling is derived from, and the reason it is
    // not a taste judgement: the bound has to hold against the SUM, because
    // `value()` adds the slots and `safeEntries` admits MAX_CRDT_ENTRIES of
    // them.  Eight MAX_SAFE_INTEGER slots — well inside the entry cap — sum to
    // 72057594037927930, which is not a safe integer, so `value()` used to
    // return a rounded number from state every rule in the decoder had passed.
    const lossy: Record<string, number> = {};
    for (let i = 0; i < 8; i++) lossy[`r${i}`] = Number.MAX_SAFE_INTEGER;
    expect(() => GCounter.fromJSON(wire({ kind: 'GCounter', state: lossy })))
      .toThrow(CrdtDecodeError);

    // And the largest counter the decoder does accept still sums exactly, so
    // the ceiling is the tight bound rather than a round number under it.
    const state: Record<string, number> = {};
    for (let i = 0; i < MAX_CRDT_ENTRIES; i++) state[`r${i}`] = MAX_COUNTER_SLOT;
    const saturated = GCounter.fromJSON(wire({ kind: 'GCounter', state }));
    expect(Number.isSafeInteger(saturated.value())).toBe(true);
    expect(saturated.value()).toBe(MAX_CRDT_ENTRIES * MAX_COUNTER_SLOT);
  });

  test('the PNCounter frame from the exploit walkthrough is refused', () => {
    // Verbatim from the report: a decrement slot pinned at MAX_SAFE_INTEGER
    // made `value()` report ~-9e15 for a key the attacker never owned.
    expect(() => PNCounter.fromJSON(wire({
      kind: 'PNCounter',
      p: { kind: 'GCounter', state: {} },
      n: { kind: 'GCounter', state: { 'sys@10.0.0.7:2552': Number.MAX_SAFE_INTEGER } },
    }))).toThrow(CrdtDecodeError);
  });

  test('GCounterMap inherits the ceiling through its per-key counters', () => {
    expect(() => GCounterMap.fromJSON<string>(wire({
      kind: 'GCounterMap',
      counters: { '"sku-1"': { kind: 'GCounter', state: { a: Number.MAX_SAFE_INTEGER } } },
      keyValues: { '"sku-1"': '"sku-1"' },
    }))).toThrow(CrdtDecodeError);
  });

  test('a vector-clock entry is bounded by the same rule', () => {
    // Same shape of harm one type over: an entry claiming 2^53 - 1 writes
    // dominates every honest entry in `MVRegister.merge` and is never
    // superseded, so the register wedges on the attacker's value.
    expect(() => MVRegister.fromJSON(wire({
      kind: 'MVRegister', entries: [{ value: 1, vc: { a: Number.MAX_SAFE_INTEGER } }],
    }))).toThrow(CrdtDecodeError);
  });

  test('increment refuses to build a slot its own decoder would reject', () => {
    // A cap enforced only on the way in would be a new instance of the defect
    // it is meant to close: locally-legal state that gossips to nobody and
    // stops its own durable record reloading, with a warn line as its only
    // symptom.  The ceiling is a property of the type, so `empty`, `increment`
    // and `fromJSON` all agree on it.
    const nearly = GCounter.empty().increment('a', MAX_COUNTER_SLOT);
    expect(nearly.value()).toBe(MAX_COUNTER_SLOT);
    expect(() => nearly.increment('a', 1)).toThrow(/ceiling/);
    expect(() => GCounter.empty().increment('a', Number.MAX_SAFE_INTEGER)).toThrow(/ceiling/);
    // Whatever the local API accepts, the decoder accepts back.
    expect(GCounter.fromJSON(nearly.toJSON()).equals(nearly)).toBe(true);
  });

  test('the counters an application actually keeps are untouched', () => {
    // The bound is only worth having if it is invisible in ordinary use: a
    // billion page views per replica is four orders of magnitude clear of it.
    const busy = GCounter.empty().increment('sys@a:1', 1_000_000_000).increment('sys@b:1', 5);
    expect(GCounter.fromJSON(busy.toJSON()).value()).toBe(1_000_000_005);
  });
});

describe('LWWRegister timestamps (#724)', () => {
  test('a far-future timestamp is rejected', () => {
    // It would beat every honest write from now on — and be re-gossiped, so
    // the whole cluster converges on the wedge.
    const year3000 = Date.parse('3000-01-01T00:00:00Z');
    expect(() => LWWRegister.fromJSON(wire({
      kind: 'LWWRegister', value: 'x', timestamp: year3000, replica: 'evil',
    }))).toThrow(CrdtDecodeError);
  });

  test('a negative or non-numeric timestamp is rejected', () => {
    expect(() => LWWRegister.fromJSON(wire({
      kind: 'LWWRegister', value: 'x', timestamp: -1, replica: 'a',
    }))).toThrow(CrdtDecodeError);
    expect(() => LWWRegister.fromJSON(wire({
      kind: 'LWWRegister', value: 'x', timestamp: 'now', replica: 'a',
    }))).toThrow(CrdtDecodeError);
  });

  test('ordinary clock drift is still accepted', () => {
    // The bound has to tolerate real skew, or it becomes an availability bug
    // of its own on a cluster with imperfect NTP.
    const slightlyAhead = Date.now() + 30_000;
    const register = LWWRegister.fromJSON<string>(wire({
      kind: 'LWWRegister', value: 'x', timestamp: slightlyAhead, replica: 'a',
    }));
    expect(register.value()).toBe('x');
  });
});

describe('ORSet tombstones and tags (#722)', () => {
  test('a non-array tombstone list is rejected', () => {
    expect(() => ORSet.fromJSON(wire({
      kind: 'ORSet', elements: {}, tombstones: { a: 'not-an-array' },
    }))).toThrow(CrdtDecodeError);
  });

  test('a non-string tag inside a tombstone list is rejected', () => {
    // Tombstones are honoured on merge, so a malformed one is not inert —
    // it decides which of a peer's adds survive.
    expect(() => ORSet.fromJSON(wire({
      kind: 'ORSet', elements: {}, tombstones: { a: ['ok', 7] },
    }))).toThrow(CrdtDecodeError);
  });

  test('a well-formed set still decodes', () => {
    const set = ORSet.fromJSON<string>(wire({
      kind: 'ORSet',
      elements: { '"x"': ['a#1'] },
      elementValues: { '"x"': '"x"' },
      tombstones: {},
    }));
    expect(set.has('x')).toBe(true);
  });

  test("a pre-#722 peer's `counters` field is ignored, not rejected", () => {
    // Tags are minted from entropy now, so the sequence a legacy peer ships
    // has nothing to feed.  Dropping the whole set over an unread field would
    // stall a rolling upgrade in the one direction that still works.
    const set = ORSet.fromJSON<string>(wire({
      kind: 'ORSet',
      elements: { '"x"': ['a#1'] },
      elementValues: { '"x"': '"x"' },
      tombstones: {},
      counters: { a: 1 },
    }));
    expect(set.has('x')).toBe(true);
    expect('counters' in set.toJSON()).toBe(false);
  });
});

describe('MVRegister entry bounds (#698)', () => {
  test('an entry array over the cap is rejected', () => {
    // `merge` compares every entry against every other to find the causally
    // maximal ones — quadratic by nature, so the bound must be on the input.
    const entries = Array.from({ length: MAX_MV_REGISTER_ENTRIES + 1 }, (_, i) => ({
      value: 0, vc: { [`r${i}`]: 1 },
    }));
    expect(() => MVRegister.fromJSON(wire({ kind: 'MVRegister', entries })))
      .toThrow(CrdtDecodeError);
  });

  test('rejection is immediate, not after the quadratic scan', () => {
    // A decoder that built the register first and complained afterwards
    // would satisfy the test above while still burning the CPU.
    const entries = Array.from({ length: MAX_MV_REGISTER_ENTRIES + 1 }, (_, i) => ({
      value: 0, vc: { [`r${i}`]: 1 },
    }));
    const started = performance.now();
    expect(() => MVRegister.fromJSON(wire({ kind: 'MVRegister', entries })))
      .toThrow(CrdtDecodeError);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test('a malformed vector clock is rejected', () => {
    expect(() => MVRegister.fromJSON(wire({
      kind: 'MVRegister', entries: [{ value: 1, vc: { a: 'one' } }],
    }))).toThrow(CrdtDecodeError);
    expect(() => MVRegister.fromJSON(wire({
      kind: 'MVRegister', entries: [{ value: 1, vc: null }],
    }))).toThrow(CrdtDecodeError);
    expect(() => MVRegister.fromJSON(wire({
      kind: 'MVRegister', entries: 'not-an-array',
    }))).toThrow(CrdtDecodeError);
  });

  test('a well-formed register still decodes and merges', () => {
    const register = MVRegister.fromJSON<number>(wire({
      kind: 'MVRegister', entries: [{ value: 1, vc: { a: 1 } }],
    }));
    expect(register.values()).toEqual([1]);
  });
});

describe('prototype-polluting keys (#767)', () => {
  test('a __proto__ key is rejected rather than silently dropped later', () => {
    // Accepting it is the worst outcome: the entry lives in memory but every
    // `Record`-building re-encode omits it, so it never gossips and never
    // persists while this replica still believes it holds the key.
    expect(() => GCounter.fromJSON(wire({ kind: 'GCounter', state: { ['__proto__']: 1 } })))
      .toThrow(CrdtDecodeError);
  });
});

describe('decodeCrdt nesting (#721)', () => {
  test('deeply nested ORMaps are rejected before the stack goes', () => {
    let payload: Record<string, unknown> = { kind: 'GCounter', state: {} };
    for (let i = 0; i < 200; i++) {
      payload = {
        kind: 'ORMap',
        keyset: { kind: 'ORSet', elements: { '"k"': ['a#1'] }, elementValues: { '"k"': '"k"' }, tombstones: {} },
        values: { '"k"': payload },
      };
    }
    expect(() => decodeCrdt(wire(payload))).toThrow(CrdtDecodeError);
  });

  test('a non-object payload is rejected without a TypeError', () => {
    expect(() => decodeCrdt(wire(null))).toThrow(CrdtDecodeError);
    expect(() => decodeCrdt(wire('GCounter'))).toThrow(CrdtDecodeError);
  });

  test('ordinary nesting still decodes', () => {
    const decoded = decodeCrdt(wire({ kind: 'GCounter', state: { a: 2 } }));
    expect((decoded as GCounter).value()).toBe(2);
  });
});

describe('LWWRegister replica ids (#724)', () => {
  const now = Date.now();

  test('a non-string replica id is rejected', () => {
    // `ReplicaId` is a bare `type ReplicaId = string`, so nothing at runtime
    // stopped the wire from carrying something else into the tie-break.
    for (const replica of [5, null, { id: 'a' }, ['\uFFFF'], true]) {
      expect(() => LWWRegister.fromJSON(wire({
        kind: 'LWWRegister', value: 'x', timestamp: now, replica,
      }))).toThrow(CrdtDecodeError);
    }
  });

  test('the two failures it closes are opposite, and both reachable', () => {
    // A number: `>` between a string and a number is false in BOTH
    // directions, so `a.merge(b)` and `b.merge(a)` each keep their own value
    // and the replicas never converge on that key.
    expect((5 as unknown as string) > 'sys@a:1').toBe(false);
    expect('sys@a:1' > (5 as unknown as string)).toBe(false);
    // An array: coerces to its single element, so it wins every tie while
    // not being a string — exploit step 3, delivered past a `typeof` check
    // that was never there.
    expect((['\uFFFF'] as unknown as string) > 'sys@a:1').toBe(true);
  });

  test('an LWWMap entry inherits the check', () => {
    // Every map entry funnels through `LWWRegister.fromJSON`, and a map is
    // the realistic carrier — feature flags, per-user settings.
    expect(() => LWWMap.fromJSON(wire({
      kind: 'LWWMap',
      registers: { '"flag"': { kind: 'LWWRegister', value: false, timestamp: now, replica: 7 } },
      keyValues: { '"flag"': '"flag"' },
    }))).toThrow(CrdtDecodeError);
  });

  test('a well-formed register, and an empty one, still decode', () => {
    const register = LWWRegister.fromJSON<string>(wire({
      kind: 'LWWRegister', value: 'x', timestamp: now, replica: 'sys@a:1',
    }));
    expect(register.value()).toBe('x');
    // `LWWRegister.empty()` stamps `replica: ''` — a string, and it has to
    // keep round-tripping or every never-assigned register stops decoding.
    expect(LWWRegister.fromJSON<string>(wire(LWWRegister.empty<string>().toJSON())).value())
      .toBeNull();
  });
});
