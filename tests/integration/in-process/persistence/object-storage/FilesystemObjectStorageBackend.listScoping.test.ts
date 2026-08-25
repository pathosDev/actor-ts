/**
 * #746 — `FilesystemObjectStorageBackend.list` must read only the directory
 * its prefix names, not the whole storage root.
 *
 * The defect was pure complexity: the walk started at the root and used the
 * prefix as a post-hoc `startsWith` filter on files, so a snapshot
 * `loadLatest` for one entity read every *other* entity's directory — O(N)
 * in the entity count for an O(1) question, on the actor's mailbox.
 *
 * None of that is visible in what `list` returns: the fixed implementation
 * and the broken one hand back byte-identical arrays.  The only observable
 * is how many directories got read, so these tests count `readdir` calls by
 * seeding the backend's `fsLazy` with a wrapper around the real module —
 * `Lazy.setOverride` is the documented test hook for exactly this.
 *
 * `mock.module('node:fs/promises', …)` is NOT an alternative here: replacing
 * that module out from under Bun's own test runner hangs the run before the
 * first test reports (measured on Bun 1.4.0, Windows).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilesystemObjectStorageBackend,
  fsLazy,
  type DirectoryEntry,
} from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';

let tmpRoot: string;
let backend: FilesystemObjectStorageBackend;
let directoriesRead: string[] = [];

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Wrap the memoised `node:fs/promises` with a `readdir` that records the
 * directory it was handed and then delegates.  Behaviour is unchanged — the
 * wrapper only observes — so a leak past `afterEach` could not corrupt
 * another suite even if the reset were missed.
 */
const installReaddirCounter = async (): Promise<void> => {
  const real = await fsLazy.get();
  fsLazy.setOverride(Promise.resolve({
    path: real.path,
    fs: {
      ...real.fs,
      readdir: (p: string, options: { withFileTypes: true }): Promise<DirectoryEntry[]> => {
        directoriesRead.push(p);
        return real.fs.readdir(p, options);
      },
    },
  }));
};

/** One snapshot per entity, laid out the way `ObjectStorageSnapshotStore` does. */
const seedEntities = async (from: number, to: number): Promise<void> => {
  for (let i = from; i < to; i++) {
    await backend.put(`snapshots/entity-${i}/${String(i).padStart(20, '0')}.json`, bytes(`s${i}`));
  }
};

beforeEach(async () => {
  fsLazy.reset();
  directoriesRead = [];
  tmpRoot = mkdtempSync(join(tmpdir(), 'actor-ts-objstore-scope-'));
  const backendOptions = FilesystemObjectStorageOptions.create().withDir(tmpRoot);
  backend = new FilesystemObjectStorageBackend(backendOptions);
  await installReaddirCounter();
});

afterEach(() => {
  fsLazy.reset();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('FilesystemObjectStorageBackend — list is prefix-scoped (#746)', () => {
  test('a prefixed list reads only the directory the prefix names', async () => {
    await seedEntities(0, 6);
    directoriesRead = [];

    const items = await backend.list({ prefix: 'snapshots/entity-3/' });

    expect(items.map((i) => i.key)).toEqual(['snapshots/entity-3/00000000000000000003.json']);
    // Exactly one directory: `<root>/snapshots/entity-3`.  Walking from the
    // root would have read `<root>`, `<root>/snapshots` and all six entity
    // directories instead.
    expect(directoriesRead).toHaveLength(1);
    expect(directoriesRead[0]).toBe(join(tmpRoot, 'snapshots', 'entity-3'));
  });

  test('the cost of a prefixed list does not grow with the number of unrelated entities', async () => {
    await seedEntities(0, 4);
    directoriesRead = [];
    await backend.list({ prefix: 'snapshots/entity-1/' });
    const readsWithFourEntities = directoriesRead.length;

    // Twenty more entities land in the same root.  Nothing about the
    // question "what snapshots does entity-1 have" changed, so nothing
    // about the work may change either — that equality IS the fix.
    await seedEntities(4, 24);
    directoriesRead = [];
    await backend.list({ prefix: 'snapshots/entity-1/' });
    const readsWithTwentyFourEntities = directoriesRead.length;

    expect(readsWithFourEntities).toBe(1);
    expect(readsWithTwentyFourEntities).toBe(readsWithFourEntities);
  });

  test('a positive limit stops the walk instead of trimming a finished array', async () => {
    await backend.put('data/c', bytes('c'));
    await backend.put('data/deep/x', bytes('x'));
    await backend.put('data/e', bytes('e'));

    directoriesRead = [];
    const limited = await backend.list({ prefix: 'data/', limit: 1 });
    const readsWithLimit = directoriesRead.length;

    directoriesRead = [];
    const unlimited = await backend.list({ prefix: 'data/' });
    const readsWithoutLimit = directoriesRead.length;

    expect(limited.map((i) => i.key)).toEqual(['data/c']);
    expect(unlimited.map((i) => i.key)).toEqual(['data/c', 'data/deep/x', 'data/e']);
    // `data/c` satisfies the limit before `data/deep` is reached, so that
    // subdirectory is never opened.
    expect(readsWithLimit).toBe(1);
    expect(readsWithoutLimit).toBe(2);
  });

  test('an empty prefix still walks the whole root', async () => {
    // The list-all semantic has no directory to narrow to, and must keep
    // descending everywhere — the regression the narrowing could cause.
    await seedEntities(0, 3);
    await backend.put('other/thing', bytes('t'));
    directoriesRead = [];

    const items = await backend.list({ prefix: '' });

    expect(items.map((i) => i.key).sort()).toEqual([
      'other/thing',
      'snapshots/entity-0/00000000000000000000.json',
      'snapshots/entity-1/00000000000000000001.json',
      'snapshots/entity-2/00000000000000000002.json',
    ]);
    // root + snapshots + three entity dirs + other = 6.
    expect(directoriesRead).toHaveLength(6);
  });

  test('a prefix ending mid-segment narrows to the parent directory, not past it', async () => {
    // `mine/e` is a partial segment: `mine/e0/…` and `mine/e10/…` both match
    // it, so the deepest safe entry point is `mine`.  Splitting anywhere but
    // the last `/` would drop one of them.
    await backend.put('mine/e0/a.json', bytes('a'));
    await backend.put('mine/e10/b.json', bytes('b'));
    await backend.put('mine/f1/c.json', bytes('c'));
    directoriesRead = [];

    const items = await backend.list({ prefix: 'mine/e' });

    expect(items.map((i) => i.key)).toEqual(['mine/e0/a.json', 'mine/e10/b.json']);
    // `<root>/mine` plus its three children — `mine/f1` is still opened,
    // because a directory name is not a key and cannot be pruned on the
    // partial segment without risking a miss.  What is NOT read is the
    // storage root.
    expect(directoriesRead).toHaveLength(4);
    expect(directoriesRead).not.toContain(tmpRoot);
  });
});

describe('FilesystemObjectStorageBackend — list tolerates an absent prefix directory (#746)', () => {
  test('a prefix under a directory nothing ever wrote to returns an empty listing', async () => {
    // Reachable only because the walk now starts at that directory: the
    // root-anchored walk never opened a path that did not exist.
    await backend.put('present/a.json', bytes('a'));
    directoriesRead = [];

    expect(await backend.list({ prefix: 'absent/x' })).toEqual([]);
    expect(directoriesRead).toEqual([join(tmpRoot, 'absent')]);
  });

  test('a prefix whose directory portion is an ordinary file returns an empty listing', async () => {
    // The root-anchored walk dropped this case through the `startsWith`
    // filter; seeding the walk at `<root>/plain` turns it into an ENOTDIR
    // that has to be tolerated rather than surfaced.
    writeFileSync(join(tmpRoot, 'plain'), 'not a directory');

    expect(await backend.list({ prefix: 'plain/inside' })).toEqual([]);
  });

  test('a prefix with empty or "." segments matches nothing, as before', async () => {
    // No key on disk contains `//` or a `.` segment — `put` normalises them
    // away — so such a prefix could never match, and the narrowing must not
    // invent a key shape that makes it match.
    await backend.put('a/bar', bytes('x'));

    expect(await backend.list({ prefix: 'a//b' })).toEqual([]);
    expect(await backend.list({ prefix: 'a/./b' })).toEqual([]);
  });
});

describe('FilesystemObjectStorageBackend — limited listings stay a prefix of the full one (#746)', () => {
  test('every limit returns exactly the first N keys of the unlimited listing', async () => {
    // The early exit keeps whichever entries the walk reached first, so the
    // depth-first order has to agree with the ascending key order.  The
    // hazard is a directory and a file sharing a stem: raw entry names put
    // `d` before `d.txt`, while the keys `d/x` and `d.txt` sort the other
    // way round, because `.` precedes `/`.
    await backend.put('data/c', bytes('c'));
    await backend.put('data/d.txt', bytes('t'));
    await backend.put('data/d/x', bytes('x'));
    await backend.put('data/d/y', bytes('y'));
    await backend.put('data/e', bytes('e'));

    const full = (await backend.list({ prefix: 'data/' })).map((i) => i.key);
    expect(full).toEqual(['data/c', 'data/d.txt', 'data/d/x', 'data/d/y', 'data/e']);

    for (let limit = 1; limit <= full.length; limit++) {
      const limited = await backend.list({ prefix: 'data/', limit });
      expect(limited.map((i) => i.key)).toEqual(full.slice(0, limit));
    }
  });

  test('a non-positive limit keeps its historical slice semantics', async () => {
    // `limit: 0` is falsy and has always meant "no limit"; a negative one
    // has always reached `slice(0, -1)`.  Neither may start pruning the
    // walk, or the early exit would change behaviour nobody asked it to.
    for (let i = 0; i < 3; i++) await backend.put(`p/${i}`, bytes(String(i)));

    expect((await backend.list({ prefix: 'p/', limit: 0 })).map((i) => i.key))
      .toEqual(['p/0', 'p/1', 'p/2']);
    expect((await backend.list({ prefix: 'p/', limit: -1 })).map((i) => i.key))
      .toEqual(['p/0', 'p/1']);
  });
});
