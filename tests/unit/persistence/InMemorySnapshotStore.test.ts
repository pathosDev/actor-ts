import { describe, expect, test } from 'bun:test';
import { InMemorySnapshotStore } from '../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';

describe('InMemorySnapshotStore.save / loadLatest', () => {
  test('save returns a snapshot with the given seq + state', async () => {
    const s = new InMemorySnapshotStore();
    const snap = await s.save('p', 5, { balance: 42 });
    expect(snap.sequenceNr).toBe(5);
    expect(snap.state).toEqual({ balance: 42 });
    expect(snap.persistenceId).toBe('p');
  });

  test('loadLatest returns Some(most recent snapshot)', async () => {
    const s = new InMemorySnapshotStore();
    await s.save('p', 3, { step: 'a' });
    await s.save('p', 7, { step: 'b' });
    const latest = await s.loadLatest<{ step: string }>('p');
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
    const s = new InMemorySnapshotStore();
    await s.save('p', 1, {});
    await s.save('p', 4, {});
    await s.save('p', 8, {});
    expect((await s.loadBefore('p', 5)).toNullable()?.sequenceNr).toBe(4);
    expect((await s.loadBefore('p', 8)).toNullable()?.sequenceNr).toBe(4);
    expect((await s.loadBefore('p', 9)).toNullable()?.sequenceNr).toBe(8);
  });

  test('returns None when nothing exists before seq', async () => {
    const s = new InMemorySnapshotStore();
    await s.save('p', 10, {});
    expect((await s.loadBefore('p', 5)).isNone()).toBe(true);
  });
});

describe('InMemorySnapshotStore.delete', () => {
  test('drops snapshots up to and including toSeq', async () => {
    const s = new InMemorySnapshotStore();
    await s.save('p', 1, {}); await s.save('p', 2, {}); await s.save('p', 3, {});
    await s.delete('p', 2);
    const latest = await s.loadLatest('p');
    expect(latest.toNullable()?.sequenceNr).toBe(3);
    expect((await s.loadBefore('p', 3)).isNone()).toBe(true);
  });

  test('no-op for unknown pid', async () => {
    const s = new InMemorySnapshotStore();
    await expect(s.delete('nope', 5)).resolves.toBeUndefined();
  });
});
