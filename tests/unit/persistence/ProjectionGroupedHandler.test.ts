/**
 * The handler slot of a projection (#1448).
 *
 * Validation runs in the two static factories, on the merged settings, so a
 * rejected projection never spawns: an actor that throws in its constructor is
 * a supervised failure the caller cannot see, and `persistence/projection`
 * inherits the restarting default.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { ProjectionActor } from '../../../src/persistence/projection/ProjectionActor.js';
import {
  ByPersistenceIdProjectionOptions,
  ByTagProjectionOptions,
} from '../../../src/persistence/projection/ProjectionOptions.js';
import { InMemoryQuery } from '../../../src/persistence/query/InMemoryQuery.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

type CountedEvent = { n: number };

type Fixture = {
  readonly system: ActorSystem;
  readonly journal: InMemoryJournal;
  readonly query: InMemoryQuery;
};

/**
 * A {@link ManualScheduler} so that only the first tick — the one `preStart`
 * sends itself — ever runs unless a test advances the clock.
 */
function newFixture(name: string): Fixture {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(new ManualScheduler());
  const system = ActorSystem.create(name, systemOptions);
  const journal = new InMemoryJournal();
  return { system, journal, query: new InMemoryQuery(journal) };
}

/* ----------------------- the factories refuse it ----------------------- */

describe('a projection without a handler is refused at the factory', () => {
  test('byPersistenceId throws OptionsError instead of spawning', async () => {
    const fixture = newFixture('proj-no-handler-pid');
    // Accepted before #1448: the projection spawned, read its first event and
    // failed it with a TypeError the recovery strategy then retried.
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('handlerless-pid')
      .withQuery(fixture.query)
      .withPersistenceId('stream');
    expect(() => ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions))
      .toThrow(OptionsError);
    expect(() => ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions))
      .toThrow(/handle/);
    await fixture.system.terminate();
  });

  test('byTag throws OptionsError instead of spawning', async () => {
    const fixture = newFixture('proj-no-handler-tag');
    const projectionOptions = ByTagProjectionOptions.create<CountedEvent>()
      .withName('handlerless-tag')
      .withQuery(fixture.query)
      .withTag('orders');
    expect(() => ProjectionActor.byTag<CountedEvent>(fixture.system, projectionOptions))
      .toThrow(OptionsError);
    await fixture.system.terminate();
  });
});
