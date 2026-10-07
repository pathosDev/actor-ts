/**
 * The grouped projection handler (#1448): `handleGroup` instead of `handle`.
 *
 * Under test here is the mechanism — how one tick's events become groups and
 * how the cursor follows them — and the handler-slot rules the two factories
 * enforce.  What a group does when its handler throws is in
 * `ProjectionFailureStrategy.test.ts`, beside the per-event strategies it
 * falls back to.
 *
 * Every projection here runs on a {@link ManualScheduler} that nothing
 * advances unless a test says so, which turns "in one tick" into an assertion:
 * the only tick that runs by itself is the one `preStart` sends.
 *
 * Validation runs in the factories, on the merged settings, so a rejected
 * projection never spawns: an actor that throws in its constructor is a
 * supervised failure the caller cannot see, and `persistence/projection`
 * inherits the restarting default.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ActorStopped } from '../../../src/SystemMessages.js';
import { DEFAULT_PROJECTION_GROUP_AFTER_ENVELOPES } from '../../../src/persistence/index.js';
import type { PersistentEvent } from '../../../src/persistence/JournalTypes.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { InMemoryOffsetStore } from '../../../src/persistence/projection/OffsetStore.js';
import { ProjectionActor } from '../../../src/persistence/projection/ProjectionActor.js';
import {
  ByPersistenceIdProjectionOptions,
  ByTagProjectionOptions,
  type ProjectionOptionsType,
} from '../../../src/persistence/projection/ProjectionOptions.js';
import { InMemoryQuery } from '../../../src/persistence/query/InMemoryQuery.js';
import type { Offset } from '../../../src/persistence/query/PersistenceQuery.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

type CountedEvent = { n: number };

/* ------------------------------- harness ------------------------------- */

/** Every cursor save, in order, on top of the real in-memory store. */
class RecordingOffsetStore extends InMemoryOffsetStore {
  readonly sequenceSaves: number[] = [];
  readonly offsetSaves: Offset[] = [];

  override async saveSequence(projection: string, persistenceId: string, seqNr: number): Promise<void> {
    this.sequenceSaves.push(seqNr);
    await super.saveSequence(projection, persistenceId, seqNr);
  }

  override async saveOffset(projection: string, tag: string, offset: Offset): Promise<void> {
    this.offsetSaves.push(offset);
    await super.saveOffset(projection, tag, offset);
  }
}

/** Collects `ActorStopped`, so a test can tell when a projection has really gone. */
class StoppedCollector extends Actor<unknown> {
  constructor(private readonly sink: string[]) { super(); }
  override onReceive(message: unknown): void {
    if (message instanceof ActorStopped) this.sink.push(message.actor.path.toString());
  }
}

type Fixture = {
  readonly system: ActorSystem;
  readonly scheduler: ManualScheduler;
  readonly journal: InMemoryJournal;
  readonly query: InMemoryQuery;
  readonly offsetStore: RecordingOffsetStore;
  readonly stoppedPaths: string[];
  /** How many times a tick asked the query layer for events. */
  readonly polls: () => number;
};

function newFixture(name: string): Fixture {
  const scheduler = new ManualScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(scheduler);
  const system = ActorSystem.create(name, systemOptions);
  const stoppedPaths: string[] = [];
  system.eventStream.subscribe(
    system.spawnAnonymous(() => new StoppedCollector(stoppedPaths)),
    ActorStopped,
  );

  const journal = new InMemoryJournal();
  const query = new InMemoryQuery(journal);
  let polls = 0;
  const currentEventsByPersistenceId = query.currentEventsByPersistenceId.bind(query);
  query.currentEventsByPersistenceId = ((...args: Parameters<typeof currentEventsByPersistenceId>) => {
    polls++;
    return currentEventsByPersistenceId(...args);
  }) as typeof query.currentEventsByPersistenceId;
  const currentEventsByTag = query.currentEventsByTag.bind(query);
  query.currentEventsByTag = ((...args: Parameters<typeof currentEventsByTag>) => {
    polls++;
    return currentEventsByTag(...args);
  }) as typeof query.currentEventsByTag;

  return {
    system,
    scheduler,
    journal,
    query,
    offsetStore: new RecordingOffsetStore(),
    stoppedPaths,
    polls: () => polls,
  };
}

/** `count` events on one stream, `n` = 1..count, all tagged `orders`. */
async function seed(journal: InMemoryJournal, persistenceId: string, count: number, from = 1): Promise<void> {
  const entries = [];
  for (let n = from; n < from + count; n++) entries.push({ event: { n }, tags: ['orders'] });
  await journal.append(persistenceId, entries, from - 1);
}

const numbersOf = (events: ReadonlyArray<PersistentEvent<CountedEvent>>): number[] =>
  events.map((event) => event.event.n);

/**
 * The mailbox is real even though the clock is not, so a tick the scheduler
 * released still completes asynchronously — poll for the expected outcome.
 */
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  await awaitCondition(predicate, {
    timeoutMs: 2_000,
    intervalMs: 2,
    label: 'the projection reached the awaited state',
  });
}

/* --------------------------- the group shape --------------------------- */

describe('handleGroup — one tick, cut into groups of groupAfterEnvelopes', () => {
  test('7 events with groupAfterEnvelopes 3 arrive as 3, 3, 1, all in the first tick', async () => {
    const fixture = newFixture('proj-group-shape');
    await seed(fixture.journal, 'stream', 7);

    const groups: number[][] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('group-shape')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('stream')
      .withGroupAfterEnvelopes(3)
      .withHandleGroup((events) => { groups.push(numbersOf(events)); });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(async () => (await fixture.offsetStore.loadSequence('group-shape', 'stream')) === 7);

    // Nothing is held back to fill a group: the short tail goes out in the
    // same tick, and that tick was the only one — the scheduler never moved.
    expect(groups).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(fixture.polls()).toBe(1);

    ref.stop();
    await fixture.system.terminate();
  });

  test('a group projection commits once per group, to the group\'s last sequenceNr', async () => {
    const fixture = newFixture('proj-group-commit-pid');
    await seed(fixture.journal, 'stream', 7);

    let calls = 0;
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('group-commit-pid')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('stream')
      .withGroupAfterEnvelopes(3)
      .withHandleGroup(() => { calls++; });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(async () => (await fixture.offsetStore.loadSequence('group-commit-pid', 'stream')) === 7);
    expect(calls).toBe(3);
    // Not 1..7: the saves in between would carry nothing a monotonic cursor
    // needs, and saving less often is half of what grouping is for.
    expect(fixture.offsetStore.sequenceSaves).toEqual([3, 6, 7]);

    ref.stop();
    await fixture.system.terminate();
  });

  test('by tag: one save per group to its last offset, and the cursor event is dropped before grouping', async () => {
    const fixture = newFixture('proj-group-commit-tag');
    // One append per stream, so the five share a timestamp and order by
    // sequenceNr — a defined order without waiting on the wall clock.
    await seed(fixture.journal, 'a', 5);

    const groups: number[][] = [];
    const projectionOptions = ByTagProjectionOptions.create<CountedEvent>()
      .withName('group-commit-tag')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withTag('orders')
      .withGroupAfterEnvelopes(2)
      .withHandleGroup((events) => { groups.push(numbersOf(events)); })
      .withLiveOptions({ pollIntervalMs: 100 });
    const ref = ProjectionActor.byTag<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => fixture.offsetStore.offsetSaves.length === 3);
    expect(groups).toEqual([[1, 2], [3, 4], [5]]);
    expect(fixture.offsetStore.offsetSaves.map((offset) => offset.sequenceNr)).toEqual([2, 4, 5]);

    // The by-tag query is inclusive of its cursor, so the next poll returns
    // n=5 again.  It has to be dropped *before* the events are cut into
    // groups — otherwise it is either delivered twice or it takes a slot and
    // shifts every group boundary after it.
    await seed(fixture.journal, 'a', 2, 6);
    fixture.scheduler.advance(100);
    await waitFor(() => fixture.offsetStore.offsetSaves.length === 4);
    expect(groups).toEqual([[1, 2], [3, 4], [5], [6, 7]]);
    expect(fixture.offsetStore.offsetSaves.map((offset) => offset.sequenceNr)).toEqual([2, 4, 5, 7]);

    ref.stop();
    await fixture.system.terminate();
  });

  test('without groupAfterEnvelopes the documented default sizes the groups', async () => {
    const fixture = newFixture('proj-group-default');
    await seed(fixture.journal, 'stream', 25);

    const sizes: number[] = [];
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('group-default')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('stream')
      .withHandleGroup((events) => { sizes.push(events.length); });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(async () => (await fixture.offsetStore.loadSequence('group-default', 'stream')) === 25);
    // The value projections.mdx quotes, in both languages — moving it is a
    // docs change as well as a code change.
    expect(DEFAULT_PROJECTION_GROUP_AFTER_ENVELOPES).toBe(20);
    expect(sizes).toEqual([20, 5]);

    ref.stop();
    await fixture.system.terminate();
  });

  test('a plain options object takes handleGroup just like the builder', async () => {
    const fixture = newFixture('proj-group-plain');
    await seed(fixture.journal, 'stream', 4);

    const groups: number[][] = [];
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, {
      name: 'group-plain',
      query: fixture.query,
      offsetStore: fixture.offsetStore,
      persistenceId: 'stream',
      groupAfterEnvelopes: 3,
      handleGroup: (events) => { groups.push(numbersOf(events)); },
    });

    await waitFor(async () => (await fixture.offsetStore.loadSequence('group-plain', 'stream')) === 4);
    expect(groups).toEqual([[1, 2, 3], [4]]);

    ref.stop();
    await fixture.system.terminate();
  });

  test('a stop that arrives mid-group lets the group and its commit finish first', async () => {
    const fixture = newFixture('proj-group-stop');
    await seed(fixture.journal, 'stream', 5);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    let finished = 0;
    const projectionOptions = ByPersistenceIdProjectionOptions.create<CountedEvent>()
      .withName('group-stop')
      .withQuery(fixture.query)
      .withOffsetStore(fixture.offsetStore)
      .withPersistenceId('stream')
      .withGroupAfterEnvelopes(5)
      .withHandleGroup(async () => {
        started++;
        await gate;
        finished++;
      });
    const ref = ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, projectionOptions);

    await waitFor(() => started === 1);
    ref.stop();
    // An absence has nothing to poll for: give the stop every chance to
    // overtake the group, then check that it did not.
    for (let turn = 0; turn < 15; turn++) await Bun.sleep(2);
    expect(fixture.stoppedPaths).not.toContain(ref.path.toString());
    expect(fixture.offsetStore.sequenceSaves).toEqual([]);

    release();
    await waitFor(() => fixture.stoppedPaths.includes(ref.path.toString()));
    expect(finished).toBe(1);
    expect(fixture.offsetStore.sequenceSaves).toEqual([5]);

    await fixture.system.terminate();
  });
});

/* ----------------------- the factories refuse it ----------------------- */

/**
 * Plain objects rather than builders, so one table can cover both factories:
 * the two builder classes share no base that carries `withHandle`.  Every
 * spawn gets its own name, because a projection that is accepted really
 * spawns, and two under one name would collide on the actor path.
 */
type Spawn = (fixture: Fixture, slot: Partial<ProjectionOptionsType<CountedEvent>>) => unknown;

let spawned = 0;
const factories: ReadonlyArray<readonly [string, Spawn]> = [
  ['byPersistenceId', (fixture, slot) => ProjectionActor.byPersistenceId<CountedEvent>(fixture.system, {
    name: `slot-pid-${++spawned}`, query: fixture.query, persistenceId: 'stream', ...slot,
  })],
  ['byTag', (fixture, slot) => ProjectionActor.byTag<CountedEvent>(fixture.system, {
    name: `slot-tag-${++spawned}`, query: fixture.query, tag: 'orders', ...slot,
  })],
];

const handle = (): void => {};
const handleGroup = (): void => {};

for (const [factory, spawn] of factories) {
  describe(`ProjectionActor.${factory} refuses a malformed handler slot with OptionsError`, () => {
    test('no handler at all', async () => {
      const fixture = newFixture(`proj-slot-none-${factory}`);
      // Accepted before #1448: the projection spawned, read its first event
      // and failed it with a TypeError the recovery strategy then retried.
      expect(() => spawn(fixture, {})).toThrow(OptionsError);
      expect(() => spawn(fixture, {})).toThrow(/handle or handleGroup must be set/);
      await fixture.system.terminate();
    });

    test('both handlers', async () => {
      const fixture = newFixture(`proj-slot-both-${factory}`);
      expect(() => spawn(fixture, { handle, handleGroup })).toThrow(OptionsError);
      expect(() => spawn(fixture, { handle, handleGroup })).toThrow(/handleGroup cannot be combined with handle/);
      await fixture.system.terminate();
    });

    test('a groupAfterEnvelopes that is not a positive integer', async () => {
      const fixture = newFixture(`proj-slot-size-${factory}`);
      for (const groupAfterEnvelopes of [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => spawn(fixture, { handleGroup, groupAfterEnvelopes }))
          .toThrow(/groupAfterEnvelopes must be an integer >= 1/);
      }
      await fixture.system.terminate();
    });

    test('an explicit groupAfterEnvelopes on a handle projection', async () => {
      const fixture = newFixture(`proj-slot-handle-size-${factory}`);
      // A size that silently did nothing would read as tuning that took effect.
      expect(() => spawn(fixture, { handle, groupAfterEnvelopes: 10 })).toThrow(OptionsError);
      expect(() => spawn(fixture, { handle, groupAfterEnvelopes: 10 }))
        .toThrow(/groupAfterEnvelopes applies only to handleGroup/);
      await fixture.system.terminate();
    });

    test('accepts handle alone, handleGroup alone, and handleGroup with a size of 1', async () => {
      const fixture = newFixture(`proj-slot-valid-${factory}`);
      expect(() => spawn(fixture, { handle })).not.toThrow();
      expect(() => spawn(fixture, { handleGroup })).not.toThrow();
      expect(() => spawn(fixture, { handleGroup, groupAfterEnvelopes: 1 })).not.toThrow();
      await fixture.system.terminate();
    });
  });
}
