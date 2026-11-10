/**
 * What `this` is inside a projection's handler (#1448).
 *
 * Released v0.17.0 called `this.options.handle(event)`, so a method-shorthand
 * or `function` handler ran with the projection's options as `this` — the
 * object the factory spawned it with, every default filled in — and could read
 * `this.name`, `this.persistenceId` or `this.tag`.  TypeScript types it the
 * same way: a method in an object literal typed as the options gets the
 * options type as `this`.  The grouped-handler change kept the handler on the
 * actor and called it from there, which made `this` the projection actor, so
 * `this.name` read `undefined` without a word and the actor's internals
 * reached user code.
 *
 * An arrow function keeps its own `this`, which is why every documented
 * sample is unaffected either way and why no earlier test noticed.
 * `handleGroup` has the same binding on both of its paths: a group, and the
 * one event per call that a split range and a group of one are delivered as —
 * which reach the handler from two different call sites.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { InMemoryOffsetStore } from '../../../src/persistence/projection/OffsetStore.js';
import { ProjectionActor } from '../../../src/persistence/projection/ProjectionActor.js';
import type {
  ByPersistenceIdProjectionOptionsType,
  ByTagProjectionOptionsType,
} from '../../../src/persistence/projection/ProjectionOptions.js';
import { InMemoryQuery } from '../../../src/persistence/query/InMemoryQuery.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

type CountedEvent = { n: number };

/* ------------------------------- harness ------------------------------- */

type Fixture = {
  readonly system: ActorSystem;
  readonly journal: InMemoryJournal;
  readonly query: InMemoryQuery;
};

/**
 * A ManualScheduler nothing advances: every event below is in the journal
 * before the projection spawns, so the one tick `preStart` sends delivers all
 * of them, and a test waits only for that tick to finish.
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

/** `count` events `n` = 1, 2, … on `persistenceId`, each tagged `orders`. */
async function seed(journal: InMemoryJournal, persistenceId: string, count: number): Promise<void> {
  const entries = [];
  for (let n = 1; n <= count; n++) entries.push({ event: { n }, tags: ['orders'] });
  await journal.append(persistenceId, entries, 0);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  await awaitCondition(predicate, { label: 'the projection delivered every seeded event' });
}

/**
 * The checks every case makes on the receivers it collected: one object for
 * every call, not the actor, and the options object proper — it carries the
 * very handler that is running, and the recovery strategy the factory merged
 * in, which a copy of two or three identifying fields would not.
 */
function expectOptionsReceiver(
  receivers: ReadonlyArray<object>,
  slot: 'handle' | 'handleGroup',
  handler: unknown,
  recoveryStrategy: string,
): void {
  expect(new Set(receivers).size).toBe(1);
  const receiver = receivers[0] as Record<string, unknown>;
  expect(receiver).not.toBeInstanceOf(Actor);
  expect(receiver[slot]).toBe(handler);
  expect(receiver['recoveryStrategy']).toBe(recoveryStrategy);
}

/* -------------------------------- handle -------------------------------- */

describe('a projection calls handle with its options as this', () => {
  test('byPersistenceId: a method-shorthand handle reads this.name and this.persistenceId', async () => {
    const fixture = newFixture('proj-this-pid-handle');
    await seed(fixture.journal, 'stream', 2);

    const seen: string[] = [];
    const receivers: ByPersistenceIdProjectionOptionsType<CountedEvent>[] = [];
    const projectionOptions: ByPersistenceIdProjectionOptionsType<CountedEvent> = {
      name: 'this-pid-handle',
      query: fixture.query,
      offsetStore: new InMemoryOffsetStore(),
      persistenceId: 'stream',
      handle(event) {
        receivers.push(this);
        seen.push(`${this.name}/${this.persistenceId}#${event.event.n}`);
      },
    };
    ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);
    await waitFor(() => seen.length === 2);

    expect(seen).toEqual(['this-pid-handle/stream#1', 'this-pid-handle/stream#2']);
    // The built-in default: this projection set no strategy, so a receiver
    // carrying one is the merged options rather than the caller's object.
    expectOptionsReceiver(receivers, 'handle', projectionOptions.handle, 'retry-and-fail');

    await fixture.system.terminate();
  });

  test('byTag: a method-shorthand handle reads this.name and this.tag', async () => {
    const fixture = newFixture('proj-this-tag-handle');
    await seed(fixture.journal, 'stream', 2);

    const seen: string[] = [];
    const receivers: ByTagProjectionOptionsType<CountedEvent>[] = [];
    const projectionOptions: ByTagProjectionOptionsType<CountedEvent> = {
      name: 'this-tag-handle',
      query: fixture.query,
      offsetStore: new InMemoryOffsetStore(),
      tag: 'orders',
      handle(event) {
        receivers.push(this);
        seen.push(`${this.name}/${String(this.tag)}#${event.event.n}`);
      },
    };
    ProjectionActor.byTag<CountedEvent>(fixture.system, projectionOptions);
    await waitFor(() => seen.length === 2);

    expect(seen).toEqual(['this-tag-handle/orders#1', 'this-tag-handle/orders#2']);
    expectOptionsReceiver(receivers, 'handle', projectionOptions.handle, 'retry-and-fail');

    await fixture.system.terminate();
  });
});

/* ------------------------------ handleGroup ------------------------------ */

describe('a projection calls handleGroup with its options as this', () => {
  test('byPersistenceId: on a group, on a split range and on a group of one', async () => {
    const fixture = newFixture('proj-this-pid-group');
    await seed(fixture.journal, 'stream', 4);

    // [1, 2, 3] fails as a group only, so the skip strategy splits it and
    // each of its events comes again alone; n=4 is left as a group of one.
    // Both of those go through the per-event call site, not the group's.
    const seen: string[] = [];
    const receivers: ByPersistenceIdProjectionOptionsType<CountedEvent>[] = [];
    const projectionOptions: ByPersistenceIdProjectionOptionsType<CountedEvent> = {
      name: 'this-pid-group',
      query: fixture.query,
      offsetStore: new InMemoryOffsetStore(),
      persistenceId: 'stream',
      recoveryStrategy: 'skip',
      groupAfterEnvelopes: 3,
      handleGroup(events) {
        receivers.push(this);
        seen.push(`${this.name}/${this.persistenceId}:${events.map((each) => each.event.n).join(',')}`);
        if (events.length > 1) throw new Error('refused as a group');
      },
    };
    ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);
    await waitFor(() => seen.length === 5);

    expect(seen).toEqual([
      'this-pid-group/stream:1,2,3',
      'this-pid-group/stream:1',
      'this-pid-group/stream:2',
      'this-pid-group/stream:3',
      'this-pid-group/stream:4',
    ]);
    // One receiver across both call sites, and the strategy this projection set.
    expectOptionsReceiver(receivers, 'handleGroup', projectionOptions.handleGroup, 'skip');

    await fixture.system.terminate();
  });

  test('byTag: a method-shorthand handleGroup reads this.name and this.tag', async () => {
    const fixture = newFixture('proj-this-tag-group');
    await seed(fixture.journal, 'stream', 2);

    const seen: string[] = [];
    const receivers: ByTagProjectionOptionsType<CountedEvent>[] = [];
    const projectionOptions: ByTagProjectionOptionsType<CountedEvent> = {
      name: 'this-tag-group',
      query: fixture.query,
      offsetStore: new InMemoryOffsetStore(),
      tag: 'orders',
      groupAfterEnvelopes: 3,
      handleGroup(events) {
        receivers.push(this);
        seen.push(`${this.name}/${String(this.tag)}:${events.map((each) => each.event.n).join(',')}`);
      },
    };
    ProjectionActor.byTag<CountedEvent>(fixture.system, projectionOptions);
    await waitFor(() => seen.length === 1);

    expect(seen).toEqual(['this-tag-group/orders:1,2']);
    expectOptionsReceiver(receivers, 'handleGroup', projectionOptions.handleGroup, 'retry-and-fail');

    await fixture.system.terminate();
  });
});
