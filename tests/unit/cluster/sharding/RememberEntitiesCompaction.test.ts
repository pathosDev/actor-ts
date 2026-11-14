/**
 * The remember-entities log is compacted, so a coordinator start replays a
 * bounded amount however long the type has churned (#649).
 *
 * `JournalRememberEntitiesStore` appended one event per entity start and stop
 * and `load()` read the stream from sequence 1, every time.  With passivation
 * on, every idle-then-wake cycle adds two events, and `ShardCoordinator`
 * awaits that whole replay before it handles a message — so the next leader
 * election blocked on the type's entire history.  The store now folds the
 * stream into one snapshot event once enough has been appended behind the last
 * one, and deletes the prefix the snapshot covers.
 *
 * Cost is measured as events, not milliseconds: what `load()` reads and what
 * the stream holds.  The coordinator's `preStart` replay *is* `load()` plus a
 * fold over what it returns, so a bound on the events is the bound on that
 * replay, and it holds on any machine.
 *
 * The delete never takes the snapshot with it: a stream compacted to nothing
 * is the shape #1052 refuses for an event-sourced actor, and here it would
 * silently forget every entity.
 */
import { describe, expect, test } from 'bun:test';
import { REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS } from '../../../../src/cluster/Constants.js';
import {
  JournalRememberEntitiesStore,
  type RememberEvent,
} from '../../../../src/cluster/sharding/RememberEntitiesStore.js';
import type { JournalEntry, PersistentEvent } from '../../../../src/persistence/JournalTypes.js';
import { InMemoryJournal } from '../../../../src/persistence/journals/InMemoryJournal.js';

const TYPE_NAME = 'orders';
const PERSISTENCE_ID = `sharding-coordinator-${TYPE_NAME}`;

/** An `InMemoryJournal` that counts the events every `read` returns. */
class CountingJournal extends InMemoryJournal {
  eventsRead = 0;

  override async read<E>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    const events = await super.read<E>(persistenceId, fromSeq, toSeq);
    this.eventsRead += events.length;
    return events;
  }
}

/** The live entity set `events` describe, as `shardId:entityId` strings. */
function liveSet(events: readonly RememberEvent[]): Set<string> {
  const live = new Set<string>();
  for (const event of events) {
    const key = `${event.shardId}:${event.entityId}`;
    if (event.kind === 'started') live.add(key);
    else live.delete(key);
  }
  return live;
}

/** Start and stop `pairs` distinct entities, leaving `kept` started ones behind first. */
async function churn(store: JournalRememberEntitiesStore, pairs: number, kept: number): Promise<Set<string>> {
  const expected = new Set<string>();
  for (let index = 0; index < kept; index++) {
    await store.append(TYPE_NAME, { kind: 'started', shardId: index % 7, entityId: `kept-${index}` });
    expected.add(`${index % 7}:kept-${index}`);
  }
  for (let index = 0; index < pairs; index++) {
    const shardId = index % 13;
    await store.append(TYPE_NAME, { kind: 'started', shardId, entityId: `churn-${index}` });
    await store.append(TYPE_NAME, { kind: 'stopped', shardId, entityId: `churn-${index}` });
  }
  return expected;
}

describe('JournalRememberEntitiesStore — compaction (#649)', () => {
  test('10 000 start/stop pairs leave a bounded stream, and load reads a bounded amount', async () => {
    const journal = new CountingJournal();
    const writer = new JournalRememberEntitiesStore(journal);
    const expected = await churn(writer, 10_000, 50);

    // What a fresh coordinator does in `preStart`: a new store, one load.
    const reader = new JournalRememberEntitiesStore(journal);
    journal.eventsRead = 0;
    const loaded = await reader.load(TYPE_NAME);

    expect(liveSet(loaded)).toEqual(expected);
    // One snapshot plus whatever was appended behind it, which stays under one
    // compaction interval.  Uncompacted this read 20 050 events.
    const bound = REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS + 1;
    expect(journal.eventsRead).toBeLessThanOrEqual(bound);
    expect((await journal.read(PERSISTENCE_ID, 1)).length).toBeLessThanOrEqual(bound);
    // The events load hands the coordinator are bounded too: the snapshot
    // expands to the live entities, then the tail follows.
    expect(loaded.length).toBeLessThanOrEqual(expected.size + REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS);
  });

  test('the cost does not grow with the history: ten times the churn reads no more', async () => {
    const short = new CountingJournal();
    await churn(new JournalRememberEntitiesStore(short), 1_000, 50);
    const long = new CountingJournal();
    await churn(new JournalRememberEntitiesStore(long), 10_000, 50);

    short.eventsRead = 0;
    long.eventsRead = 0;
    await new JournalRememberEntitiesStore(short).load(TYPE_NAME);
    await new JournalRememberEntitiesStore(long).load(TYPE_NAME);

    expect(long.eventsRead).toBeLessThanOrEqual(REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS + 1);
    expect(short.eventsRead).toBeLessThanOrEqual(REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS + 1);
  });

  test('compaction always leaves the snapshot behind: the stream is never compacted to nothing', async () => {
    const journal = new InMemoryJournal();
    const store = new JournalRememberEntitiesStore(journal);
    // Every entity stopped: the live set is empty, and the snapshot of an empty
    // set still has to stand, or the high-water mark would cover no event.
    await churn(store, REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS, 0);

    const remaining = await journal.read(PERSISTENCE_ID, 1);
    expect(await journal.highestSeq(PERSISTENCE_ID)).toBeGreaterThan(remaining.length);
    expect(remaining.length).toBeGreaterThanOrEqual(1);
    expect(await new JournalRememberEntitiesStore(journal).load(TYPE_NAME)).toEqual([]);
  });

  test('a stream below the interval is left exactly as written', async () => {
    const journal = new InMemoryJournal();
    const store = new JournalRememberEntitiesStore(journal);
    const events: RememberEvent[] = [
      { kind: 'started', shardId: 1, entityId: 'a' },
      { kind: 'stopped', shardId: 1, entityId: 'a' },
    ];
    for (const event of events) await store.append(TYPE_NAME, event);

    expect(await store.load(TYPE_NAME)).toEqual(events);
    expect((await journal.read(PERSISTENCE_ID, 1)).length).toBe(2);
  });

  test('a delete that fails after the snapshot was written loses nothing: load starts at the last snapshot', async () => {
    class FailingDeleteJournal extends InMemoryJournal {
      override async delete(): Promise<void> { throw new Error('delete refused'); }
    }
    const journal = new FailingDeleteJournal();
    const store = new JournalRememberEntitiesStore(journal);
    const expected = await churn(store, REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS, 5);

    // Appends kept succeeding — a failed compaction is not a failed append.
    expect(liveSet(await new JournalRememberEntitiesStore(journal).load(TYPE_NAME))).toEqual(expected);
  });

  test('a compaction that races another writer gives up rather than overwrite its event', async () => {
    // Another coordinator appends between this store's read and its snapshot
    // append — only a split brain allows it.  The snapshot append is fenced on
    // the head the fold read, so it fails, and the other writer's event stands.
    // The intruder lands right after the compaction's read — the one read
    // with an explicit upper bound — which is the window the fence covers: a
    // fence taken any later would admit the snapshot, and the delete behind it
    // would take the intruder's event along.
    class RacingJournal extends InMemoryJournal {
      raced = false;
      override async read<E>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
        const events = await super.read<E>(persistenceId, fromSeq, toSeq);
        if (toSeq !== undefined && !this.raced) {
          this.raced = true;
          const intruder: RememberEvent = { kind: 'started', shardId: 3, entityId: 'intruder' };
          const entry: JournalEntry<RememberEvent> = { event: intruder };
          await super.append(persistenceId, [entry], await super.highestSeq(persistenceId));
        }
        return events;
      }
    }
    const journal = new RacingJournal();
    const store = new JournalRememberEntitiesStore(journal);
    const expected = await churn(store, REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS, 5);
    expected.add('3:intruder');

    expect(journal.raced).toBe(true);
    expect(liveSet(await new JournalRememberEntitiesStore(journal).load(TYPE_NAME))).toEqual(expected);
  });

  test('a store that never loaded still compacts a long stream it appends to', async () => {
    // The coordinator always loads first, but a store is a public class, and
    // its counter must not depend on that.
    const journal = new InMemoryJournal();
    await churn(new JournalRememberEntitiesStore(journal), REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS * 2, 0);
    expect((await journal.read(PERSISTENCE_ID, 1)).length).toBeLessThanOrEqual(REMEMBER_ENTITIES_COMPACTION_MIN_EVENTS + 1);
  });
});

