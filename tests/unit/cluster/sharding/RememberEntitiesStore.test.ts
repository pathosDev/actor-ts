/**
 * Unit tests for `JournalRememberEntitiesStore` (#49) — the journal-
 * backed persistence layer for the sharded-entity registry.  Covers
 * round-trip, empty load, and clear.  The end-to-end "cluster cold-
 * restart preserves entities" assertion lives in the multi-node test
 * (`tests/multi-node/sharding-remember-entities.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { InMemoryJournal } from '../../../../src/persistence/journals/InMemoryJournal.js';
import {
  JournalRememberEntitiesStore,
  type RememberEvent,
} from '../../../../src/cluster/sharding/RememberEntitiesStore.js';

describe('JournalRememberEntitiesStore', () => {
  test('1. round-trip: append a few events, load returns them in order', async () => {
    const journal = new InMemoryJournal();
    const store = new JournalRememberEntitiesStore(journal);

    const events: RememberEvent[] = [
      { kind: 'started', shardId: 1, entityId: 'a' },
      { kind: 'started', shardId: 1, entityId: 'b' },
      { kind: 'started', shardId: 2, entityId: 'c' },
      { kind: 'stopped', shardId: 1, entityId: 'a' },
    ];
    for (const ev of events) await store.append('orders', ev);

    const loaded = await store.load('orders');
    expect(loaded).toEqual(events);
  });

  test('2. empty store: load returns []', async () => {
    const store = new JournalRememberEntitiesStore(new InMemoryJournal());
    const loaded = await store.load('never-seen');
    expect(loaded).toEqual([]);
  });

  test('3. clear removes every event for a typeName', async () => {
    const journal = new InMemoryJournal();
    const store = new JournalRememberEntitiesStore(journal);

    await store.append('a', { kind: 'started', shardId: 1, entityId: 'x' });
    await store.append('b', { kind: 'started', shardId: 1, entityId: 'y' });

    await store.clear('a');

    expect(await store.load('a')).toEqual([]);
    // Other typeName untouched.
    expect(await store.load('b')).toEqual([
      { kind: 'started', shardId: 1, entityId: 'y' },
    ]);
  });
});
