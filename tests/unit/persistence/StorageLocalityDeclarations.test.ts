import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import type { Cache } from '../../../src/cache/Cache.js';
import type { ObjectStorageBackend } from '../../../src/persistence/object-storage/ObjectStorageBackend.js';
import {
  CachedSnapshotStore,
  CachedSnapshotStoreOptions,
  FilesystemObjectStorageBackend,
  InMemoryDurableStateStore,
  InMemoryJournal,
  InMemorySnapshotStore,
  ObjectStorageSnapshotStore,
  PostgresJournal,
  SqliteDurableStateStore,
  SqliteJournal,
  SqliteSnapshotStore,
} from '../../../src/persistence/index.js';
import { none } from '../../../src/util/Option.js';

/**
 * Conformance sweep over the `storageLocality` capability (#1356) — the same
 * class of repo-file guard as `tests/unit/ci/OptionalPeerDeclarations.test.ts`.
 *
 * The contract member is deliberately OPTIONAL: absence means "unknown", and
 * the cluster's storage advisory stays silent for an undeclared store so a
 * third-party backend is never misjudged by a default it did not choose.  The
 * cost of that choice is a quiet rot channel — an in-repo backend added
 * without a declaration compiles, passes its own suite, and simply never
 * participates in the advisory.  This file closes the channel in both halves:
 * value assertions for what each family declares, and a repo scan that fails
 * when a store class neither declares the member nor inherits it from a
 * declaring base.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const PERSISTENCE_ROOT = join(REPOSITORY_ROOT, 'src', 'persistence');

/** The flat directories that hold every store and backend implementation. */
const STORE_DIRECTORIES = [
  'journals',
  'snapshot-stores',
  'durable-state-stores',
  'relational',
  'object-storage',
] as const;

/**
 * Bases that declare `storageLocality` for their whole family, so a subclass
 * inherits the declaration and its file legitimately never names it.
 * `RelationalStore` covers the relational trio and, transitively, every
 * dialect-supplying subclass; the SQLite durable-state store overrides it and
 * therefore names the member anyway.
 */
const DECLARING_BASES = [
  'RelationalStore',
  'RelationalJournal',
  'RelationalSnapshotStore',
  'RelationalDurableStateStore',
  'MongoStore',
  'DynamoDbStore',
] as const;

/**
 * Same line-level comment stripping as `OptionalPeerDeclarations.test.ts`, for
 * the same reason in both directions: a `storageLocality` named only in prose
 * must not satisfy the declaration requirement, and an `implements Journal`
 * quoted in a doc block must not drag a non-store file into the scan.
 */
function withoutCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

type ScannedStoreFile = {
  readonly path: string;
  readonly declares: boolean;
  readonly declaresIdentity: boolean;
  readonly inheritsDeclaringBase: boolean;
};

/** Every file in the store directories whose class implements a store contract or backend. */
function scanStoreFiles(): readonly ScannedStoreFile[] {
  const implementsContract = /implements (Journal|SnapshotStore|DurableStateStore|ObjectStorageBackend)\b/;
  const extendsDeclaringBase = new RegExp(`extends (${DECLARING_BASES.join('|')})\\b`);
  const files: ScannedStoreFile[] = [];
  for (const directory of STORE_DIRECTORIES) {
    for (const entry of readdirSync(join(PERSISTENCE_ROOT, directory))) {
      if (!entry.endsWith('.ts')) continue;
      const path = `${directory}/${entry}`;
      const source = withoutCommentLines(readFileSync(join(PERSISTENCE_ROOT, directory, entry), 'utf8'));
      const isStoreFile = implementsContract.test(source) || extendsDeclaringBase.test(source);
      if (!isStoreFile) continue;
      files.push({
        path,
        declares: source.includes('storageLocality'),
        declaresIdentity: source.includes('storageIdentity'),
        inheritsDeclaringBase: extendsDeclaringBase.test(source),
      });
    }
  }
  return files;
}

describe('storageLocality declarations', () => {
  test('node-local families declare node-local', () => {
    expect(new InMemoryJournal().storageLocality).toBe('node-local');
    expect(new InMemorySnapshotStore().storageLocality).toBe('node-local');
    expect(new InMemoryDurableStateStore().storageLocality).toBe('node-local');
    expect(new SqliteJournal().storageLocality).toBe('node-local');
    expect(new SqliteSnapshotStore().storageLocality).toBe('node-local');
    // The one relational store on a local file — overrides the family default.
    expect(new SqliteDurableStateStore({ path: ':memory:' }).storageLocality).toBe('node-local');
    expect(new FilesystemObjectStorageBackend({ dir: 'storage-locality-fixture' }).storageLocality).toBe('node-local');
  });

  test('shared families declare shared', () => {
    // Representative of the relational base declaration; the repo scan below
    // holds the rest of the family to the same inheritance.
    expect(new PostgresJournal().storageLocality).toBe('shared');
  });

  /**
   * The escape hatch the multi-node fixtures rely on: ONE in-memory instance
   * handed to several in-process systems genuinely is shared storage, which is
   * why the property is instance-level and writable there rather than a
   * class-level assumption (#1356).
   */
  test('in-memory stores can be re-declared shared by a shared fixture', () => {
    const journal = new InMemoryJournal();
    journal.storageLocality = 'shared';
    expect(journal.storageLocality).toBe('shared');
    const snapshotStore = new InMemorySnapshotStore();
    snapshotStore.storageLocality = 'shared';
    expect(snapshotStore.storageLocality).toBe('shared');
    const durableStateStore = new InMemoryDurableStateStore();
    durableStateStore.storageLocality = 'shared';
    expect(durableStateStore.storageLocality).toBe('shared');
  });

  /**
   * Wrappers must not have an opinion of their own: a cache in front of a
   * store and an object-storage store over a backend are exactly as local as
   * the storage underneath, undefined included — a wrapper that defaulted
   * would launder "unknown" into a confident answer.
   */
  test('wrappers delegate to what they wrap', () => {
    const fakeCache = { get: async () => null, set: async () => {}, delete: async () => {} } as unknown as Cache;
    const cachedOptions = CachedSnapshotStoreOptions.create().withCache(fakeCache);
    const inner = new InMemorySnapshotStore();
    const cached = new CachedSnapshotStore(inner, cachedOptions);
    expect(cached.storageLocality).toBe('node-local');
    inner.storageLocality = 'shared';
    expect(cached.storageLocality).toBe('shared');

    const sharedBackend: ObjectStorageBackend = {
      storageLocality: 'shared',
      async put() { return { etag: 'fixture' }; },
      async get() { return none; },
      async delete() {},
      async list() { return []; },
    };
    expect(new ObjectStorageSnapshotStore({ backend: sharedBackend }).storageLocality).toBe('shared');

    const undeclaredBackend: ObjectStorageBackend = {
      async put() { return { etag: 'fixture' }; },
      async get() { return none; },
      async delete() {},
      async list() { return []; },
    };
    expect(new ObjectStorageSnapshotStore({ backend: undeclaredBackend }).storageLocality).toBeUndefined();
  });

  /**
   * The repo half: every in-repo store class either names `storageLocality`
   * in code or extends a base that declares it for the family.  Guards the
   * guard first — the scan is a pair of regexes over class-declaration lines,
   * and a refactor that reformatted them would empty the list and turn the
   * absence assertion below vacuous.
   */
  test('every in-repo store declares or inherits a locality', () => {
    const storeFiles = scanStoreFiles();
    expect(
      storeFiles.length,
      'The store scan found almost nothing under src/persistence. Either the '
      + 'directories moved or the class declarations no longer match the '
      + '`implements`/`extends` patterns — the declaration assertion below '
      + 'would pass by having nothing to check.',
    ).toBeGreaterThan(25);
    expect(
      storeFiles.filter((file) => !file.inheritsDeclaringBase).length,
      'No store class implements a contract directly any more — every file '
      + 'matched as a subclass of a declaring base. That inverts the scan\'s '
      + 'assumptions; re-derive DECLARING_BASES.',
    ).toBeGreaterThan(10);

    const undeclared = storeFiles
      .filter((file) => !file.declares && !file.inheritsDeclaringBase)
      .map((file) => file.path);
    expect(
      undeclared,
      'These store classes neither declare `storageLocality` nor extend a '
      + 'base that declares it for the family. An undeclared store is '
      + '"unknown" to the cluster storage advisory, which stays silent for it '
      + '— fine for third-party code, silent rot for ours. Declare '
      + '`\'node-local\'` or `\'shared\'` on the class (or its family base), '
      + 'with the JSDoc saying why (#1356).',
    ).toEqual([]);

    const withoutIdentity = storeFiles
      .filter((file) => !file.declaresIdentity && !file.inheritsDeclaringBase)
      .map((file) => file.path);
    expect(
      withoutIdentity,
      'These store classes neither implement `storageIdentity()` nor extend a '
      + 'base that implements it for the family. Without it, two nodes on two '
      + 'different databases of this backend are indistinguishable to the '
      + 'cluster (#1358) — mint an identity in the database on first contact, '
      + 'or delegate to what the store wraps.',
    ).toEqual([]);
  });
});
