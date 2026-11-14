/**
 * The lookback window plus deduplication behind every by-tag consumer (#957).
 *
 * The end-to-end proof — a slow writer's event delivered once by a projection
 * and by a live stream, on every backend — is the `LateCommit` scenario set of
 * the persistence contract.  What is under test here is the window's own
 * bookkeeping: that its state stays bounded, that a cursor from before the
 * window resumes without a replay, that a loaded cursor is not trusted
 * blindly, and that a grouped projection remembers every event of a group.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { PersistentEvent } from '../../../src/persistence/JournalTypes.js';
import { InMemoryJournal } from '../../../src/persistence/journals/InMemoryJournal.js';
import { InMemoryOffsetStore } from '../../../src/persistence/projection/OffsetStore.js';
import { ProjectionActor } from '../../../src/persistence/projection/ProjectionActor.js';
import { ByTagProjectionOptions } from '../../../src/persistence/projection/ProjectionOptions.js';
import { InMemoryQuery } from '../../../src/persistence/query/InMemoryQuery.js';
import { offsetOfEvent, offsetStart, type TaggedEvent } from '../../../src/persistence/query/PersistenceQuery.js';
import { TagLookbackWindow, type TagCursor } from '../../../src/persistence/query/TagLookbackWindow.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const WINDOW_MS = 1_000;

function eventOf(persistenceId: string, sequenceNr: number, timestamp: number): PersistentEvent<string> {
  return { persistenceId, sequenceNr, timestamp, event: `${persistenceId}#${sequenceNr}`, tags: ['t'] };
}

function tagged(event: PersistentEvent<string>): TaggedEvent<string> {
  return { event, offset: offsetOfEvent(event) };
}

const keysOf = (events: ReadonlyArray<TaggedEvent<string>>): string[] =>
  events.map((te) => `${te.event.persistenceId}#${te.event.sequenceNr}`);

describe('TagLookbackWindow', () => {
  test('reads one window behind the newest delivered stamp and drops what it delivered', () => {
    const window = TagLookbackWindow.startingAt(offsetStart, WINDOW_MS);
    const b1 = eventOf('b', 1, 10_000);
    window.markDelivered(b1);
    expect(window.readFrom().timestamp).toBe(10_000 - WINDOW_MS);

    const a1 = eventOf('a', 1, 9_500);
    expect(keysOf(window.admit([tagged(a1), tagged(b1)]))).toEqual(['a#1']);
  });

  test('keeps one mark per persistence id, and forgets it once it falls behind the window', () => {
    const window = TagLookbackWindow.startingAt(offsetStart, WINDOW_MS);
    for (let sequenceNr = 1; sequenceNr <= 50; sequenceNr++) window.markDelivered(eventOf('busy', sequenceNr, 1_000 + sequenceNr));
    window.markDelivered(eventOf('quiet', 1, 1_000));
    expect(window.cursor().delivered).toHaveLength(2);

    window.markDelivered(eventOf('later', 1, 5_000));
    // Both older marks lie behind 5_000 - 1_000: no read reaches them again.
    expect(window.cursor().delivered).toEqual([{ persistenceId: 'later', sequenceNr: 1, timestamp: 5_000 }]);
  });

  test('a clock stepping backwards inside one persistence id delivers both events, in sequence order', () => {
    const window = TagLookbackWindow.startingAt(offsetStart, WINDOW_MS);
    // Sequence 2 was stamped *before* sequence 1, so offset order puts it first.
    const admitted = window.admit([
      tagged(eventOf('p', 2, 4_000)),
      tagged(eventOf('q', 1, 4_500)),
      tagged(eventOf('p', 1, 5_000)),
    ]);
    expect(keysOf(admitted)).toEqual(['p#1', 'q#1', 'p#2']);
  });

  test('a cursor from before the window resumes as an inclusive floor — nothing behind it is replayed', () => {
    const plain: TagCursor = { timestamp: 10_000, persistenceId: 'b', sequenceNr: 1 };
    const window = TagLookbackWindow.resuming(plain, WINDOW_MS);
    expect(window.readFrom()).toEqual(plain);
    expect(keysOf(window.admit([
      tagged(eventOf('a', 1, 9_999)),
      tagged(eventOf('b', 1, 10_000)),
      tagged(eventOf('c', 1, 10_000)),
    ]))).toEqual(['c#1']);
    // Carried in the saved cursor until it falls behind the window.
    expect(window.cursor().floor).toEqual(plain);
    window.markDelivered(eventOf('d', 1, 12_000));
    expect(window.cursor().floor).toBeUndefined();
  });

  test('a saved window cursor resumes with its marks: a late event behind it is still delivered', () => {
    const first = TagLookbackWindow.resuming(offsetStart, WINDOW_MS);
    first.markDelivered(eventOf('b', 1, 10_000));
    const saved = JSON.parse(JSON.stringify(first.cursor())) as TagCursor;

    const resumed = TagLookbackWindow.resuming(saved, WINDOW_MS);
    expect(keysOf(resumed.admit([
      tagged(eventOf('a', 1, 9_500)),
      tagged(eventOf('b', 1, 10_000)),
    ]))).toEqual(['a#1']);
  });

  test('a malformed mark in a loaded cursor is dropped, and an id spelled __proto__ is just an id', () => {
    const loaded = JSON.parse(
      '{"timestamp":10000,"persistenceId":"b","sequenceNr":1,"delivered":['
      + '{"persistenceId":"__proto__","sequenceNr":3,"timestamp":9900},'
      + '{"persistenceId":"x","sequenceNr":"9","timestamp":9900},'
      + 'null]}',
    ) as TagCursor;
    const window = TagLookbackWindow.resuming(loaded, WINDOW_MS);
    expect(keysOf(window.admit([
      tagged(eventOf('__proto__', 3, 9_900)),
      tagged(eventOf('__proto__', 4, 9_950)),
      tagged(eventOf('x', 1, 9_900)),
    ]))).toEqual(['__proto__#4', 'x#1']);
    expect(({} as Record<string, unknown>).sequenceNr).toBeUndefined();
  });

  test('a stream start offset is inclusive: the event at it is delivered, the one before it is not', () => {
    const start = offsetOfEvent(eventOf('m', 1, 10_000));
    const window = TagLookbackWindow.startingAt(start, WINDOW_MS);
    expect(keysOf(window.admit([
      tagged(eventOf('a', 1, 10_000)),
      tagged(eventOf('m', 1, 10_000)),
      tagged(eventOf('z', 1, 10_000)),
    ]))).toEqual(['m#1', 'z#1']);
  });

  test('an event a single read returns twice is admitted once', () => {
    const window = TagLookbackWindow.startingAt(offsetStart, WINDOW_MS);
    const a1 = tagged(eventOf('a', 1, 1_000));
    expect(keysOf(window.admit([a1, a1]))).toEqual(['a#1']);
  });
});

describe('the push-driven eventsByTag stream around its catch-up read', () => {
  test('an event published while the catch-up read runs neither hides older ones nor arrives twice', async () => {
    const journal = new InMemoryJournal();
    await journal.append('p', [{ event: 'p1', tags: ['t'] }], 0);
    // Hold the catch-up read until the bus has published p2, so the bus event
    // arrives first and the catch-up then returns p1 *and* p2.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = journal.read.bind(journal);
    journal.read = (async (...args: Parameters<typeof read>) => {
      await gate;
      return read(...args);
    }) as typeof journal.read;

    const iterator = new InMemoryQuery(journal).eventsByTag<string>('t', offsetStart)[Symbol.asyncIterator]();
    const delivered: string[] = [];
    const pump = (async (): Promise<void> => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        delivered.push(next.value.event.event);
      }
    })();
    await journal.append('p', [{ event: 'p2', tags: ['t'] }], 1);
    release();
    await awaitCondition(() => delivered.length >= 2, { timeoutMs: 2_000, label: 'p1 and p2 reached the stream' });
    await iterator.return?.();
    await pump;

    expect(delivered).toEqual(['p1', 'p2']);
  });
});

describe('the push-driven eventsByPersistenceId stream around its catch-up read', () => {
  test('an event published while the catch-up read runs does not hide the older ones', async () => {
    // The by-id twin of the tag case above: the dedup there is a single
    // `lastEmittedSeq`, so a bus event emitted ahead of the catch-up moved it
    // past every event the catch-up was about to return.
    const journal = new InMemoryJournal();
    await journal.append('p', [{ event: 'p1' }, { event: 'p2' }], 0);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = journal.read.bind(journal);
    journal.read = (async (...args: Parameters<typeof read>) => {
      await gate;
      return read(...args);
    }) as typeof journal.read;

    const iterator = new InMemoryQuery(journal).eventsByPersistenceId<string>('p', 1)[Symbol.asyncIterator]();
    const delivered: string[] = [];
    const pump = (async (): Promise<void> => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        delivered.push(next.value.event);
      }
    })();
    await journal.append('p', [{ event: 'p3' }], 2);
    release();
    await awaitCondition(() => delivered.length >= 3, { timeoutMs: 2_000, label: 'p1, p2 and p3 reached the stream' });
    await iterator.return?.();
    await pump;

    expect(delivered).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('a grouped by-tag projection remembers every event of a group', () => {
  test('a late event inside a delivered group is not handled again on the next poll', async () => {
    const journal = new InMemoryJournal();
    const offsetStore = new InMemoryOffsetStore();
    // Nothing advances the clock unless the test does, so "one poll" is exact:
    // the late event and the new one are both in the journal before the tick
    // that reads them runs, and that tick hands them to one group.
    const scheduler = new ManualScheduler();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withScheduler(scheduler);
    const system = ActorSystem.create('tag-lookback-group', systemOptions);
    const pendingBaseline = scheduler.pendingCount;
    const nextTick = async (label: string): Promise<void> => {
      await awaitCondition(() => scheduler.pendingCount > pendingBaseline, { timeoutMs: 2_000, label });
      scheduler.advance(10);
    };
    const handled: string[] = [];
    const groups: string[][] = [];
    let polls = 0;
    const query = new InMemoryQuery(journal);
    const currentEventsByTag = query.currentEventsByTag.bind(query);
    query.currentEventsByTag = ((...args: Parameters<typeof currentEventsByTag>) => {
      polls++;
      return currentEventsByTag(...args);
    }) as typeof query.currentEventsByTag;

    await journal.append('b', [{ event: 'b1', tags: ['t'] }], 0);
    const projectionOptions = ByTagProjectionOptions.create<string>()
      .withName('group-late')
      .withQuery(query)
      .withOffsetStore(offsetStore)
      .withTag('t')
      .withHandleGroup((events) => {
        groups.push(events.map((event) => event.event));
        for (const event of events) handled.push(event.event);
      })
      .withLiveOptions({ pollIntervalMs: 10 });
    const ref = ProjectionActor.byTag<string>(system, projectionOptions);
    await awaitCondition(() => handled.includes('b1'), { timeoutMs: 2_000, label: 'b1 was handled' });

    // A late event and a new one land together, so the next poll hands both
    // to one group: [a1 (stamped behind the cursor), b2].
    const stampB = (await journal.read('b', 1))[0]!.timestamp;
    const realNow = Date.now;
    Date.now = () => stampB - 500;
    try {
      await journal.append('a', [{ event: 'a1', tags: ['t'] }], 0);
    } finally {
      Date.now = realNow;
    }
    await journal.append('b', [{ event: 'b2', tags: ['t'] }], 1);
    await nextTick('the tick after b1 was armed');
    await awaitCondition(() => handled.includes('b2'), { timeoutMs: 2_000, label: 'the group with a1 and b2 was handled' });
    expect(groups.at(-1)).toEqual(['a1', 'b2']);

    // Two more polls re-read the window, a1 included.
    for (const round of [1, 2]) {
      const pollsBefore = polls;
      await nextTick(`poll ${round} after the group was armed`);
      await awaitCondition(() => polls > pollsBefore, { timeoutMs: 2_000, label: `poll ${round} after the group ran` });
    }

    expect(handled).toEqual(['b1', 'a1', 'b2']);
    ref.stop();
    await system.terminate();
  });
});
