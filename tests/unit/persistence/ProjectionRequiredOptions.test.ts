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
  });

  test('without one it checks only the values a partial options object carries', () => {
    // An application that validates a shared base — the strategy and budget
    // it spreads into several projections — before any of them has a name.
    const validator = new ProjectionOptionsValidator<CountedEvent>();
    expect(() => validator.validate({ handle, maxRetries: 5 })).not.toThrow();
    // The value checks still apply to what is there.
    expect(refusedField(() => validator.validate({ handle: 'not a function' as never }))).toBe('handle');
  });
});
