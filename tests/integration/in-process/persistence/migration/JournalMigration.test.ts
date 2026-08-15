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
 *   - skipExistingPersistenceIds: bypasses pids that already have data in target.
 *   - Compacted sources (#630): the target inherits the source's compaction
 *     mark, so sequence numbers survive the copy and the paired snapshot
 *     still recovers.
 *   - Per-side `PersistenceOptions` on the snapshot copy (#630).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Journal } from '../../../../../src/persistence/Journal.js';
import type { PersistentEvent, Snapshot } from '../../../../../src/persistence/JournalTypes.js';
import type { EncryptionConfig, PersistenceOptions } from '../../../../../src/persistence/PersistenceOptions.js';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageSnapshotStore } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageSnapshotStoreOptions } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import type { SnapshotStore } from '../../../../../src/persistence/SnapshotStore.js';
import type { Option } from '../../../../../src/util/Option.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { InMemorySnapshotStore } from '../../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { replayState } from '../../../../../src/persistence/Replay.js';
import {
  CompactedSourceError,
  InMemoryMigrationProgressStore,
  migrateBetweenJournals,
  migrateBetweenSnapshotStores,
} from '../../../../../src/persistence/migration/JournalMigration.js';

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
    await source.append('order-1',[
      { event: { kind: 'created', total: 50 }, tags: ['type:Order'] },
      { event: { kind: 'paid' }, tags: ['type:Order'] },
      { event: { kind: 'shipped' }, tags: ['type:Order'] },
    ],
      0);
    await source.append('order-2',[
      { event: { kind: 'created', total: 100 }, tags: ['type:Order', 'tenant:acme'] },
    ],
      0);

    const result = await migrateBetweenJournals(source, target);

    expect(result.persistenceIdsInspected).toBe(2);
    expect(result.persistenceIdsWritten).toBe(2);
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
    type Old = { v: number };
    type New = { version: number; migrated: true };
    await source.append<Old>('pid-1', [{ event: { v: 1 } }, { event: { v: 2 } }], 0);

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
    await source.append('pid-1', [{ event: { x: 1 } }, { event: { x: 2 } }], 0);

    const first = await migrateBetweenJournals(source, target);
    expect(first.eventsWritten).toBe(2);
    expect(first.persistenceIdsWritten).toBe(1);

    const second = await migrateBetweenJournals(source, target);
    expect(second.eventsWritten).toBe(0);
    // persistenceIdsWritten counts pids with > 0 writes — second pass has none
    expect(second.persistenceIdsWritten).toBe(0);
    expect(second.persistenceIdsInspected).toBe(1);
  });

  test('resumes from a partial copy: target ahead-of-zero, source has more', async () => {
    await source.append('pid-1', [{ event: { x: 1 } }, { event: { x: 2 } }, { event: { x: 3 } }], 0);
    // Simulate a partial target: copy events 1+2 directly.
    await target.append('pid-1', [{ event: { x: 1 } }, { event: { x: 2 } }], 0);

    const result = await migrateBetweenJournals(source, target);
    expect(result.eventsWritten).toBe(1);
    // A legitimate mid-pid resume is NOT a compacted source: the slice starts
    // at `targetHigh + 1`, so nothing may be treated as a gap (#630).
    expect(result.persistenceIdsCompactionMarkRaised).toBe(0);

    const tgt = await target.read<{ x: number }>('pid-1', 1);
    expect(tgt.map((e) => e.event.x)).toEqual([1, 2, 3]);
    expect(tgt.map((e) => e.sequenceNr)).toEqual([1, 2, 3]);
  });

  test('progressStore skips completed pids on a resumed run', async () => {
    await source.append('pid-a', [{ event: { x: 1 } }], 0);
    await source.append('pid-b', [{ event: { y: 1 } }], 0);
    await source.append('pid-c', [{ event: { z: 1 } }], 0);

    const progress = new InMemoryMigrationProgressStore();
    // Pretend pid-a was already completed.
    await progress.save({ completed: ['pid-a'] });

    const result = await migrateBetweenJournals(source, target, { progress });
    expect(result.persistenceIdsSkippedAlreadyDone).toBe(1);
    expect(result.eventsWritten).toBe(2);

    // pid-a never got copied; b + c did.
    expect((await target.read('pid-a', 1)).length).toBe(0);
    expect((await target.read('pid-b', 1)).length).toBe(1);
    expect((await target.read('pid-c', 1)).length).toBe(1);

    // After the run, completed has all three.
    const final = await progress.load();
    expect(new Set(final.completed)).toEqual(new Set(['pid-a', 'pid-b', 'pid-c']));
  });

  test('skipExistingPersistenceIds leaves target pids with data alone', async () => {
    await source.append('keep-target', [{ event: { src: true } }], 0);
    await source.append('copy-me', [{ event: { src: true } }], 0);
    await target.append('keep-target', [{ event: { target: true } }], 0);

    const result = await migrateBetweenJournals(source, target, {
      skipExistingPersistenceIds: true,
    });
    expect(result.persistenceIdsSkippedExistingTarget).toBe(1);
    expect(result.eventsWritten).toBe(1);

    const keep = await target.read<{ target?: boolean; src?: boolean }>('keep-target', 1);
    expect(keep[0]!.event).toEqual({ target: true });
  });

  test('onProgress fires after each pid with event count', async () => {
    await source.append('a', [{ event: { n: 1 } }], 0);
    await source.append('b', [{ event: { n: 2 } }, { event: { n: 3 } }], 0);

    const events: string[] = [];
    await migrateBetweenJournals(source, target, {
      onProgress: (p) => events.push(`${p.persistenceId}=${p.events}`),
    });
    expect(events).toEqual(['a=1', 'b=2']);
  });

  test('pids subset narrows the copy to the requested ids', async () => {
    await source.append('a', [{ event: { n: 1 } }], 0);
    await source.append('b', [{ event: { n: 2 } }], 0);
    await source.append('c', [{ event: { n: 3 } }], 0);

    const result = await migrateBetweenJournals(source, target, {
      persistenceIds: ['a', 'c'],
    });
    expect(result.persistenceIdsInspected).toBe(2);
    expect(result.eventsWritten).toBe(2);
    expect((await target.read('b', 1)).length).toBe(0);
  });
});

/* ---------------------- compacted sources (#630) ------------------------ */

/** A counter stream: event `n` adds `n`, so a wrong tail shows up in the sum. */
type CounterEvent = { n: number };
type CounterState = { total: number };

const counterEvents = (from: number, to: number): Array<{ event: CounterEvent }> =>
  Array.from({ length: to - from + 1 }, (_, index) => ({ event: { n: from + index } }));

const sumTo = (n: number): number => (n * (n + 1)) / 2;

const replayCounter = (journal: Journal, snapshotStore: SnapshotStore, persistenceId: string) =>
  replayState<CounterEvent, CounterState>({
    journal,
    snapshotStore,
    persistenceId,
    initialState: () => ({ total: 0 }),
    fold: (state, event) => ({ total: state.total + event.n }),
  });

/** A third-party journal: everything `Journal` requires, no optional extras. */
class MarklessJournal implements Journal {
  constructor(private readonly inner: Journal) {}
  append: Journal['append'] = (persistenceId, entries, expectedSeq) =>
    this.inner.append(persistenceId, entries, expectedSeq);
  read: Journal['read'] = (persistenceId, fromSeq, toSeq) => this.inner.read(persistenceId, fromSeq, toSeq);
  highestSeq(persistenceId: string): Promise<number> { return this.inner.highestSeq(persistenceId); }
  delete(persistenceId: string, toSeq: number): Promise<void> { return this.inner.delete(persistenceId, toSeq); }
  persistenceIds(): Promise<string[]> { return this.inner.persistenceIds(); }
}

/** A journal whose `read` breaks the contiguity half of the `read` contract. */
class HoledJournal implements Journal {
  constructor(private readonly sequenceNumbers: ReadonlyArray<number>) {}
  async append(): Promise<never> { throw new Error('HoledJournal is read-only'); }
  // Carries `Journal.read`'s own generic signature.  `MarklessJournal` above
  // can borrow the type with `Journal['read']` because it delegates and hands
  // back the same `E` it was asked for; this fake *synthesises* payloads, so
  // it has to name `E` itself and cast — a fake choosing the shape it returns
  // is exactly what the cast says.
  async read<E = unknown>(persistenceId: string): Promise<PersistentEvent<E>[]> {
    return this.sequenceNumbers.map((sequenceNr) => ({
      persistenceId, sequenceNr, event: { n: sequenceNr } as E, timestamp: 0,
    }));
  }
  async highestSeq(): Promise<number> { return this.sequenceNumbers[this.sequenceNumbers.length - 1] ?? 0; }
  async delete(): Promise<void> { /* read-only */ }
  async persistenceIds(): Promise<string[]> { return ['holed']; }
}

describe('migrateBetweenJournals — compacted sources (#630)', () => {
  test('preserves sequence numbers when the source was compacted past a snapshot', async () => {
    // The layout `PersistentActor.deleteHistory` actually leaves behind:
    // events 5..10 survive and the snapshot sits AT the compaction point.
    await source.append('counter-1', counterEvents(1, 10), 0);
    await source.delete('counter-1', 4);
    const sourceSnapshots = new InMemorySnapshotStore();
    const targetSnapshots = new InMemorySnapshotStore();
    await sourceSnapshots.save<CounterState>('counter-1', 4, { total: sumTo(4) });

    const result = await migrateBetweenJournals(source, target);
    await migrateBetweenSnapshotStores<CounterState>(sourceSnapshots, targetSnapshots, {
      persistenceIds: ['counter-1'],
    });

    expect(result.eventsWritten).toBe(6);
    expect(result.persistenceIdsCompactionMarkRaised).toBe(1);

    // The events keep the numbers they had — before the fix they were
    // renumbered 1..6, which no snapshot, offset or cursor refers to.
    const copied = await target.read<CounterEvent>('counter-1', 1);
    expect(copied.map((e) => e.sequenceNr)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(copied.map((e) => e.event.n)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(await target.highestSeq('counter-1')).toBe(10);

    // And recovery reaches the state it would have on the source.  The
    // pre-fix target recovered SILENTLY WRONG here: the snapshot at 4 passed
    // the integrity check against a 6-event journal and the fold applied the
    // last two events on top of it.
    const replayed = await replayCounter(target, targetSnapshots, 'counter-1');
    expect(replayed.sequenceNr).toBe(10);
    expect(replayed.state).toEqual({ total: sumTo(10) });
  });

  test('carries the high-water mark of a fully compacted source', async () => {
    // Nothing survives, but the source still remembers 10 sequence numbers.
    await source.append('counter-2', counterEvents(1, 10), 0);
    await source.delete('counter-2', 10);
    const sourceSnapshots = new InMemorySnapshotStore();
    const targetSnapshots = new InMemorySnapshotStore();
    await sourceSnapshots.save<CounterState>('counter-2', 10, { total: sumTo(10) });

    const result = await migrateBetweenJournals(source, target);
    await migrateBetweenSnapshotStores<CounterState>(sourceSnapshots, targetSnapshots, {
      persistenceIds: ['counter-2'],
    });

    expect(result.eventsWritten).toBe(0);
    expect(result.persistenceIdsCompactionMarkRaised).toBe(1);
    expect(await target.highestSeq('counter-2')).toBe(10);

    const replayed = await replayCounter(target, targetSnapshots, 'counter-2');
    expect(replayed.sequenceNr).toBe(10);
    expect(replayed.state).toEqual({ total: sumTo(10) });

    // The pathology #628 closed, re-introduced through migration: a target
    // whose high-water mark stayed 0 rejected every later persist forever.
    const written = await target.append('counter-2', [{ event: { n: 11 } }], replayed.sequenceNr);
    expect(written.map((e) => e.sequenceNr)).toEqual([11]);
  });

  test('a re-run of a compacted copy is idempotent', async () => {
    await source.append('counter-3', counterEvents(1, 6), 0);
    await source.delete('counter-3', 3);

    const first = await migrateBetweenJournals(source, target);
    expect(first.eventsWritten).toBe(3);
    const second = await migrateBetweenJournals(source, target);
    expect(second.eventsWritten).toBe(0);
    expect(second.persistenceIdsCompactionMarkRaised).toBe(0);
    expect((await target.read('counter-3', 1)).map((e) => e.sequenceNr)).toEqual([4, 5, 6]);
  });

  test('refuses a compacted source when the target journal cannot record a mark', async () => {
    await source.append('pid-1', counterEvents(1, 3), 0);
    await source.delete('pid-1', 2);

    await expect(migrateBetweenJournals(source, new MarklessJournal(target)))
      .rejects.toThrow(CompactedSourceError);
    // Nothing renumbered was written on the way to the refusal.
    expect(await target.read('pid-1', 1)).toEqual([]);
  });

  test('refuses a source stream with a hole rather than renumbering the tail', async () => {
    const holed = new HoledJournal([1, 2, 4]);
    await expect(migrateBetweenJournals(holed, target)).rejects.toThrow(/has a gap/);
    // The two events before the hole are already across; the copy stops there
    // rather than writing event 4 at sequence 3.
    expect((await target.read('holed', 1)).map((e) => e.sequenceNr)).toEqual([1, 2]);
  });
});

describe('migrateBetweenSnapshotStores', () => {
  test('copies the latest snapshot per pid', async () => {
    const src = new InMemorySnapshotStore();
    const tgt = new InMemorySnapshotStore();
    await src.save('user-1', 5, { name: 'alice', balance: 200 });
    await src.save('user-2', 3, { name: 'bob', balance: 50 });

    const result = await migrateBetweenSnapshotStores(src, tgt, {
      persistenceIds: ['user-1', 'user-2'],
    });
    expect(result.persistenceIdsCopied).toBe(2);
    expect(result.persistenceIdsEmpty).toBe(0);

    const u1 = await tgt.loadLatest<{ name: string; balance: number }>('user-1');
    expect(u1.toNullable()?.sequenceNr).toBe(5);
    expect(u1.toNullable()?.state).toEqual({ name: 'alice', balance: 200 });
  });

  test('stateTransform applies a payload migration during copy', async () => {
    const src = new InMemorySnapshotStore();
    const tgt = new InMemorySnapshotStore();
    await src.save('p', 2, { v: 1 });

    await migrateBetweenSnapshotStores<{ v: number }>(src, tgt, {
      persistenceIds: ['p'],
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
      persistenceIds: ['has-data', 'empty-pid'],
    });
    expect(result.persistenceIdsCopied).toBe(1);
    expect(result.persistenceIdsEmpty).toBe(1);

    const empty = await tgt.loadLatest('empty-pid');
    expect(empty.isNone()).toBe(true);
  });

  test('skipExistingPersistenceIds leaves target snapshots intact', async () => {
    const src = new InMemorySnapshotStore();
    const tgt = new InMemorySnapshotStore();
    await src.save('p', 5, { from: 'src' });
    await tgt.save('p', 3, { from: 'tgt' });

    await migrateBetweenSnapshotStores(src, tgt, {
      persistenceIds: ['p'],
      skipExistingPersistenceIds: true,
    });
    const loaded = await tgt.loadLatest<{ from: string }>('p');
    expect(loaded.toNullable()?.state).toEqual({ from: 'tgt' });
    expect(loaded.toNullable()?.sequenceNr).toBe(3);
  });
});

/* ------------- per-side PersistenceOptions on snapshots (#630) ---------- */

/** Records the per-call options each store method was handed. */
class RecordingSnapshotStore implements SnapshotStore {
  readonly loadOptions: Array<PersistenceOptions | undefined> = [];
  readonly saveOptions: Array<PersistenceOptions | undefined> = [];
  constructor(private readonly inner: SnapshotStore) {}
  save<S>(persistenceId: string, seq: number, state: S, options?: PersistenceOptions): Promise<Snapshot<S>> {
    this.saveOptions.push(options);
    return this.inner.save<S>(persistenceId, seq, state, options);
  }
  loadLatest<S>(persistenceId: string, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    this.loadOptions.push(options);
    return this.inner.loadLatest<S>(persistenceId, options);
  }
  loadBefore<S>(persistenceId: string, seq: number, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    return this.inner.loadBefore<S>(persistenceId, seq, options);
  }
  delete(persistenceId: string, toSeq: number): Promise<void> { return this.inner.delete(persistenceId, toSeq); }
}

describe('migrateBetweenSnapshotStores — per-side PersistenceOptions (#630)', () => {
  test('reads use the source options and writes use the target options', async () => {
    // Two sides, two configs: a re-key sweep is an ordinary reason to migrate,
    // so one shared field could not express what the copy needs.
    const sourceOptions: PersistenceOptions = { compression: { algorithm: 'gzip' } };
    const targetOptions: PersistenceOptions = { compression: { algorithm: 'zstd' } };
    const innerSource = new InMemorySnapshotStore();
    await innerSource.save('p', 3, { v: 1 });
    const src = new RecordingSnapshotStore(innerSource);
    const tgt = new RecordingSnapshotStore(new InMemorySnapshotStore());

    await migrateBetweenSnapshotStores(src, tgt, {
      persistenceIds: ['p'],
      // Turned on so the target-side probe is exercised too.
      skipExistingPersistenceIds: true,
      sourcePersistenceOptions: sourceOptions,
      targetPersistenceOptions: targetOptions,
    });

    expect(src.loadOptions).toEqual([sourceOptions]);
    // The skip probe reads the TARGET, so it must carry the target's config.
    expect(tgt.loadOptions).toEqual([targetOptions]);
    // The write is the half the issue never mentioned: without this the store
    // resolves to `{ mode: 'none' }` and lands the snapshot in the clear.
    expect(tgt.saveOptions).toEqual([targetOptions]);
  });

  test('omitting them leaves the stores on their own configuration', async () => {
    const innerSource = new InMemorySnapshotStore();
    await innerSource.save('p', 1, { v: 1 });
    const src = new RecordingSnapshotStore(innerSource);
    const tgt = new RecordingSnapshotStore(new InMemorySnapshotStore());

    await migrateBetweenSnapshotStores(src, tgt, { persistenceIds: ['p'] });

    expect(src.loadOptions).toEqual([undefined]);
    expect(tgt.saveOptions).toEqual([undefined]);
  });
});

/* -------- encrypted snapshots through the copy, end to end (#630) ------- */

describe('migrateBetweenSnapshotStores — client-side encryption round-trip (#630)', () => {
  // `ObjectStorageSnapshotStore` is the only store that honours encryption at
  // all, so this is where the round-trip can actually be observed.
  let sourceDirectory: string;
  let targetDirectory: string;

  const encryptionWith = (byte: number, info: string): EncryptionConfig => ({
    mode: 'client-aes256-gcm',
    masterKey: new Uint8Array(32).fill(byte),
    info,
  });

  const storeOver = (directory: string): ObjectStorageSnapshotStore => {
    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(directory);
    // Deliberately no `withEncryption(...)`: the gap is the per-call key an
    // actor supplies, which the constructor fallback cannot stand in for.
    const storeOptions = ObjectStorageSnapshotStoreOptions.create()
      .withBackend(new FilesystemObjectStorageBackend(backendOptions));
    return new ObjectStorageSnapshotStore(storeOptions);
  };

  beforeEach(() => {
    sourceDirectory = mkdtempSync(join(tmpdir(), 'actor-ts-migrate-source-'));
    targetDirectory = mkdtempSync(join(tmpdir(), 'actor-ts-migrate-target-'));
  });
  afterEach(() => {
    for (const directory of [sourceDirectory, targetDirectory]) {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test('re-keys a snapshot from the source key to a different target key', async () => {
    const sourceEncryption = encryptionWith(1, 'acme/old/snapshot/v1');
    const targetEncryption = encryptionWith(2, 'acme/new/snapshot/v1');
    const src = storeOver(sourceDirectory);
    const tgt = storeOver(targetDirectory);
    try {
      await src.save('account-1', 7, { balance: 42 }, { encryption: sourceEncryption });

      const result = await migrateBetweenSnapshotStores<{ balance: number }>(src, tgt, {
        persistenceIds: ['account-1'],
        sourcePersistenceOptions: { encryption: sourceEncryption },
        targetPersistenceOptions: { encryption: targetEncryption },
      });
      expect(result.persistenceIdsCopied).toBe(1);

      const loaded = await tgt.loadLatest<{ balance: number }>('account-1', { encryption: targetEncryption });
      expect(loaded.toNullable()?.sequenceNr).toBe(7);
      expect(loaded.toNullable()?.state).toEqual({ balance: 42 });

      // Proof the write did not silently degrade: without the target key the
      // body is undecodable, so it is genuinely ciphertext and not plaintext
      // that merely happened to read back.
      await expect(tgt.loadLatest('account-1')).rejects.toThrow();
      await expect(tgt.loadLatest('account-1', { encryption: sourceEncryption })).rejects.toThrow();
    } finally {
      await src.close();
      await tgt.close();
    }
  });
});
