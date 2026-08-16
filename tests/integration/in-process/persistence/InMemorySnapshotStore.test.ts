import { describe, expect, test } from 'bun:test';
import { InMemorySnapshotStore } from '../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { InMemorySnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/InMemorySnapshotStoreOptions.js';

/** How many snapshots the store is holding for `persistenceId`. */
async function retained(store: InMemorySnapshotStore, persistenceId: string): Promise<number> {
  let count = 0;
  let cursor = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const found = (await store.loadBefore(persistenceId, cursor)).toNullable();
    if (!found) return count;
    count += 1;
    cursor = found.sequenceNr;
  }
}

describe('InMemorySnapshotStore.save / loadLatest', () => {
  test('save returns a snapshot with the given seq + state', async () => {
    const store = new InMemorySnapshotStore();
    const snap = await store.save('p', 5, { balance: 42 });
    expect(snap.sequenceNr).toBe(5);
    expect(snap.state).toEqual({ balance: 42 });
    expect(snap.persistenceId).toBe('p');
  });

  test('loadLatest returns Some(most recent snapshot)', async () => {
    const store = new InMemorySnapshotStore();
    await store.save('p', 3, { step: 'a' });
    await store.save('p', 7, { step: 'b' });
    const latest = await store.loadLatest<{ step: string }>('p');
    expect(latest.isSome()).toBe(true);
    expect(latest.toNullable()?.sequenceNr).toBe(7);
    expect(latest.toNullable()?.state.step).toBe('b');
  });

  test('loadLatest returns None when there are no snapshots', async () => {
    expect((await new InMemorySnapshotStore().loadLatest('anything')).isNone()).toBe(true);
  });
});

describe('InMemorySnapshotStore.loadBefore', () => {
  test('finds the newest snapshot strictly before seq', async () => {
    const store = new InMemorySnapshotStore();
    await store.save('p', 1, {});
    await store.save('p', 4, {});
    await store.save('p', 8, {});
    expect((await store.loadBefore('p', 5)).toNullable()?.sequenceNr).toBe(4);
    expect((await store.loadBefore('p', 8)).toNullable()?.sequenceNr).toBe(4);
    expect((await store.loadBefore('p', 9)).toNullable()?.sequenceNr).toBe(8);
  });

  test('returns None when nothing exists before seq', async () => {
    const store = new InMemorySnapshotStore();
    await store.save('p', 10, {});
    expect((await store.loadBefore('p', 5)).isNone()).toBe(true);
  });
});

describe('InMemorySnapshotStore.delete', () => {
  test('drops snapshots up to and including toSeq', async () => {
    const store = new InMemorySnapshotStore();
    await store.save('p', 1, {}); await store.save('p', 2, {}); await store.save('p', 3, {});
    await store.delete('p', 2);
    const latest = await store.loadLatest('p');
    expect(latest.toNullable()?.sequenceNr).toBe(3);
    expect((await store.loadBefore('p', 3)).isNone()).toBe(true);
  });

  test('no-op for unknown pid', async () => {
    const store = new InMemorySnapshotStore();
    await expect(store.delete('nope', 5)).resolves.toBeUndefined();
  });
});

describe('InMemorySnapshotStore retention (#493)', () => {
  // Every case here saves MORE snapshots than any plausible bound.  The
  // pre-existing cases above top out at three per pid, which is exactly
  // the family default, so none of them can tell a bounded store from an
  // unbounded one — the gap that let the default go undecided.

  test('the default keeps every snapshot', async () => {
    const store = new InMemorySnapshotStore();
    for (const seq of [1, 2, 3, 4, 5, 6]) await store.save('p', seq, { seq });
    expect(await retained(store, 'p')).toBe(6);
    expect((await store.loadBefore('p', 2)).toNullable()?.sequenceNr).toBe(1);
  });

  test('keepN bounds retention and evicts the oldest first', async () => {
    const storeOptions = InMemorySnapshotStoreOptions.create().withKeepN(2);
    const store = new InMemorySnapshotStore(storeOptions);
    for (const seq of [1, 2, 3, 4, 5, 6]) await store.save('p', seq, { seq });
    expect(await retained(store, 'p')).toBe(2);
    expect((await store.loadLatest('p')).toNullable()?.sequenceNr).toBe(6);
    expect((await store.loadBefore('p', 6)).toNullable()?.sequenceNr).toBe(5);
    expect((await store.loadBefore('p', 5)).isNone()).toBe(true);
  });

  test('keepN of 0 keeps everything, matching the rest of the family', async () => {
    const storeOptions = InMemorySnapshotStoreOptions.create().withKeepN(0);
    const store = new InMemorySnapshotStore(storeOptions);
    for (const seq of [1, 2, 3, 4, 5, 6]) await store.save('p', seq, { seq });
    expect(await retained(store, 'p')).toBe(6);
  });

  test('the bound is per persistenceId, not global', async () => {
    const storeOptions = InMemorySnapshotStoreOptions.create().withKeepN(2);
    const store = new InMemorySnapshotStore(storeOptions);
    for (const seq of [1, 2, 3]) { await store.save('a', seq, { seq }); await store.save('b', seq, { seq }); }
    expect(await retained(store, 'a')).toBe(2);
    expect(await retained(store, 'b')).toBe(2);
  });

  test('re-saving at the same sequence replaces rather than accumulates', async () => {
    // The duplicate used to be retained, so with a bound in place a
    // repeated snapshot at an unchanged sequence evicted genuinely older
    // sequences instead of overwriting itself.
    const storeOptions = InMemorySnapshotStoreOptions.create().withKeepN(3);
    const store = new InMemorySnapshotStore(storeOptions);
    await store.save('p', 1, { v: 'one' });
    await store.save('p', 2, { v: 'two' });
    for (const attempt of ['a', 'b', 'c', 'd']) await store.save('p', 3, { v: attempt });

    expect(await retained(store, 'p')).toBe(3);
    expect((await store.loadLatest<{ v: string }>('p')).toNullable()?.state.v).toBe('d');
    // seq 1 survives: the four writes at seq 3 are one entry, not four.
    expect((await store.loadBefore('p', 2)).toNullable()?.sequenceNr).toBe(1);
  });

  test('an unbounded store still de-duplicates a repeated sequence', async () => {
    const store = new InMemorySnapshotStore();
    for (const attempt of ['a', 'b', 'c']) await store.save('p', 4, { v: attempt });
    expect(await retained(store, 'p')).toBe(1);
    expect((await store.loadLatest<{ v: string }>('p')).toNullable()?.state.v).toBe('c');
  });
});
