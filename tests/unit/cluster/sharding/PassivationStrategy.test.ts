import { describe, expect, test } from 'bun:test';
import { createPassivationStrategy } from '../../../../src/cluster/sharding/PassivationStrategy.js';
import type {
  PassivationStrategy,
  PassivationStrategyConfig,
} from '../../../../src/cluster/sharding/PassivationStrategy.js';
import {
  DEFAULT_PASSIVATION_ADMISSION_FILTER,
  DEFAULT_PASSIVATION_ADMISSION_WINDOW_PROPORTION,
  DEFAULT_PASSIVATION_REPLACEMENT,
  DEFAULT_PASSIVATION_SEGMENTED_PROTECTED_PROPORTION,
  ENTITY_ADMISSION_FILTERS,
  ENTITY_REPLACEMENT_POLICIES,
} from '../../../../src/cluster/sharding/ShardingOptions.js';

/**
 * The replacement subsystem behind `actor-ts.sharding.passivation.*` (#848),
 * exercised without an `ActorSystem` — which is the point of the seam: the
 * strategy sees entity ids and nothing else, so what a policy decides is
 * assertable directly instead of through a cluster and a passivation round trip.
 *
 * `EntityPassivationStrategies.test.ts` is the other half: it proves the same
 * policies reach a live region through HOCON and change which entities survive.
 */

const strategyOf = (overrides: Partial<PassivationStrategyConfig> & { capacity: number }): PassivationStrategy => {
  const config: PassivationStrategyConfig = {
    replacement: DEFAULT_PASSIVATION_REPLACEMENT,
    segmentedProtectedProportion: DEFAULT_PASSIVATION_SEGMENTED_PROTECTED_PROPORTION,
    admissionWindowProportion: DEFAULT_PASSIVATION_ADMISSION_WINDOW_PROPORTION,
    admissionFilter: DEFAULT_PASSIVATION_ADMISSION_FILTER,
    ...overrides,
  };
  const strategy = createPassivationStrategy(config);
  if (strategy === null) throw new Error('expected a strategy for a positive capacity');
  return strategy;
};

/** Admit every id in order, collecting whatever each admission evicted. */
const admitAll = (strategy: PassivationStrategy, entityIds: readonly string[]): string[] => {
  const evicted: string[] = [];
  for (const entityId of entityIds) {
    const victim = strategy.admit(entityId);
    if (victim !== null) evicted.push(victim);
  }
  return evicted;
};

const idsFrom = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_unused, index) => `${prefix}-${index + 1}`);

describe('createPassivationStrategy', () => {
  test('an uncapped region gets no strategy at all', () => {
    // Not a style choice: `maxEntities = 0` is the shipped default, so this is
    // the overwhelmingly common region, and a strategy there would be a second
    // index of every resident entity — maintained on the routing hot path —
    // bounding nothing.
    expect(createPassivationStrategy({
      capacity: 0,
      replacement: 'segmented-least-recently-used',
      segmentedProtectedProportion: 0.8,
      admissionWindowProportion: 0.1,
      admissionFilter: 'frequency-sketch',
    })).toBeNull();
  });

  test('the shipped policy set is the narrow one #848 settled on', () => {
    // `most-recently-used` deliberately does not ship: no acceptance criterion
    // named it and nothing calls it.  Adding a value to this union later is not
    // a breaking change; removing one is — so the pin is on the narrow set.
    expect(ENTITY_REPLACEMENT_POLICIES).toEqual([
      'least-recently-used',
      'segmented-least-recently-used',
      'least-frequently-used',
    ]);
    expect(ENTITY_ADMISSION_FILTERS).toEqual(['off', 'frequency-sketch']);
  });
});

describe('least-recently-used', () => {
  test('nothing is evicted below the cap, and the coldest goes at it', () => {
    const strategy = strategyOf({ capacity: 3 });

    expect(admitAll(strategy, ['a', 'b', 'c'])).toEqual([]);
    expect(strategy.size).toBe(3);
    expect(strategy.admit('d')).toBe('a');
    expect(strategy.has('a')).toBe(false);
    expect(strategy.size).toBe(3);
  });

  test('a touch moves an entity out of the victim position', () => {
    const strategy = strategyOf({ capacity: 3 });
    admitAll(strategy, ['a', 'b', 'c']);

    strategy.touch('a');

    expect(strategy.admit('d')).toBe('b');
  });

  test('a removed entity frees its slot and is not evicted twice', () => {
    const strategy = strategyOf({ capacity: 3 });
    admitAll(strategy, ['a', 'b', 'c']);

    expect(strategy.remove('a')).toBe(true);
    expect(strategy.remove('a')).toBe(false);
    expect(strategy.admit('d')).toBeNull();
    expect(strategy.size).toBe(3);
  });

  test('a scan over cold ids evicts the whole hot set — the failure #848 exists for', () => {
    const strategy = strategyOf({ capacity: 12 });
    const hot = idsFrom('hot', 6);
    admitAll(strategy, hot);
    for (const entityId of hot) strategy.touch(entityId);

    admitAll(strategy, idsFrom('cold', 40));

    // Every one of them, not merely some: recency cannot tell "touched once,
    // ever" from "touched constantly until a moment ago".
    expect(hot.filter((entityId) => strategy.has(entityId))).toEqual([]);
  });
});

describe('segmented-least-recently-used', () => {
  const segmented = (capacity: number): PassivationStrategy =>
    strategyOf({ capacity, replacement: 'segmented-least-recently-used' });

  test('an entity seen twice survives a scan that evicts entities seen once', () => {
    // The acceptance criterion of #848, in isolation: same cap, same scan, same
    // hot set as the plain-LRU case above, which loses all six.
    const strategy = segmented(12);
    const hot = idsFrom('hot', 6);
    admitAll(strategy, hot);
    for (const entityId of hot) strategy.touch(entityId);

    admitAll(strategy, idsFrom('cold', 40));

    expect(hot.filter((entityId) => strategy.has(entityId))).toEqual(hot);
    expect(strategy.size).toBe(12);
  });

  test('eviction comes from probation while it has anyone to give', () => {
    const strategy = segmented(12);
    admitAll(strategy, idsFrom('hot', 6));
    for (const entityId of idsFrom('hot', 6)) strategy.touch(entityId);
    admitAll(strategy, idsFrom('cold', 6));

    // Twelve resident: six protected, six on probation.  The next arrival takes
    // the oldest probationer and leaves every protected entity alone.
    expect(strategy.admit('cold-7')).toBe('cold-1');
    expect(strategy.has('hot-1')).toBe(true);
  });

  test('an over-full protected segment demotes rather than evicts', () => {
    // Capacity 5 → protected 4, probation 1.  Promoting a fifth entity pushes
    // the coldest protected one back to probation instead of dropping it, so it
    // survives one more pass and is then judged like anything else.
    const strategy = segmented(5);
    const entities = idsFrom('e', 5);
    admitAll(strategy, entities);
    for (const entityId of entities) strategy.touch(entityId);

    expect(entities.filter((entityId) => strategy.has(entityId))).toEqual(entities);
    // `e-1` was demoted first and is the only probationer, so it is the victim —
    // demotion is a second chance, not an exemption.
    expect(strategy.admit('newcomer')).toBe('e-1');
    expect(strategy.has('e-2')).toBe(true);
  });

  test('a protected entity is still evictable once probation is empty', () => {
    // The edge `victim()` falls through for: a region whose probation has been
    // drained must still be able to name someone, or a full region would report
    // nobody to give up and stop enforcing the cap.
    const strategy = segmented(3);
    admitAll(strategy, ['a', 'b', 'c']);
    for (const entityId of ['a', 'b', 'c']) strategy.touch(entityId);
    for (const entityId of ['a', 'b', 'c']) strategy.touch(entityId);

    const victim = strategy.admit('d');

    expect(victim).not.toBeNull();
    expect(strategy.size).toBe(3);
  });
});

describe('least-frequently-used', () => {
  const frequent = (capacity: number): PassivationStrategy =>
    strategyOf({ capacity, replacement: 'least-frequently-used' });

  test('the least-used entity goes, however recently it arrived', () => {
    const strategy = frequent(4);
    admitAll(strategy, ['a', 'b', 'c', 'd']);
    for (let touch = 0; touch < 5; touch++) strategy.touch('a');

    // `a` is the oldest arrival and the busiest, so recency and frequency
    // disagree — which is the whole reason the policy exists.
    expect(strategy.admit('e')).toBe('b');
    expect(strategy.has('a')).toBe(true);
  });

  test('counters age, so yesterday-hot loses to now-hot', () => {
    // Capacity 2 → the halving pass fires every 20 accesses.  `a` takes 17 of
    // the first 18 and `b` catches up afterwards: on raw lifetime totals `a`
    // still leads 17 to 11 and `b` would be evicted, and it is the halving that
    // makes the recent traffic decide instead.
    const strategy = frequent(2);
    admitAll(strategy, ['a', 'b']);
    for (let touch = 0; touch < 16; touch++) strategy.touch('a');
    for (let touch = 0; touch < 2; touch++) strategy.touch('b');
    for (let touch = 0; touch < 8; touch++) strategy.touch('b');

    expect(strategy.admit('c')).toBe('a');
    expect(strategy.has('b')).toBe(true);
  });
});

describe('the admission window', () => {
  test('never refuses the entity being admitted', () => {
    // The contract the region depends on: it calls `admit` while creating that
    // entity to deliver a message to it, so "refuse the newcomer" is not an
    // outcome it can act on.
    const strategy = strategyOf({
      capacity: 10,
      admissionWindowProportion: 0.2,
      admissionFilter: 'frequency-sketch',
    });

    for (const entityId of idsFrom('e', 60)) {
      expect(strategy.admit(entityId)).not.toBe(entityId);
    }
    expect(strategy.size).toBe(10);
  });

  test('a window with no filter still evicts the incumbent victim', () => {
    const strategy = strategyOf({ capacity: 10, admissionWindowProportion: 0.2 });
    admitAll(strategy, idsFrom('e', 10));

    // Window holds e-9/e-10, main holds e-1…e-8.  e-9 falls out of the window
    // and displaces the main LRU, because nothing is judging it.
    expect(strategy.admit('e-11')).toBe('e-1');
    expect(strategy.has('e-9')).toBe(true);
  });
});

describe('the frequency-sketch admission filter', () => {
  const filtered = (): PassivationStrategy => strategyOf({
    capacity: 10,
    admissionWindowProportion: 0.2,
    admissionFilter: 'frequency-sketch',
  });

  test('a candidate no busier than the incumbent is the one that goes', () => {
    const strategy = filtered();
    admitAll(strategy, idsFrom('e', 10));
    for (let touch = 0; touch < 20; touch++) strategy.touch('e-1');

    // Exactly the sequence the unfiltered case above evicts `e-1` for.  Here
    // the candidate leaving the window has been seen once, the incumbent
    // twenty-one times, so the candidate loses.
    expect(strategy.admit('e-11')).toBe('e-9');
    expect(strategy.has('e-1')).toBe(true);
  });

  test('ties go to the incumbent', () => {
    // A scan produces an unbounded supply of ids tied at one access; letting
    // each of them displace a resident entity is the thrash the filter exists
    // to stop, so `<=` rather than `<` is load-bearing.
    const strategy = filtered();
    admitAll(strategy, idsFrom('e', 10));

    expect(strategy.admit('e-11')).toBe('e-9');
    expect(strategy.has('e-1')).toBe(true);
  });

  test('the sketch remembers an entity the region already evicted', () => {
    // What a cache cannot do on its own: the history of the entities it threw
    // away is exactly the history it needs to decide whether to take one back.
    const strategy = filtered();
    admitAll(strategy, idsFrom('e', 10));
    for (let touch = 0; touch < 20; touch++) strategy.touch('e-1');
    strategy.remove('e-1');

    strategy.admit('e-1');       // back in, at the window's most-recent end
    strategy.admit('new-1');     // pushes e-10 out of the window; e-1 stays
    const victim = strategy.admit('new-2'); // now e-1 is the candidate

    // It out-ranks the main region's coldest entity by twenty accesses, so the
    // incumbent goes and `e-1` is admitted.
    expect(victim).toBe('e-2');
    expect(strategy.has('e-1')).toBe(true);
  });

  test('a filter without a window is inert rather than able to refuse a newcomer', () => {
    // `ShardingOptionsValidator` rejects this pair, so it is unreachable through
    // options or HOCON; a directly-constructed region is the case, and the
    // strategy degrades to plain replacement rather than to refusing the entity
    // a message is waiting on.
    const strategy = strategyOf({
      capacity: 3,
      admissionWindowProportion: 0,
      admissionFilter: 'frequency-sketch',
    });
    admitAll(strategy, ['a', 'b', 'c']);
    for (let touch = 0; touch < 20; touch++) strategy.touch('a');

    expect(strategy.admit('d')).toBe('b');
    expect(strategy.has('d')).toBe(true);
  });
});
