/**
 * What a projection cannot run without, refused where the caller hands it
 * over (found while #1448).
 *
 * Both option shapes are `Partial` at the factories, so nothing in the type
 * system keeps a plain object — or a builder that never called `withQuery` —
 * from leaving a field out, and every gap below used to surface somewhere
 * worse than the call that caused it:
 *
 *   - no `query`: the projection spawned and every tick failed as a poll
 *     failure, retried on the backoff forever;
 *   - no `name`: it spawned as `undefined-<pid>`, delivered, and saved its
 *     cursor under the projection name `undefined` — the key every other
 *     unnamed projection of that entity reads and writes too;
 *   - no `persistenceId` / `tag`: the factory threw a `TypeError` out of the
 *     actor-name computation (`undefined is not an object`), naming no field;
 *   - a `handle` or `handleGroup` that is not a function (`null` from
 *     JavaScript): it passed the handler-slot rule, which only asks whether
 *     the field is `undefined`, and failed at the first event — where the
 *     recovery strategy retried it as though the event were at fault.
 *
 * Each is now an `OptionsError` naming the field, thrown synchronously by the
 * factory, so a rejected projection never spawns.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { ProjectionActor } from '../../../src/persistence/projection/ProjectionActor.js';
import {
  type ByPersistenceIdProjectionOptionsType,
  type ByTagProjectionOptionsType,
  ProjectionOptionsValidator,
} from '../../../src/persistence/projection/ProjectionOptions.js';
import { InMemoryQuery } from '../../../src/persistence/query/InMemoryQuery.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

type CountedEvent = { n: number };

/* ------------------------------- harness ------------------------------- */

type Fixture = {
  readonly system: ActorSystem;
  readonly query: InMemoryQuery;
};

/**
 * A ManualScheduler nothing advances: a projection that is accepted spawns
 * and runs the one tick `preStart` sends, and no test here waits for more.
 */
function newFixture(name: string): Fixture {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(new ManualScheduler());
  const system = ActorSystem.create(name, systemOptions);
  return { system, query: new InMemoryQuery(new InMemoryJournal()) };
}

/** The error `spawn` throws — failing the test if it throws none. */
function refusalOf(spawn: () => unknown): unknown {
  try {
    spawn();
  } catch (error) {
    return error;
  }
  throw new Error('the factory accepted the projection and spawned it');
}

/** The field an `OptionsError` names, or a description of whatever else was thrown. */
function refusedField(spawn: () => unknown): string {
  const error = refusalOf(spawn);
  if (!(error instanceof OptionsError)) return `not an OptionsError: ${String(error)}`;
  return error.field;
}

type Options = Partial<ByPersistenceIdProjectionOptionsType<CountedEvent> & ByTagProjectionOptionsType<CountedEvent>>;

/** `options` without `field` — absent, not present as `undefined`. */
function without(options: Options, field: keyof Options): Options {
  return Object.fromEntries(Object.entries(options).filter(([key]) => key !== field)) as Options;
}

/**
 * Plain objects rather than builders, so one table covers both factories —
 * the shape a JavaScript caller, and a TypeScript one passing a `Partial`,
 * actually hands over.  Every accepted spawn gets a name of its own: two
 * projections under one name would collide on the actor path.
 */
type Factory = {
  readonly name: string;
  readonly cursorField: 'persistenceId' | 'tag';
  readonly complete: (fixture: Fixture) => Options;
  readonly spawn: (fixture: Fixture, options: Options) => unknown;
};

let spawned = 0;
const handle = (): void => {};

const factories: readonly Factory[] = [
  {
    name: 'byPersistenceId',
    cursorField: 'persistenceId',
    complete: (fixture) => ({ name: `required-pid-${++spawned}`, query: fixture.query, persistenceId: 'stream', handle }),
    spawn: (fixture, options) => ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, options),
  },
  {
    name: 'byTag',
    cursorField: 'tag',
    complete: (fixture) => ({ name: `required-tag-${++spawned}`, query: fixture.query, tag: 'orders', handle }),
    spawn: (fixture, options) => ProjectionActor.byTag<CountedEvent>(fixture.system, options),
  },
];

/* ------------------------------ the factories ------------------------------ */

for (const factory of factories) {
  describe(`ProjectionActor.${factory.name} refuses an incomplete projection with OptionsError`, () => {
    test('the complete options spawn — the control every case below takes one field from', async () => {
      const fixture = newFixture(`proj-required-control-${factory.name}`);
      expect(() => factory.spawn(fixture, factory.complete(fixture))).not.toThrow();
      await fixture.system.terminate();
    });

    test('no name', async () => {
      const fixture = newFixture(`proj-required-name-${factory.name}`);
      const options = without(factory.complete(fixture), 'name');
      expect(refusedField(() => factory.spawn(fixture, options))).toBe('name');
      expect(() => factory.spawn(fixture, options)).toThrow(/name must be a non-empty string/);
      await fixture.system.terminate();
    });

    test('an empty name — the offset-store key prefix every unnamed projection would share', async () => {
      const fixture = newFixture(`proj-required-empty-name-${factory.name}`);
      const options = { ...factory.complete(fixture), name: '' };
      expect(refusedField(() => factory.spawn(fixture, options))).toBe('name');
      await fixture.system.terminate();
    });

    test('no query', async () => {
      const fixture = newFixture(`proj-required-query-${factory.name}`);
      const options = without(factory.complete(fixture), 'query');
      expect(refusedField(() => factory.spawn(fixture, options))).toBe('query');
      expect(() => factory.spawn(fixture, options)).toThrow(/query must be set/);
      await fixture.system.terminate();
    });

    test(`no ${factory.cursorField}`, async () => {
      const fixture = newFixture(`proj-required-cursor-${factory.name}`);
      const options = without(factory.complete(fixture), factory.cursorField);
      expect(refusedField(() => factory.spawn(fixture, options))).toBe(factory.cursorField);
      await fixture.system.terminate();
    });

    test('a handle that is not a function', async () => {
      const fixture = newFixture(`proj-required-handle-${factory.name}`);
      const options = { ...factory.complete(fixture), handle: null as never };
      expect(refusedField(() => factory.spawn(fixture, options))).toBe('handle');
      expect(() => factory.spawn(fixture, options)).toThrow(/handle must be a function \(got null\)/);
      await fixture.system.terminate();
    });

    test('a handleGroup that is not a function', async () => {
      const fixture = newFixture(`proj-required-handle-group-${factory.name}`);
      const options = { ...without(factory.complete(fixture), 'handle'), handleGroup: null as never };
      expect(refusedField(() => factory.spawn(fixture, options))).toBe('handleGroup');
      expect(() => factory.spawn(fixture, options)).toThrow(/handleGroup must be a function \(got null\)/);
      await fixture.system.terminate();
    });
  });
}

/* ---------------------- the arms beyond "absent" ---------------------- */

/**
 * The cases above take a field away.  Each case here is a value that is
 * present and still names nothing — and each spawned, or failed with a
 * `TypeError`, before the refusal existed.  None of them is implied by an
 * "absent" case: a rule narrowed to `=== undefined`, or to a presence check,
 * passes every case above and lets these through.
 */
const byPersistenceIdFactory = factories.find((factory) => factory.cursorField === 'persistenceId')!;
const byTagFactory = factories.find((factory) => factory.cursorField === 'tag')!;

describe('the factories refuse a present value that names nothing', () => {
  for (const factory of factories) {
    test(`${factory.name}: a null query — it spawned, and every poll failed`, async () => {
      const fixture = newFixture(`proj-required-null-query-${factory.name}`);
      const options = { ...factory.complete(fixture), query: null as never };
      expect(refusedField(() => factory.spawn(fixture, options))).toBe('query');
      expect(() => factory.spawn(fixture, options)).toThrow(/query must be set/);
      await fixture.system.terminate();
    });
  }

  test('byPersistenceId: an empty persistenceId — it spawned as `<name>-`, its cursor keyed `<name>|seq|`', async () => {
    const fixture = newFixture('proj-required-empty-pid');
    const options = { ...byPersistenceIdFactory.complete(fixture), persistenceId: '' };
    expect(refusedField(() => byPersistenceIdFactory.spawn(fixture, options))).toBe('persistenceId');
    await fixture.system.terminate();
  });

  test('byPersistenceId: a persistenceId that is not a string — it threw a TypeError naming no field', async () => {
    const fixture = newFixture('proj-required-number-pid');
    const options = { ...byPersistenceIdFactory.complete(fixture), persistenceId: 42 as never };
    expect(refusedField(() => byPersistenceIdFactory.spawn(fixture, options))).toBe('persistenceId');
    expect(() => byPersistenceIdFactory.spawn(fixture, options)).toThrow(/persistenceId must be a non-empty string/);
    await fixture.system.terminate();
  });

  test('byTag: a null tag — it threw a TypeError naming no field', async () => {
    const fixture = newFixture('proj-required-null-tag');
    const options = { ...byTagFactory.complete(fixture), tag: null as never };
    expect(refusedField(() => byTagFactory.spawn(fixture, options))).toBe('tag');
    expect(() => byTagFactory.spawn(fixture, options)).toThrow(/tag must be set/);
    await fixture.system.terminate();
  });
});

/* ----------------- a query or a filter no poll can use ----------------- */

/**
 * Present and non-null is still not enough.  Every poll calls one method of
 * the query — `currentEventsByPersistenceId` or `currentEventsByTag` — and a
 * by-tag poll hands its filter to the query layer's own rule first.  A query
 * without that method, or a filter that rule refuses, spawned and failed
 * every tick, retried on the backoff for good.  A 5 000-character tag is
 * TypeScript-valid, so this is not only a JavaScript caller's mistake.
 */
describe('the factories refuse a query or a tag filter that every poll would fail on', () => {
  for (const factory of factories) {
    test(`${factory.name}: an object that is not a query`, async () => {
      const fixture = newFixture(`proj-shape-query-${factory.name}`);
      const options = { ...factory.complete(fixture), query: {} as never };
      expect(refusedField(() => factory.spawn(fixture, options))).toBe('query');
      await fixture.system.terminate();
    });
  }

  test('a query that has only the other factory\'s poll method', async () => {
    // Each factory checks the method its own polls call — not "one of the two".
    const fixture = newFixture('proj-shape-query-crossed');
    const byPersistenceIdOnly = { currentEventsByPersistenceId: async () => [] } as never;
    const byTagOnly = { currentEventsByTag: async () => [] } as never;
    const byTag = { ...byTagFactory.complete(fixture), query: byPersistenceIdOnly };
    expect(refusedField(() => byTagFactory.spawn(fixture, byTag))).toBe('query');
    expect(() => byTagFactory.spawn(fixture, byTag)).toThrow(/currentEventsByTag/);
    const byPersistenceId = { ...byPersistenceIdFactory.complete(fixture), query: byTagOnly };
    expect(refusedField(() => byPersistenceIdFactory.spawn(fixture, byPersistenceId))).toBe('query');
    expect(() => byPersistenceIdFactory.spawn(fixture, byPersistenceId)).toThrow(/currentEventsByPersistenceId/);
    await fixture.system.terminate();
  });

  test('byTag: a tag longer than any stored tag can be', async () => {
    const fixture = newFixture('proj-shape-tag-long');
    const options = { ...byTagFactory.complete(fixture), tag: 'x'.repeat(5_000) };
    expect(refusedField(() => byTagFactory.spawn(fixture, options))).toBe('tag');
    // The query layer's own reason, not a second wording of its rule.
    expect(() => byTagFactory.spawn(fixture, options)).toThrow(/5000 characters, exceeding the 255-character limit/);
    await fixture.system.terminate();
  });

  test('byTag: an operator that is not a list', async () => {
    const fixture = newFixture('proj-shape-tag-operator');
    const options = { ...byTagFactory.complete(fixture), tag: { all: 'orders' } as never };
    expect(refusedField(() => byTagFactory.spawn(fixture, options))).toBe('tag');
    await fixture.system.terminate();
  });

  test('byTag: a tag that is neither a string nor a filter object', async () => {
    const fixture = newFixture('proj-shape-tag-number');
    const options = { ...byTagFactory.complete(fixture), tag: 42 as never };
    expect(refusedField(() => byTagFactory.spawn(fixture, options))).toBe('tag');
    await fixture.system.terminate();
  });

  test('byTag: every filter the query layer accepts still spawns — `{}` and an empty tag included', async () => {
    // The read side keeps an empty tag legal on purpose (it finds the `''`
    // bucket an older journal wrote), and `{}` matches every event: the
    // write side's stricter rules are not the ones a filter is held to.
    const fixture = newFixture('proj-shape-tag-accepted');
    for (const tag of [{}, { all: ['orders'], not: ['cancelled'] }, { any: [] }, '', { all: [''] }]) {
      const options = { ...byTagFactory.complete(fixture), tag };
      expect(() => byTagFactory.spawn(fixture, options)).not.toThrow();
    }
    await fixture.system.terminate();
  });
});

/* ------------------------------ the validator ------------------------------ */

describe('ProjectionOptionsValidator', () => {
  test('told the cursor field, it checks the options as that factory spawns them', () => {
    const forPersistenceId = new ProjectionOptionsValidator<CountedEvent>('persistenceId');
    expect(refusedField(() => forPersistenceId.validate({ handle }))).toBe('name');
    expect(refusedField(() => forPersistenceId.validate({ name: 'view', handle }))).toBe('query');
    const query = new InMemoryQuery(new InMemoryJournal());
    expect(refusedField(() => forPersistenceId.validate({ name: 'view', query, handle }))).toBe('persistenceId');

    const forTag = new ProjectionOptionsValidator<CountedEvent>('tag');
    expect(refusedField(() => forTag.validate({ name: 'view', query, handle }))).toBe('tag');

    // And a handler: the last field a spawned projection cannot run without.
    const noHandlerByPersistenceId = { name: 'view', query, persistenceId: 'stream' };
    expect(refusedField(() => forPersistenceId.validate(noHandlerByPersistenceId))).toBe('handle');
    const noHandlerByTag = { name: 'view', query, tag: 'orders' };
    expect(refusedField(() => forTag.validate(noHandlerByTag))).toBe('handle');
  });

  test('without one it checks only the values a partial options object carries', () => {
    // An application that validates a shared base — the strategy and budget
    // it spreads into several projections — before any of them has a name, a
    // cursor or a handler of its own.  v0.17.0 accepted all three; requiring
    // a handler here refused every one of them.
    const validator = new ProjectionOptionsValidator<CountedEvent>();
    expect(() => validator.validate({})).not.toThrow();
    expect(() => validator.validate({ maxRetries: 3 })).not.toThrow();
    expect(() => validator.validate({ recoveryStrategy: 'skip', retryBackoffMs: 500 })).not.toThrow();
    // The value checks still apply to what is there, the handler slot's too.
    expect(refusedField(() => validator.validate({ handle: 'not a function' as never }))).toBe('handle');
    expect(refusedField(() => validator.validate({ handle, handleGroup: handle }))).toBe('handleGroup');
    expect(refusedField(() => validator.validate({ handle, groupAfterEnvelopes: 5 }))).toBe('groupAfterEnvelopes');
  });
});
