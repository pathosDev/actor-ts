/**
 * The load-bearing test here is `expectConsistent`, not any single case.
 *
 * Every defect this class was written to avoid is the same defect: one
 * direction is updated and the other is not, so the map keeps answering for a
 * pair that is no longer there.  Asserting the outcome of individual
 * operations catches only the combinations someone thought of; asserting the
 * whole invariant after every mutation catches the ones nobody did.  So
 * `expectConsistent` runs in nearly every test below.
 */
import { describe, expect, test } from 'bun:test';
import { BidirectionalMap } from '../../../src/util/BidirectionalMap.js';

/**
 * `-0` normalised to `0`, because the map compares by SameValueZero while
 * `expect(...).toBe(...)` compares by `Object.is`.  The two disagree on
 * exactly this value — and `Map` itself normalises `-0` when it is used as a
 * key, so the reverse direction stores `0` where the forward one stores `-0`.
 */
function normalize<T>(value: T): T | 0 {
  return Object.is(value, -0) ? 0 : value;
}

/** Asserts the whole contract: both directions agree, on every pair, both ways. */
function expectConsistent<K, V>(map: BidirectionalMap<K, V>): void {
  const forward = [...map.entries()];
  const reverse = [...map.reverseEntries()];

  // A stale entry on either side shows up here first — it is what makes the
  // reverse map outgrow the forward one.
  expect(forward).toHaveLength(map.size);
  expect(reverse).toHaveLength(map.size);

  for (const [key, value] of forward) {
    expect(map.has(key)).toBe(true);
    expect(map.hasValue(value)).toBe(true);
    expect(normalize(map.get(key))).toBe(normalize(value));
    expect(map.getKey(value)).toBe(key);
  }
  for (const [value, key] of reverse) {
    expect(map.has(key)).toBe(true);
    expect(map.hasValue(value)).toBe(true);
    expect(normalize(map.get(key))).toBe(normalize(value));
    expect(map.getKey(value)).toBe(key);
  }

  // The 1:1 accessors (#1199).  They are documented as always equal to `size`,
  // and asserting that here rather than in one case is what makes the claim
  // real: `valueSize` reads the reverse map, so on any path where a
  // hand-maintained inverse would drift, this is the assertion that catches it —
  // and the displacement suite drives every one of those paths.
  expect(map.keySize).toBe(map.size);
  expect(map.valueSize).toBe(map.size);
}

describe('BidirectionalMap (#1035)', () => {
  test('starts empty and reports both directions as empty', () => {
    const map = new BidirectionalMap<string, number>();
    expect(map.size).toBe(0);
    expectConsistent(map);
  });

  test('seeds from an iterable, like new Map(...)', () => {
    const map = new BidirectionalMap([
      ['a', 1],
      ['b', 2],
    ]);
    expect(map.size).toBe(2);
    expect(map.get('a')).toBe(1);
    expect(map.getKey(2)).toBe('b');
    expectConsistent(map);
  });

  test('accepts null and undefined for the seed, like new Map(...)', () => {
    expect(new BidirectionalMap<string, number>(null).size).toBe(0);
    expect(new BidirectionalMap<string, number>(undefined).size).toBe(0);
  });

  test('resolves duplicates in the seed last-wins rather than corrupting itself', () => {
    const map = new BidirectionalMap([
      ['a', 1],
      ['b', 1],
    ]);
    expect(map.size).toBe(1);
    expect(map.getKey(1)).toBe('b');
    expectConsistent(map);
  });
});

describe('BidirectionalMap falsy keys and values (#1035)', () => {
  // The original defect: guards written as `if (value)` instead of
  // `if (has(...))` skip exactly these, leaving the counterpart stranded.
  const falsyValues: number[] = [0, Number.NaN, -0];

  test.each(falsyValues)('overwriting a key whose value is %p clears the old reverse entry', (falsy) => {
    const map = new BidirectionalMap<string, number>();
    map.set('a', falsy);
    map.set('a', 99);

    expect(map.getKey(falsy)).toBeUndefined();
    expect(map.hasValue(falsy)).toBe(false);
    expect(map.size).toBe(1);
    expectConsistent(map);
  });

  test.each(falsyValues)('delete() of a key whose value is %p returns true and clears both sides', (falsy) => {
    const map = new BidirectionalMap<string, number>();
    map.set('a', falsy);

    expect(map.delete('a')).toBe(true);
    expect(map.hasValue(falsy)).toBe(false);
    expect(map.size).toBe(0);
    expectConsistent(map);
  });

  test('delete() of a key whose value is an empty string returns true and clears both sides', () => {
    const map = new BidirectionalMap<string, string>();
    map.set('a', '');

    expect(map.delete('a')).toBe(true);
    expect(map.hasValue('')).toBe(false);
    expectConsistent(map);
  });

  test('deleteValue() with a falsy key returns true and clears both sides', () => {
    const map = new BidirectionalMap<string, string>();
    map.set('', 'x');

    expect(map.deleteValue('x')).toBe(true);
    expect(map.has('')).toBe(false);
    expect(map.size).toBe(0);
    expectConsistent(map);
  });

  test('false and empty string survive a full round of set / get / getKey', () => {
    const map = new BidirectionalMap<string, boolean>();
    map.set('off', false);

    expect(map.get('off')).toBe(false);
    expect(map.getKey(false)).toBe('off');
    expect(map.hasValue(false)).toBe(true);
    expectConsistent(map);
  });

  test('NaN matches by SameValueZero rather than ===', () => {
    const map = new BidirectionalMap<string, number>();
    map.set('nan', Number.NaN);

    // `NaN === NaN` is false; the map must still find it.
    expect(map.getKey(Number.NaN)).toBe('nan');
    expect(map.hasValue(Number.NaN)).toBe(true);
    expectConsistent(map);
  });

  test('0 and -0 are the same value', () => {
    const map = new BidirectionalMap<string, number>();
    map.set('zero', -0);

    expect(map.getKey(0)).toBe('zero');
    expect(map.hasValue(0)).toBe(true);
    expectConsistent(map);
  });

  test('a key bound to undefined is distinguishable from an absent key', () => {
    const map = new BidirectionalMap<string, number | undefined>();
    map.set('a', undefined);

    expect(map.has('a')).toBe(true);
    expect(map.get('a')).toBeUndefined();
    expect(map.get('missing')).toBeUndefined();
    expect(map.has('missing')).toBe(false);
    expectConsistent(map);
  });
});

describe('BidirectionalMap displacement (#1035)', () => {
  test('binding a value that is already taken evicts the key that held it', () => {
    const map = new BidirectionalMap<string, number>();
    map.set('a', 1);
    map.set('b', 1);

    expect(map.size).toBe(1);
    expect(map.has('a')).toBe(false);
    expect(map.getKey(1)).toBe('b');
    // All three counts agree at 1 (#1199).  This is the displacement the class
    // docs single out, and the one place a forgotten reverse delete would leave
    // `valueSize` at 2 while `size` said 1 — the drift the type exists to make
    // impossible, now visible as a number rather than only as a stale lookup.
    expect(map.keySize).toBe(1);
    expect(map.valueSize).toBe(1);
    expectConsistent(map);
  });

  test('rebinding a key releases the value it held', () => {
    const map = new BidirectionalMap<string, number>();
    map.set('a', 1);
    map.set('a', 2);

    expect(map.size).toBe(1);
    expect(map.hasValue(1)).toBe(false);
    expect(map.getKey(2)).toBe('a');
    expectConsistent(map);
  });

  test('a crossing write evicts on both sides at once', () => {
    const map = new BidirectionalMap<string, number>();
    map.set('a', 1);
    map.set('b', 2);
    map.set('a', 2); // 'a' gives up 1, and 2 gives up 'b'

    expect(map.size).toBe(1);
    expect(map.has('b')).toBe(false);
    expect(map.hasValue(1)).toBe(false);
    expect(map.get('a')).toBe(2);
    expectConsistent(map);
  });

  test('writing the same pair twice is idempotent', () => {
    const map = new BidirectionalMap<string, number>();
    map.set('a', 1);
    map.set('a', 1);

    expect(map.size).toBe(1);
    expect(map.get('a')).toBe(1);
    expect(map.getKey(1)).toBe('a');
    expectConsistent(map);
  });

  test('set returns the map so calls chain', () => {
    const map = new BidirectionalMap<string, number>();
    expect(map.set('a', 1).set('b', 2)).toBe(map);
    expect(map.size).toBe(2);
  });

  test('clear empties both directions', () => {
    const map = new BidirectionalMap([
      ['a', 1],
      ['b', 2],
    ]);
    map.clear();

    expect(map.size).toBe(0);
    expect(map.getKey(1)).toBeUndefined();
    expectConsistent(map);
  });

  test('deleting a key that is not there returns false and changes nothing', () => {
    const map = new BidirectionalMap([['a', 1]]);
    expect(map.delete('missing')).toBe(false);
    expect(map.deleteValue(99)).toBe(false);
    expect(map.size).toBe(1);
    expectConsistent(map);
  });
});

describe('BidirectionalMap.trySet (#1035)', () => {
  test('binds and returns true when neither side is taken', () => {
    const map = new BidirectionalMap<string, number>();
    expect(map.trySet('a', 1)).toBe(true);
    expect(map.get('a')).toBe(1);
    expectConsistent(map);
  });

  test('refuses without mutating when the value is taken', () => {
    const map = new BidirectionalMap([['a', 1]]);

    expect(map.trySet('b', 1)).toBe(false);
    expect(map.size).toBe(1);
    expect(map.has('b')).toBe(false);
    expect(map.getKey(1)).toBe('a');
    expectConsistent(map);
  });

  test('refuses without mutating when the key is taken', () => {
    const map = new BidirectionalMap([['a', 1]]);

    expect(map.trySet('a', 2)).toBe(false);
    expect(map.size).toBe(1);
    expect(map.get('a')).toBe(1);
    expect(map.hasValue(2)).toBe(false);
    expectConsistent(map);
  });

  test('re-writing a pair that is already present succeeds and is a no-op', () => {
    const map = new BidirectionalMap([['a', 1]]);

    expect(map.trySet('a', 1)).toBe(true);
    expect(map.size).toBe(1);
    expectConsistent(map);
  });

  test('refuses on a falsy value that is taken, rather than treating it as free', () => {
    const map = new BidirectionalMap<string, number>();
    map.set('a', 0);

    expect(map.trySet('b', 0)).toBe(false);
    expect(map.getKey(0)).toBe('a');
    expectConsistent(map);
  });
});

describe('BidirectionalMap get-or-insert (#1035)', () => {
  test('getOrInsert returns the existing value without inserting', () => {
    const map = new BidirectionalMap([['a', 1]]);
    expect(map.getOrInsert('a', 99)).toBe(1);
    expect(map.hasValue(99)).toBe(false);
    expectConsistent(map);
  });

  test('getOrInsert inserts and returns the default when the key is absent', () => {
    const map = new BidirectionalMap<string, number>();
    expect(map.getOrInsert('a', 1)).toBe(1);
    expect(map.get('a')).toBe(1);
    expectConsistent(map);
  });

  test('getOrInsertComputed runs the callback only on the inserting path', () => {
    const map = new BidirectionalMap([['a', 1]]);
    let calls = 0;

    expect(map.getOrInsertComputed('a', () => (calls++, 99))).toBe(1);
    expect(calls).toBe(0);

    expect(map.getOrInsertComputed('b', () => (calls++, 2))).toBe(2);
    expect(calls).toBe(1);
    expectConsistent(map);
  });

  test('getOrInsertKey returns the key already bound to the value, not undefined', () => {
    const map = new BidirectionalMap([['a', 1]]);

    // The value is present under a different key: the answer is that key.
    expect(map.getOrInsertKey(1, 'z')).toBe('a');
    expect(map.has('z')).toBe(false);
    expect(map.size).toBe(1);
    expectConsistent(map);
  });

  test('getOrInsertKey inserts under the default key when the value is absent', () => {
    const map = new BidirectionalMap<string, number>();
    expect(map.getOrInsertKey(1, 'a')).toBe('a');
    expect(map.get('a')).toBe(1);
    expectConsistent(map);
  });

  test('getOrInsertComputedKey calls the callback exactly once when inserting', () => {
    const map = new BidirectionalMap<string, number>();
    let calls = 0;

    const key = map.getOrInsertComputedKey(7, (value) => (calls++, `key-${value}`));

    // Twice would mint a second identifier and return one that was never stored.
    expect(calls).toBe(1);
    expect(key).toBe('key-7');
    expect(map.get('key-7')).toBe(7);
    expectConsistent(map);
  });

  test('getOrInsertComputedKey does not call the callback when the value is present', () => {
    const map = new BidirectionalMap([['a', 1]]);
    let calls = 0;

    expect(map.getOrInsertComputedKey(1, () => (calls++, 'z'))).toBe('a');
    expect(calls).toBe(0);
    expectConsistent(map);
  });
});

describe('BidirectionalMap Map contract (#1035)', () => {
  test('is accepted by new Map(...)', () => {
    const map = new BidirectionalMap([
      ['a', 1],
      ['b', 2],
    ]);
    expect(new Map(map)).toEqual(
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
    );
  });

  test('spreads and iterates as [key, value] pairs', () => {
    const map = new BidirectionalMap([
      ['a', 1],
      ['b', 2],
    ]);
    expect([...map]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(Array.from(map.keys())).toEqual(['a', 'b']);
    expect(Array.from(map.values())).toEqual([1, 2]);
    expect(Array.from(map.reverseEntries())).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });

  test('is assignable to Map<K, V> and works through that type', () => {
    const asMap: Map<string, number> = new BidirectionalMap([['a', 1]]);
    expect(asMap.get('a')).toBe(1);
    expect(asMap.size).toBe(1);
  });

  test('reports its own toStringTag', () => {
    const map = new BidirectionalMap<string, number>();
    expect(Object.prototype.toString.call(map)).toBe('[object BidirectionalMap]');
  });

  test('forEach hands the callback this map, not the internal one', () => {
    const map = new BidirectionalMap([['a', 1]]);
    const seen: Array<[number, string, unknown]> = [];

    map.forEach((value, key, received) => seen.push([value, key, received]));

    expect(seen).toEqual([[1, 'a', map]]);
  });

  test('a callback deleting through the third argument keeps both sides in step', () => {
    // The whole point of not exposing the internal map: this used to remove
    // the forward entry and leave the reverse one behind.
    const map = new BidirectionalMap([['a', 1]]);

    map.forEach((_value, key, received) => received.delete(key));

    expect(map.size).toBe(0);
    expect(map.hasValue(1)).toBe(false);
    expectConsistent(map);
  });

  test('forEach honours thisArg', () => {
    const map = new BidirectionalMap([['a', 1]]);
    const context = { seen: [] as string[] };

    map.forEach(function (this: typeof context, _value, key) {
      this.seen.push(key);
    }, context);

    expect(context.seen).toEqual(['a']);
  });
});

describe('BidirectionalMap.inverse (#1035)', () => {
  test('reads the map the other way round', () => {
    const map = new BidirectionalMap([['a', 1]]);
    const inverse = map.inverse();

    expect(inverse.get(1)).toBe('a');
    expect(inverse.getKey('a')).toBe(1);
    expect(inverse.size).toBe(1);
    expectConsistent(inverse);
  });

  test('is a view: a write on one side shows up on the other', () => {
    const map = new BidirectionalMap<string, number>();
    const inverse = map.inverse();

    map.set('a', 1);
    expect(inverse.get(1)).toBe('a');

    inverse.set(2, 'b');
    expect(map.get('b')).toBe(2);

    expectConsistent(map);
    expectConsistent(inverse);
  });

  test('a delete through the view clears both directions', () => {
    const map = new BidirectionalMap([['a', 1]]);

    expect(map.inverse().delete(1)).toBe(true);
    expect(map.size).toBe(0);
    expect(map.has('a')).toBe(false);
    expectConsistent(map);
  });

  test('inverting twice restores the original orientation', () => {
    const map = new BidirectionalMap([['a', 1]]);
    const round = map.inverse().inverse();

    expect(round.get('a')).toBe(1);
    round.set('b', 2);
    expect(map.get('b')).toBe(2);
  });
});

describe('BidirectionalMap JSON round-trip (#1035)', () => {
  test('toJSON writes the forward pairs under a discriminating kind', () => {
    const map = new BidirectionalMap([
      ['a', 1],
      ['b', 2],
    ]);

    expect(map.toJSON()).toEqual({
      kind: 'BidirectionalMap',
      entries: [
        ['a', 1],
        ['b', 2],
      ],
    });
  });

  test('fromJSON rebuilds both directions', () => {
    const map = new BidirectionalMap([
      ['a', 1],
      ['b', 2],
    ]);
    const restored = BidirectionalMap.fromJSON(map.toJSON());

    expect(restored).toBeInstanceOf(BidirectionalMap);
    expect([...restored]).toEqual([...map]);
    expect(restored.getKey(2)).toBe('b');
    expectConsistent(restored);
  });

  test('survives JSON.stringify, which is what the cluster wire uses', () => {
    const map = new BidirectionalMap([['a', 1]]);
    const restored = BidirectionalMap.fromJSON(JSON.parse(JSON.stringify(map)));

    expect(restored.get('a')).toBe(1);
    expect(restored.getKey(1)).toBe('a');
    expectConsistent(restored);
  });

  test('fromJSON rejects a payload of the wrong kind', () => {
    expect(() => BidirectionalMap.fromJSON({ kind: 'ORMap', entries: [] } as never)).toThrow(
      /unexpected kind ORMap/,
    );
    expect(() => BidirectionalMap.fromJSON(null as never)).toThrow(/unexpected kind/);
  });

  test('fromJSON rejects entries that are not an array', () => {
    expect(() =>
      BidirectionalMap.fromJSON({ kind: 'BidirectionalMap', entries: 'nope' } as never),
    ).toThrow(/must be an array of pairs/);
  });

  test('a __proto__ key stays an ordinary key and reaches no prototype', () => {
    const map = BidirectionalMap.fromJSON<string, string>({
      kind: 'BidirectionalMap',
      entries: [['__proto__', 'polluted']],
    });

    expect(map.get('__proto__')).toBe('polluted');
    expect(map.getKey('polluted')).toBe('__proto__');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf(map)).toBe(BidirectionalMap.prototype);
    expectConsistent(map);
  });

  test('duplicate pairs in the payload resolve last-wins', () => {
    const map = BidirectionalMap.fromJSON<string, number>({
      kind: 'BidirectionalMap',
      entries: [
        ['a', 1],
        ['b', 1],
      ],
    });

    expect(map.size).toBe(1);
    expect(map.getKey(1)).toBe('b');
    expectConsistent(map);
  });
});
