/**
 * As with the 1:1 sibling, the load-bearing test is `expectConsistent`
 * rather than any single case: every defect this class exists to prevent is
 * the same defect, one direction updated and the other not.
 *
 * It carries one assertion the sibling's version cannot have — that **no
 * participant is left holding an empty set**.  For a many-to-many relation
 * that is where the leak lives: dropping a subscriber's last topic and
 * leaving the topic behind with an empty subscriber set is invisible to a
 * pair-count check, keeps the topic occupying a cap, and lets
 * `inverse()` hand out a participant that is related to nothing.
 */
import { describe, expect, test } from 'bun:test';
import { BidirectionalMultiMap } from '../../../src/util/BidirectionalMultiMap.js';

/** Asserts the whole contract: both directions agree, and no participant is empty. */
function expectConsistent<L, R>(map: BidirectionalMultiMap<L, R>): void {
  const forwardPairs = [...map.entries()];
  expect(forwardPairs).toHaveLength(map.size);

  // Every forward pair is answerable from the right-hand side too.
  for (const [left, right] of forwardPairs) {
    expect(map.has(left, right)).toBe(true);
    expect(map.hasLeft(left)).toBe(true);
    expect(map.hasRight(right)).toBe(true);
    expect(map.getKeys(right).has(left)).toBe(true);
    expect(map.get(left).has(right)).toBe(true);
  }

  // …and the reverse direction holds exactly the same pairs, no more.
  let reverseCount = 0;
  for (const right of map.rights()) {
    const holders = map.getKeys(right);
    // A participant with no partners must not exist at all.
    expect(holders.size).toBeGreaterThan(0);
    reverseCount += holders.size;
    for (const left of holders) expect(map.get(left).has(right)).toBe(true);
  }
  expect(reverseCount).toBe(map.size);

  for (const left of map.lefts()) expect(map.get(left).size).toBeGreaterThan(0);
}

describe('BidirectionalMultiMap (#1037)', () => {
  test('starts empty and reports both directions as empty', () => {
    const map = new BidirectionalMultiMap<string, number>();
    expect(map.size).toBe(0);
    expect(map.get('absent').size).toBe(0);
    expect(map.getKeys(1).size).toBe(0);
    expectConsistent(map);
  });

  test('seeds from an iterable of pairs', () => {
    const map = new BidirectionalMultiMap([
      ['news', 'ada'],
      ['news', 'grace'],
      ['sport', 'ada'],
    ]);
    expect(map.size).toBe(3);
    expect([...map.get('news')]).toEqual(['ada', 'grace']);
    expect([...map.getKeys('ada')]).toEqual(['news', 'sport']);
    expectConsistent(map);
  });

  test('accepts null and undefined for the seed, like new Map(...)', () => {
    expect(new BidirectionalMultiMap<string, number>(null).size).toBe(0);
    expect(new BidirectionalMultiMap<string, number>(undefined).size).toBe(0);
  });

  test('a repeated pair is idempotent rather than counted twice', () => {
    const map = new BidirectionalMultiMap([
      ['news', 'ada'],
      ['news', 'ada'],
    ]);
    expect(map.size).toBe(1);
    map.add('news', 'ada');
    expect(map.size).toBe(1);
    expectConsistent(map);
  });

  test('size counts pairs, not participants', () => {
    const map = new BidirectionalMultiMap<string, string>();
    map.add('news', 'ada').add('news', 'grace').add('sport', 'ada');
    // Two lefts, two rights, three pairs.
    expect([...map.lefts()]).toHaveLength(2);
    expect([...map.rights()]).toHaveLength(2);
    expect(map.size).toBe(3);
  });

  test('add returns the map so calls chain', () => {
    const map = new BidirectionalMultiMap<string, string>();
    expect(map.add('a', 'x').add('b', 'y')).toBe(map);
    expect(map.size).toBe(2);
  });

  test('get returns an empty set for an absent participant, not undefined', () => {
    const map = new BidirectionalMultiMap<string, string>();
    // The point of the empty set: a caller iterates without a guard.
    let iterations = 0;
    for (const _ of map.get('absent')) iterations++;
    for (const _ of map.getKeys('absent')) iterations++;
    expect(iterations).toBe(0);
  });

  test('deleting a pair that is not there returns false and changes nothing', () => {
    const map = new BidirectionalMultiMap([['news', 'ada']]);
    expect(map.delete('news', 'grace')).toBe(false);
    expect(map.delete('sport', 'ada')).toBe(false);
    expect(map.size).toBe(1);
    expectConsistent(map);
  });

  test('clear empties both directions', () => {
    const map = new BidirectionalMultiMap([['news', 'ada'], ['sport', 'grace']]);
    map.clear();
    expect(map.size).toBe(0);
    expect(map.hasLeft('news')).toBe(false);
    expect(map.hasRight('ada')).toBe(false);
    expectConsistent(map);
  });
});

describe('BidirectionalMultiMap participant pruning (#1037)', () => {
  // The acceptance criterion: removing a participant from one side must
  // leave no reference to it on the other.  An empty set left behind is a
  // leak that a pair count alone cannot see.

  test('removing the last pair drops both participants outright', () => {
    const map = new BidirectionalMultiMap([['news', 'ada']]);
    expect(map.delete('news', 'ada')).toBe(true);

    expect(map.hasLeft('news')).toBe(false);
    expect(map.hasRight('ada')).toBe(false);
    expect([...map.lefts()]).toEqual([]);
    expect([...map.rights()]).toEqual([]);
    expectConsistent(map);
  });

  test('a participant with partners left over survives the delete', () => {
    const map = new BidirectionalMultiMap([['news', 'ada'], ['news', 'grace']]);
    map.delete('news', 'ada');

    expect(map.hasLeft('news')).toBe(true);
    expect(map.hasRight('ada')).toBe(false);
    expect([...map.get('news')]).toEqual(['grace']);
    expectConsistent(map);
  });

  test('a full subscribe/unsubscribe cycle leaves the relation genuinely empty', () => {
    const map = new BidirectionalMultiMap<string, string>();
    for (let round = 0; round < 100; round++) {
      map.add(`topic-${round % 5}`, `subscriber-${round}`);
      map.delete(`topic-${round % 5}`, `subscriber-${round}`);
    }
    expect(map.size).toBe(0);
    // Not merely "no pairs" — no leftover entries on either side.
    expect([...map.lefts()]).toEqual([]);
    expect([...map.rights()]).toEqual([]);
    expectConsistent(map);
  });

  test('re-adding a pruned participant works, and does not resurrect old partners', () => {
    const map = new BidirectionalMultiMap([['news', 'ada']]);
    map.delete('news', 'ada');
    map.add('news', 'grace');

    expect([...map.get('news')]).toEqual(['grace']);
    expect(map.has('news', 'ada')).toBe(false);
    expectConsistent(map);
  });
});

describe('BidirectionalMultiMap falsy participants (#1037)', () => {
  // Guards written as `if (partners)` instead of `if (has(...))` skip exactly
  // these, leaving the counterpart stranded — the sibling's original defect,
  // one degree harder because both sides are sets.
  const falsyValues: number[] = [0, Number.NaN, -0];

  test.each(falsyValues)('a left participant of %p pairs and unpairs cleanly', (falsy) => {
    const map = new BidirectionalMultiMap<number, string>();
    map.add(falsy, 'ada');

    expect(map.hasLeft(falsy)).toBe(true);
    expect(map.getKeys('ada').has(falsy)).toBe(true);
    expect(map.delete(falsy, 'ada')).toBe(true);
    expect(map.hasLeft(falsy)).toBe(false);
    expect(map.hasRight('ada')).toBe(false);
    expectConsistent(map);
  });

  test.each(falsyValues)('a right participant of %p pairs and unpairs cleanly', (falsy) => {
    const map = new BidirectionalMultiMap<string, number>();
    map.add('news', falsy);

    expect(map.hasRight(falsy)).toBe(true);
    expect(map.get('news').has(falsy)).toBe(true);
    expect(map.delete('news', falsy)).toBe(true);
    expect(map.hasRight(falsy)).toBe(false);
    expect(map.hasLeft('news')).toBe(false);
    expectConsistent(map);
  });

  test.each(falsyValues)('deleteRight of %p clears the pair, rather than reading as absent', (falsy) => {
    const map = new BidirectionalMultiMap<string, number>();
    map.add('news', falsy);
    map.add('sport', falsy);

    expect(map.deleteRight(falsy)).toBe(true);
    expect(map.size).toBe(0);
    expect(map.hasLeft('news')).toBe(false);
    expect(map.hasLeft('sport')).toBe(false);
    expectConsistent(map);
  });

  test('false and the empty string survive a full round', () => {
    const map = new BidirectionalMultiMap<string, boolean | string>();
    map.add('', false);
    map.add('', '');

    expect(map.has('', false)).toBe(true);
    expect(map.has('', '')).toBe(true);
    expect(map.size).toBe(2);
    expect(map.deleteLeft('')).toBe(true);
    expect(map.size).toBe(0);
    expectConsistent(map);
  });

  test('NaN matches by SameValueZero rather than ===', () => {
    const map = new BidirectionalMultiMap<number, number>();
    map.add(Number.NaN, Number.NaN);

    expect(map.has(Number.NaN, Number.NaN)).toBe(true);
    expect(map.get(Number.NaN).has(Number.NaN)).toBe(true);
    expectConsistent(map);
  });

  test('0 and -0 are the same participant', () => {
    const map = new BidirectionalMultiMap<number, number>();
    map.add(0, 0);

    expect(map.has(-0, -0)).toBe(true);
    expect(map.size).toBe(1);
    map.add(-0, -0);
    expect(map.size).toBe(1);
    expectConsistent(map);
  });
});

describe('BidirectionalMultiMap.deleteLeft / deleteRight (#1037)', () => {
  // The Terminated case: one participant stops, and has to leave no trace.

  test('deleteRight drops the participant from every partner it held', () => {
    const map = new BidirectionalMultiMap([
      ['news', 'ada'],
      ['sport', 'ada'],
      ['news', 'grace'],
    ]);

    expect(map.deleteRight('ada')).toBe(true);
    expect(map.size).toBe(1);
    expect(map.hasRight('ada')).toBe(false);
    // 'sport' had only ada, so it goes too; 'news' still has grace.
    expect(map.hasLeft('sport')).toBe(false);
    expect([...map.get('news')]).toEqual(['grace']);
    expectConsistent(map);
  });

  test('deleteLeft is the mirror image', () => {
    const map = new BidirectionalMultiMap([
      ['news', 'ada'],
      ['news', 'grace'],
      ['sport', 'ada'],
    ]);

    expect(map.deleteLeft('news')).toBe(true);
    expect(map.size).toBe(1);
    expect(map.hasLeft('news')).toBe(false);
    expect(map.hasRight('grace')).toBe(false);
    expect([...map.getKeys('ada')]).toEqual(['sport']);
    expectConsistent(map);
  });

  test('deleting an absent participant returns false and changes nothing', () => {
    const map = new BidirectionalMultiMap([['news', 'ada']]);
    expect(map.deleteLeft('sport')).toBe(false);
    expect(map.deleteRight('grace')).toBe(false);
    expect(map.size).toBe(1);
    expectConsistent(map);
  });

  test('deleteLeft on the only participant empties the relation entirely', () => {
    const map = new BidirectionalMultiMap([['news', 'ada'], ['news', 'grace']]);
    expect(map.deleteLeft('news')).toBe(true);
    expect(map.size).toBe(0);
    expect([...map.rights()]).toEqual([]);
    expectConsistent(map);
  });
});

describe('BidirectionalMultiMap iteration (#1037)', () => {
  test('spreads and iterates as [left, right] pairs', () => {
    const map = new BidirectionalMultiMap([['news', 'ada'], ['news', 'grace']]);
    expect([...map]).toEqual([['news', 'ada'], ['news', 'grace']]);
  });

  test('lefts and rights list participants once each, in insertion order', () => {
    const map = new BidirectionalMultiMap([
      ['news', 'ada'],
      ['sport', 'ada'],
      ['news', 'grace'],
    ]);
    expect([...map.lefts()]).toEqual(['news', 'sport']);
    expect([...map.rights()]).toEqual(['ada', 'grace']);
  });

  test('forEach hands the callback this map, not internal storage', () => {
    const map = new BidirectionalMultiMap([['news', 'ada']]);
    const seen: [string, string][] = [];
    map.forEach((right, left, handedBack) => {
      seen.push([left, right]);
      expect(handedBack).toBe(map);
    });
    expect(seen).toEqual([['news', 'ada']]);
  });

  test('forEach honours thisArg', () => {
    const map = new BidirectionalMultiMap([['news', 'ada']]);
    const context = { calls: 0 };
    map.forEach(function (this: typeof context) { this.calls++; }, context);
    expect(context.calls).toBe(1);
  });

  test('reports its own toStringTag', () => {
    const map = new BidirectionalMultiMap<string, string>();
    expect(Object.prototype.toString.call(map)).toBe('[object BidirectionalMultiMap]');
  });
});

describe('BidirectionalMultiMap.inverse (#1037)', () => {
  test('reads the relation the other way round', () => {
    const map = new BidirectionalMultiMap([['news', 'ada'], ['sport', 'ada']]);
    const inverse = map.inverse();

    expect([...inverse.get('ada')]).toEqual(['news', 'sport']);
    expect([...inverse.getKeys('news')]).toEqual(['ada']);
  });

  test('is a view: a write on one side shows up on the other', () => {
    const map = new BidirectionalMultiMap([['news', 'ada']]);
    const inverse = map.inverse();

    inverse.add('grace', 'sport');
    expect(map.has('sport', 'grace')).toBe(true);
    expectConsistent(map);
    expectConsistent(inverse);
  });

  test('size stays true on both sides — the counter is shared, not copied', () => {
    const map = new BidirectionalMultiMap([['news', 'ada']]);
    const inverse = map.inverse();

    inverse.add('grace', 'sport');
    expect(map.size).toBe(2);
    expect(inverse.size).toBe(2);

    map.deleteLeft('news');
    expect(inverse.size).toBe(1);
  });

  test('a deleteLeft through the view clears both directions', () => {
    const map = new BidirectionalMultiMap([['news', 'ada'], ['sport', 'ada']]);
    expect(map.inverse().deleteLeft('ada')).toBe(true);

    expect(map.size).toBe(0);
    expect([...map.lefts()]).toEqual([]);
    expectConsistent(map);
  });

  test('inverting twice restores the original orientation', () => {
    const map = new BidirectionalMultiMap([['news', 'ada']]);
    expect([...map.inverse().inverse().get('news')]).toEqual(['ada']);
  });
});

describe('BidirectionalMultiMap JSON round-trip (#1037)', () => {
  test('toJSON writes an adjacency list under a discriminating kind', () => {
    const map = new BidirectionalMultiMap([['news', 'ada'], ['news', 'grace']]);
    expect(map.toJSON()).toEqual({
      kind: 'BidirectionalMultiMap',
      entries: [['news', ['ada', 'grace']]],
    });
  });

  test('fromJSON rebuilds both directions', () => {
    const map = new BidirectionalMultiMap([['news', 'ada'], ['sport', 'ada']]);
    const restored = BidirectionalMultiMap.fromJSON(map.toJSON());

    // Never written to the wire — if this answers, it was genuinely rebuilt.
    expect([...restored.getKeys('ada')]).toEqual(['news', 'sport']);
    expect(restored.size).toBe(2);
    expectConsistent(restored);
  });

  test('survives JSON.stringify, which is what the cluster wire uses', () => {
    const map = new BidirectionalMultiMap([['news', 'ada']]);
    const restored = BidirectionalMultiMap.fromJSON(JSON.parse(JSON.stringify(map)));
    expect(restored.has('news', 'ada')).toBe(true);
  });

  test('fromJSON rejects a payload of the wrong kind', () => {
    expect(() => BidirectionalMultiMap.fromJSON({ kind: 'Nope', entries: [] } as never))
      .toThrow(/unexpected kind/);
  });

  test('fromJSON rejects entries that are not an array', () => {
    expect(() => BidirectionalMultiMap.fromJSON({ kind: 'BidirectionalMultiMap', entries: {} } as never))
      .toThrow(/must be an array of rows/);
  });

  test('fromJSON rejects a row that is not [left, right[]]', () => {
    expect(() => BidirectionalMultiMap.fromJSON(
      { kind: 'BidirectionalMultiMap', entries: [['news', 'ada']] } as never,
    )).toThrow(/\[left, right\[\]\]/);
  });

  test('a __proto__ participant stays an ordinary key and reaches no prototype', () => {
    const restored = BidirectionalMultiMap.fromJSON<string, string>({
      kind: 'BidirectionalMultiMap',
      entries: [['__proto__', ['polluted']]],
    });

    expect(restored.has('__proto__', 'polluted')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expectConsistent(restored);
  });

  test('duplicate rows in the payload are idempotent', () => {
    const restored = BidirectionalMultiMap.fromJSON<string, string>({
      kind: 'BidirectionalMultiMap',
      entries: [['news', ['ada', 'ada']], ['news', ['ada']]],
    });
    expect(restored.size).toBe(1);
    expectConsistent(restored);
  });
});
