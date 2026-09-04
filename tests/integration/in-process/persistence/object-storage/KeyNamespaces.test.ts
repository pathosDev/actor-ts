/**
 * Regression suite for #716 — the object-storage snapshot store trusted
 * prefix membership.
 *
 * It derived `<prefix><persistenceId>/`, listed it, and took whatever came
 * back last, without checking that the key had the shape of one of its own
 * snapshots or that the body it decoded named the entity it was asked about.
 *
 * The reported headline — a nested `persistenceId` such as `user1/zzz`
 * nesting inside `user1` — is dead at the actor boundary since #133, which
 * refuses a path separator in an id.  What survived is worse, and needs no
 * invalid id at all: `registerObjectStoragePlugins` hands the snapshot store
 * and the durable-state store the *same* backend and the *same* prefix, and
 * the durable-state key `<prefix><pid>/state.json` therefore landed inside
 * the snapshot store's own directory, where `'state.json'` collates after
 * every zero-padded sequence key.  One entity persisted both ways — no
 * mistake on the application's part, one call to wire it up — and
 * `loadLatest` returned the durable-state record.  That body has no
 * `sequenceNr`, so `assertTrustworthySnapshot` rejected it and recovery died
 * with `SnapshotIntegrityError`: an actor that could not start.
 *
 * Three fixes, and each of the three describes below reverts to one of them:
 *
 *   1. `fetchSnapshot` compares the body's own `persistenceId` to the one it
 *      was asked for, and answers `none` on a mismatch.
 *   2. Every list-driven path — load-latest, load-before, delete, prune —
 *      filters the listing to keys shaped like this store's own snapshots.
 *   3. The two stores have disjoint key namespaces (`snapshots/`, `state/`)
 *      under the prefix they share.
 *
 * 1 and 2 are deliberately paired.  A `none` return rather than a throw is
 * what lets recovery replay the journal instead of failing, and the shape
 * filter is what makes the newest *well-formed* snapshot the one that gets
 * offered in the first place; either alone would only trade one failure for
 * another.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { PersistenceExtensionId } from '../../../../../src/persistence/PersistenceExtension.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { replayState } from '../../../../../src/persistence/Replay.js';
import {
  OBJECT_STORAGE_SNAPSHOT_NAMESPACE,
} from '../../../../../src/persistence/Constants.js';
import { FilesystemObjectStorageBackend } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { encodeBody } from '../../../../../src/persistence/object-storage/BodyCodec.js';
import {
  OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID,
  registerObjectStoragePlugins,
} from '../../../../../src/persistence/object-storage/ObjectStoragePlugin.js';
import { ObjectStoragePluginOptions } from '../../../../../src/persistence/object-storage/ObjectStoragePluginOptions.js';
import { ObjectStorageSnapshotStore } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStore.js';
import { ObjectStorageSnapshotStoreOptions } from '../../../../../src/persistence/snapshot-stores/ObjectStorageSnapshotStoreOptions.js';
import { encodePayload } from '../../../../../src/persistence/storage/PayloadCodec.js';

let dir: string;
let backend: FilesystemObjectStorageBackend;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actor-ts-namespaces-'));
  const backendOptions = FilesystemObjectStorageOptions.create()
    .withDir(dir);
  backend = new FilesystemObjectStorageBackend(backendOptions);
});

afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A snapshot store over the shared backend, with pruning off unless asked. */
function snapshotStore(keepN = 0): ObjectStorageSnapshotStore {
  const storeOptions = ObjectStorageSnapshotStoreOptions.create()
    .withBackend(backend)
    .withCompression({ algorithm: 'none' })
    .withKeepN(keepN);
  return new ObjectStorageSnapshotStore(storeOptions);
}

/** The directory a key lives in — everything up to its last separator. */
function directoryOf(key: string): string {
  return key.slice(0, key.lastIndexOf('/') + 1);
}

/**
 * A body the store's own read path accepts, written straight to the backend
 * so the key and the `persistenceId` inside it can disagree.
 */
async function putSnapshotBody(
  key: string,
  persistenceId: string,
  sequenceNr: number,
  state: unknown,
): Promise<void> {
  const body = await encodeBody(
    utf8(encodePayload({ persistenceId, sequenceNr, state, timestamp: 1 })),
    { compression: 'none' },
  );
  await backend.put(key, body, { contentType: 'application/json' });
}

/* ============ criterion 3 — the two stores' namespaces are disjoint ======= */

describe('#716 — the snapshot and durable-state corpora are disjoint', () => {
  test('one prefix, one backend, and still never one directory', async () => {
    // Deliberately stated without naming either namespace segment: the
    // invariant is that the two corpora do not share a directory, not that
    // they are spelled any particular way.  A test that asserted the spelling
    // would pass on a tree where both stores were renamed into one namespace.
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: { 'snapshot-store': { plugin: OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID } },
        },
      });
    const sys = ActorSystem.create('namespaces-disjoint', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'custom', backend })
      .withPrefix('shared/');
    const { durableStateStore } = await registerObjectStoragePlugins(ext, pluginOptions);

    await durableStateStore.upsert('account-1', 0, { balance: 100 });
    await ext.snapshotStore.save('account-1', 5, { balance: 42 });

    const keys = (await backend.list({ prefix: 'shared/' })).map((item) => item.key);
    const durableStateKey = keys.find((key) => key.endsWith('/state.json'));
    const snapshotKey = keys.find((key) => key.endsWith('5.json'));
    expect(durableStateKey).toBeDefined();
    expect(snapshotKey).toBeDefined();
    expect(directoryOf(durableStateKey!)).not.toBe(directoryOf(snapshotKey!));

    // Neither directory is inside the other either, which is the property
    // that actually bounds a LIST: one prefix must not enumerate the other.
    expect(directoryOf(durableStateKey!).startsWith(directoryOf(snapshotKey!))).toBe(false);
    expect(directoryOf(snapshotKey!).startsWith(directoryOf(durableStateKey!))).toBe(false);

    await sys.terminate();
  });

  test('an entity persisted both ways recovers from its own snapshot', async () => {
    // The live defect end to end.  Before the split this replay raised
    // SnapshotIntegrityError, because loadLatest returned the durable-state
    // record and `Number.isInteger(undefined)` is false.
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: { 'snapshot-store': { plugin: OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID } },
        },
      });
    const sys = ActorSystem.create('namespaces-recovery', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const pluginOptions = ObjectStoragePluginOptions.create()
      .withBackend({ kind: 'custom', backend })
      .withPrefix('shared/');
    const { durableStateStore } = await registerObjectStoragePlugins(ext, pluginOptions);

    const journal = new InMemoryJournal();
    await journal.append('account-1', [{ event: { amount: 40 } }, { event: { amount: 2 } }], 0);
    await ext.snapshotStore.save('account-1', 2, { balance: 42 });
    // …and the same id also carries a durable-state record.
    await durableStateStore.upsert('account-1', 0, { balance: 999 });

    const replayed = await replayState<{ amount: number }, { balance: number }>({
      journal,
      snapshotStore: ext.snapshotStore,
      persistenceId: 'account-1',
      initialState: () => ({ balance: 0 }),
      fold: (state, event) => ({ balance: state.balance + event.amount }),
    });
    expect(replayed.fromSnapshotSequenceNr).toBe(2);
    expect(replayed.state).toEqual({ balance: 42 });

    await sys.terminate();
  });
});

/* ============= criterion 2 — the list-driven paths filter by shape ======== */

describe('#716 — only this store\'s own keys are read, deleted or pruned', () => {
  test('loadLatest skips a foreign object and returns the newest real snapshot', async () => {
    const store = snapshotStore();
    await store.save('p', 3, { step: 'a' });
    await store.save('p', 7, { step: 'b' });
    // Sorts after every sequence key, exactly as `state.json` did.
    await backend.put(
      `${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}p/zzz-marker.txt`,
      utf8('not a snapshot'),
      { contentType: 'text/plain' },
    );

    const latest = await store.loadLatest<{ step: string }>('p');
    expect(latest.toNullable()?.sequenceNr).toBe(7);
    expect(latest.toNullable()?.state).toEqual({ step: 'b' });
  });

  test('delete leaves a foreign key alone even when its tail parses as a sequence', async () => {
    // `delete` and `pruneToKeepN` were only *incidentally* safe before: they
    // ran a `(\d{1,20})\.json$` parser over every listed key and it happened
    // to return nothing for most foreign ones.  It did not for this one —
    // the old parser read `42` out of it and deleted another tool's object.
    const store = snapshotStore();
    await store.save('p', 1, {});
    await store.save('p', 9, {});
    const foreignKey = `${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}p/backup-42.json`;
    await backend.put(foreignKey, utf8('another tool\'s object'), { contentType: 'text/plain' });

    await store.delete('p', 100);

    expect((await backend.get(foreignKey)).isSome()).toBe(true);
    expect((await store.loadLatest('p')).isNone()).toBe(true);
  });

  test('loadBefore ignores a foreign key whose tail parses as a sequence', async () => {
    const store = snapshotStore();
    await store.save('p', 1, { step: 'first' });
    await backend.put(
      `${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}p/backup-5.json`,
      utf8('another tool\'s object'),
      { contentType: 'text/plain' },
    );

    // The foreign key sorts after the real one and its tail reads as 5, so
    // the old scan chose it and then failed to decode it.
    const before = await store.loadBefore<{ step: string }>('p', 9);
    expect(before.toNullable()?.sequenceNr).toBe(1);
    expect(before.toNullable()?.state).toEqual({ step: 'first' });
  });

  test('prune counts the entity\'s own snapshots, not everything under its prefix', async () => {
    // keepN is a promise about how many of the entity's OWN snapshots
    // survive.  Counting a stranger's object towards it cost the entity one
    // of its retained snapshots per foreign object — silently, on the write
    // path, in a best-effort pass whose failures are swallowed.
    await backend.put(
      `${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}p/zzz-marker.txt`,
      utf8('not a snapshot'),
      { contentType: 'text/plain' },
    );
    const store = snapshotStore(3);
    await store.save('p', 1, {});
    await store.save('p', 2, {});
    await store.save('p', 3, {});

    expect((await store.loadLatest('p')).toNullable()?.sequenceNr).toBe(3);
    expect((await store.loadBefore('p', 2)).toNullable()?.sequenceNr).toBe(1);
  });

  test('a nested persistenceId is invisible to the entity it nests under', async () => {
    // The reported headline exploit.  An id containing `/` cannot reach a
    // store through an actor any more (#133 refuses it at `preStart`), but a
    // migration script or a custom wrapper still calls `save` directly —
    // store-level id validation is #1070 — and the read-across is what this
    // filter closes regardless of how the key got there.
    const store = snapshotStore();
    await store.save('user1', 7, { owner: 'victim' });
    await store.save('user1/zzz', 1, { owner: 'ATTACKER' });

    const latest = await store.loadLatest<{ owner: string }>('user1');
    expect(latest.toNullable()?.state).toEqual({ owner: 'victim' });

    // …and the outer entity's delete does not reach across into it either.
    await store.delete('user1', 100);
    expect((await store.loadLatest<{ owner: string }>('user1/zzz')).toNullable()?.state)
      .toEqual({ owner: 'ATTACKER' });
  });
});

/* ========== criterion 1 — the body has to name the entity asked for ======= */

describe('#716 — a snapshot body must name the entity it is handed to', () => {
  test('a body naming another entity is not returned as this entity\'s state', async () => {
    const store = snapshotStore();
    await store.save('victim', 1, { balance: 100 });
    // A well-formed key of the victim's own — so the shape filter accepts it
    // — holding a body written for someone else.  Reachable wherever the
    // bucket has a second writer: a co-tenant, an insider, a restore that
    // put one entity's object under another's key.
    await putSnapshotBody(
      `${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}victim/00000000000000000009.json`,
      'attacker',
      9,
      { balance: 999_999 },
    );

    const latest = await store.loadLatest<{ balance: number }>('victim');
    expect(latest.toNullable()?.state).not.toEqual({ balance: 999_999 });
    expect(latest.toNullable()?.persistenceId).not.toBe('attacker');
  });

  test('the mismatch answers none rather than throwing, so recovery replays', async () => {
    // The choice matters as much as the check.  Throwing would swap a wrong
    // starting state for an actor that cannot start — the very failure the
    // namespace split removes — so the store reports "no snapshot" and lets
    // the journal be the source of truth.
    const store = snapshotStore();
    await putSnapshotBody(
      `${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}victim/00000000000000000009.json`,
      'attacker',
      9,
      { balance: 999_999 },
    );

    expect((await store.loadLatest('victim')).isNone()).toBe(true);

    const journal = new InMemoryJournal();
    await journal.append('victim', [{ event: { amount: 3 } }], 0);
    const replayed = await replayState<{ amount: number }, { balance: number }>({
      journal,
      snapshotStore: store,
      persistenceId: 'victim',
      initialState: () => ({ balance: 0 }),
      fold: (state, event) => ({ balance: state.balance + event.amount }),
    });
    expect(replayed.fromSnapshotSequenceNr).toBeNull();
    expect(replayed.state).toEqual({ balance: 3 });
  });

  test('loadBefore checks the body too, not only loadLatest', async () => {
    const store = snapshotStore();
    await putSnapshotBody(
      `${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}victim/00000000000000000004.json`,
      'attacker',
      4,
      { balance: 999_999 },
    );
    expect((await store.loadBefore('victim', 9)).isNone()).toBe(true);
  });
});
