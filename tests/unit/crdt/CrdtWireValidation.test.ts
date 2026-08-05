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
import { CrdtDecodeError, MAX_MV_REGISTER_ENTRIES } from '../../../src/crdt/CrdtWireValidation.js';
import { GCounter } from '../../../src/crdt/GCounter.js';
import { LWWRegister } from '../../../src/crdt/LWWRegister.js';
import { MVRegister } from '../../../src/crdt/MVRegister.js';
import { ORSet } from '../../../src/crdt/ORSet.js';

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
      kind: 'ORSet', elements: {}, tombstones: { a: 'not-an-array' }, counters: {},
    }))).toThrow(CrdtDecodeError);
  });

  test('a non-string tag inside a tombstone list is rejected', () => {
    // Tombstones are honoured on merge, so a malformed one is not inert —
    // it decides which of a peer's adds survive.
    expect(() => ORSet.fromJSON(wire({
      kind: 'ORSet', elements: {}, tombstones: { a: ['ok', 7] }, counters: {},
    }))).toThrow(CrdtDecodeError);
  });

  test('an out-of-range counter is rejected', () => {
    expect(() => ORSet.fromJSON(wire({
      kind: 'ORSet', elements: {}, tombstones: {}, counters: { a: -3 },
    }))).toThrow(CrdtDecodeError);
  });

  test('a well-formed set still decodes', () => {
    const set = ORSet.fromJSON<string>(wire({
      kind: 'ORSet',
      elements: { '"x"': ['a#1'] },
      elementValues: { '"x"': '"x"' },
      tombstones: {},
      counters: { a: 1 },
    }));
    expect(set.has('x')).toBe(true);
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
        keyset: { kind: 'ORSet', elements: { '"k"': ['a#1'] }, elementValues: { '"k"': '"k"' }, tombstones: {}, counters: { a: 1 } },
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
