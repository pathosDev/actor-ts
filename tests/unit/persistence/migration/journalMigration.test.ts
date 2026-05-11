/**
 * Tests for `migrateBetweenJournals` / `migrateBetweenSnapshotStores` (#87).
 *
 * Scenarios:
 *   - Full copy: every event in source ends up in target with seq +
 *     tags + payload preserved.
 *   - Transform hook: per-event schema migration on the same pass.
 *   - Resume: progress store skips completed pids; mid-pid resume picks
 *     up at `target.highestSeq + 1`.
 *   - Snapshot store copy: latest snapshot lands at the same seq in
 *     target; empty pids are no-ops.
 *   - skipExistingPids: bypasses pids that already have data in target.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { InMemoryJournal } from '../../../../src/persistence/journals/InMemoryJournal.js';
import { InMemorySnapshotStore } from '../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import {
  InMemoryMigrationProgressStore,
  migrateBetweenJournals,
  migrateBetweenSnapshotStores,
} from '../../../../src/persistence/migration/journalMigration.js';

let source: InMemoryJournal;
let target: InMemoryJournal;

beforeEach(() => {
  source = new InMemoryJournal();
  target = new InMemoryJournal();
});
afterEach(async () => {
  await source.close?.();
  await target.close?.();
});

describe('migrateBetweenJournals', () => {
  test('copies every event from source to target preserving seq + tags', async () => {
    await source.append('order-1',
      [{ kind: 'created', total: 50 }, { kind: 'paid' }, { kind: 'shipped' }],
      0, ['type:Order']);
    await source.append('order-2',
      [{ kind: 'created', total: 100 }],
      0, ['type:Order', 'tenant:acme']);

    const result = await migrateBetweenJournals(source, target);

    expect(result.pidsInspected).toBe(2);
    expect(result.pidsWritten).toBe(2);
    expect(result.eventsWritten).toBe(4);

    // Order-1: three events, same payload + same tags
    const tgt1 = await target.read<{ kind: string; total?: number }>('order-1', 1);
    expect(tgt1.length).toBe(3);
    expect(tgt1.map((e) => e.event.kind)).toEqual(['created', 'paid', 'shipped']);
    expect(tgt1.map((e) => e.sequenceNr)).toEqual([1, 2, 3]);
    expect(tgt1[0]!.tags).toEqual(['type:Order']);

    const tgt2 = await target.read<{ kind: string; total?: number }>('order-2', 1);
    expect(tgt2.length).toBe(1);
    expect(tgt2[0]!.tags).toEqual(['type:Order', 'tenant:acme']);
  });

  test('eventTransform applies a per-event payload migration during the copy', async () => {
    interface Old { v: number }
    interface New { version: number; migrated: true }
    await source.append<Old>('pid-1', [{ v: 1 }, { v: 2 }], 0);

    const result = await migrateBetweenJournals<Old>(source, target, {
      eventTransform: (e) => ({
        ...e,
        event: { version: e.event.v, migrated: true } as unknown as Old,
      }),
    });
    expect(result.eventsWritten).toBe(2);

    const tgt = await target.read<New>('pid-1', 1);
    expect(tgt[0]!.event).toEqual({ version: 1, migrated: true });
    expect(tgt[1]!.event).toEqual({ version: 2, migrated: true });
  });

  test('idempotent on a fully-completed target (re-running is a no-op)', async () => {
    await source.append('pid-1', [{ x: 1 }, { x: 2 }], 0);

    const first = await migrateBetweenJournals(source, target);
    expect(first.eventsWritten).toBe(2);
    expect(first.pidsWritten).toBe(1);

    const second = await migrateBetweenJournals(source, target);
    expect(second.eventsWritten).toBe(0);
    // pidsWritten counts pids with > 0 writes — second pass has none
    expect(second.pidsWritten).toBe(0);
    expect(second.pidsInspected).toBe(1);
  });

  test('resumes from a partial copy: target ahead-of-zero, source has more', async () => {
    await source.append('pid-1', [{ x: 1 }, { x: 2 }, { x: 3 }], 0);
    // Simulate a partial target: copy events 1+2 directly.
    await target.append('pid-1', [{ x: 1 }, { x: 2 }], 0);

    const result = await migrateBetweenJournals(source, target);
    expect(result.eventsWritten).toBe(1);

    const tgt = await target.read<{ x: number }>('pid-1', 1);
    expect(tgt.map((e) => e.event.x)).toEqual([1, 2, 3]);
  });

  test('progressStore skips completed pids on a resumed run', async () => {
    await source.append('pid-a', [{ x: 1 }], 0);
    await source.append('pid-b', [{ y: 1 }], 0);
    await source.append('pid-c', [{ z: 1 }], 0);

    const progress = new InMemoryMigrationProgressStore();
    // Pretend pid-a was already completed.
    await progress.save({ completed: ['pid-a'] });

    const result = await migrateBetweenJournals(source, target, { progress });
    expect(result.pidsSkippedAlreadyDone).toBe(1);
    expect(result.eventsWritten).toBe(2);

    // pid-a never got copied; b + c did.
    expect((await target.read('pid-a', 1)).length).toBe(0);
    expect((await target.read('pid-b', 1)).length).toBe(1);
    expect((await target.read('pid-c', 1)).length).toBe(1);

    // After the run, completed has all three.
    const final = await progress.load();
    expect(new Set(final.completed)).toEqual(new Set(['pid-a', 'pid-b', 'pid-c']));
  });

  test('skipExistingPids leaves target pids with data alone', async () => {
    await source.append('keep-target', [{ src: true }], 0);
    await source.append('copy-me', [{ src: true }], 0);
    await target.append('keep-target', [{ target: true }], 0);

    const result = await migrateBetweenJournals(source, target, {
      skipExistingPids: true,
    });
    expect(result.pidsSkippedExistingTarget).toBe(1);
    expect(result.eventsWritten).toBe(1);

    const keep = await target.read<{ target?: boolean; src?: boolean }>('keep-target', 1);
    expect(keep[0]!.event).toEqual({ target: true });
  });

  test('onProgress fires after each pid with event count', async () => {
    await source.append('a', [{ n: 1 }], 0);
    await source.append('b', [{ n: 2 }, { n: 3 }], 0);

    const events: string[] = [];
    await migrateBetweenJournals(source, target, {
      onProgress: (p) => events.push(`${p.pid}=${p.events}`),
    });
    expect(events).toEqual(['a=1', 'b=2']);
  });

  test('pids subset narrows the copy to the requested ids', async () => {
    await source.append('a', [{ n: 1 }], 0);
    await source.append('b', [{ n: 2 }], 0);
    await source.append('c', [{ n: 3 }], 0);

    const result = await migrateBetweenJournals(source, target, {
      pids: ['a', 'c'],
    });
    expect(result.pidsInspected).toBe(2);
    expect(result.eventsWritten).toBe(2);
    expect((await target.read('b', 1)).length).toBe(0);
  });
});

describe('migrateBetweenSnapshotStores', () => {
  test('copies the latest snapshot per pid', async () => {
    const src = new InMemorySnapshotStore();
    const tgt = new InMemorySnapshotStore();
    await src.save('user-1', 5, { name: 'alice', balance: 200 });
    await src.save('user-2', 3, { name: 'bob', balance: 50 });

    const result = await migrateBetweenSnapshotStores(src, tgt, {
      pids: ['user-1', 'user-2'],
    });
    expect(result.pidsCopied).toBe(2);
    expect(result.pidsEmpty).toBe(0);

    const u1 = await tgt.loadLatest<{ name: string; balance: number }>('user-1');
    expect(u1.toNullable()?.sequenceNr).toBe(5);
    expect(u1.toNullable()?.state).toEqual({ name: 'alice', balance: 200 });
  });

  test('stateTransform applies a payload migration during copy', async () => {
    const src = new InMemorySnapshotStore();
    const tgt = new InMemorySnapshotStore();
    await src.save('p', 2, { v: 1 });

    await migrateBetweenSnapshotStores<{ v: number }>(src, tgt, {
      pids: ['p'],
      stateTransform: (s) => ({ v: s.v * 10 }),
    });
    const loaded = await tgt.loadLatest<{ v: number }>('p');
    expect(loaded.toNullable()?.state).toEqual({ v: 10 });
  });

  test('empty source pids are recorded but cause no writes', async () => {
    const src = new InMemorySnapshotStore();
    const tgt = new InMemorySnapshotStore();
    await src.save('has-data', 1, { x: 1 });

    const result = await migrateBetweenSnapshotStores(src, tgt, {
      pids: ['has-data', 'empty-pid'],
    });
    expect(result.pidsCopied).toBe(1);
    expect(result.pidsEmpty).toBe(1);

    const empty = await tgt.loadLatest('empty-pid');
    expect(empty.isNone()).toBe(true);
  });

  test('skipExistingPids leaves target snapshots intact', async () => {
    const src = new InMemorySnapshotStore();
    const tgt = new InMemorySnapshotStore();
    await src.save('p', 5, { from: 'src' });
    await tgt.save('p', 3, { from: 'tgt' });

    await migrateBetweenSnapshotStores(src, tgt, {
      pids: ['p'],
      skipExistingPids: true,
    });
    const loaded = await tgt.loadLatest<{ from: string }>('p');
    expect(loaded.toNullable()?.state).toEqual({ from: 'tgt' });
    expect(loaded.toNullable()?.sequenceNr).toBe(3);
  });
});
