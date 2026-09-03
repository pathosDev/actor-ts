import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomId } from '../../../../../src/util/RandomString.js';
import {
  FilesystemObjectStorageBackend,
  fsLazy,
  type FsModule,
} from '../../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { FilesystemObjectStorageOptions } from '../../../../../src/persistence/object-storage/FilesystemObjectStorageOptions.js';
import { ObjectStorageConcurrencyError } from '../../../../../src/persistence/object-storage/ObjectStorageBackend.js';

let tmpRoot: string;
let backend: FilesystemObjectStorageBackend;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'actor-ts-objstore-'));
  const backendOptions = FilesystemObjectStorageOptions.create()
    .withDir(tmpRoot);
  backend = new FilesystemObjectStorageBackend(backendOptions);
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('FilesystemObjectStorageBackend — basic CRUD', () => {
  test('put then get round-trips the body and exposes a non-empty etag', async () => {
    const { etag } = await backend.put('a/b.json', bytes('hello'));
    expect(etag).toMatch(/^"fs-/);
    const fetched = await backend.get('a/b.json');
    expect(fetched.isSome()).toBe(true);
    if (fetched.isSome()) {
      expect(new TextDecoder().decode(fetched.value.body)).toBe('hello');
      expect(fetched.value.etag).toBe(etag);
    }
  });

  test('get returns None for an unknown key', async () => {
    const fetched = await backend.get('does/not/exist');
    expect(fetched.isNone()).toBe(true);
  });

  test('delete is idempotent', async () => {
    await backend.put('to-go', bytes('x'));
    await backend.delete('to-go');
    await backend.delete('to-go');                  // no throw
    expect((await backend.get('to-go')).isNone()).toBe(true);
  });

  test('list returns objects sorted ascending by key, filtered by prefix', async () => {
    await backend.put('foo/2', bytes('2'));
    await backend.put('foo/1', bytes('1'));
    await backend.put('bar/1', bytes('x'));
    const items = await backend.list({ prefix: 'foo/' });
    expect(items.map(i => i.key)).toEqual(['foo/1', 'foo/2']);
  });

  test('list honours the limit', async () => {
    // Asserting WHICH two, not just how many: the walk stops early under a
    // limit (#746), so a length-only expectation would pass against an
    // implementation that returns an arbitrary — or filesystem-order —
    // subset instead of the first two keys.
    for (let i = 0; i < 5; i++) await backend.put(`p/${i}`, bytes(String(i)));
    const items = await backend.list({ prefix: 'p/', limit: 2 });
    expect(items.map(i => i.key)).toEqual(['p/0', 'p/1']);
  });

  test('content-encoding metadata is round-tripped', async () => {
    await backend.put('with-meta', bytes('x'), { contentEncoding: 'gzip', contentType: 'application/json' });
    const fetched = await backend.get('with-meta');
    expect(fetched.isSome()).toBe(true);
    if (fetched.isSome()) {
      expect(fetched.value.contentEncoding).toBe('gzip');
      expect(fetched.value.contentType).toBe('application/json');
    }
  });

  test('list ignores internal control files (.lock, .meta.json, .tmp.*)', async () => {
    // Stage a real object so list() walks the directory.
    await backend.put('real', bytes('value'));
    // Drop control-file artefacts that any backend operation could leave
    // behind — they must never surface as listed objects.
    //
    // The temp name is built from the same `process.pid` + `randomId` the
    // writer uses rather than being spelled out, because a hand-written
    // fixture is exactly how this regressed: when `put` moved off
    // `Math.random()`, the literal `real.tmp.99.1700000000.42` still matched
    // the (now stale) skip pattern, so the test stayed green while `list`
    // had stopped recognising the shape `put` actually emits (#909).
    writeFileSync(join(tmpRoot, 'real.lock'), '12345 2024-01-01\n');
    writeFileSync(join(tmpRoot, `real.tmp.${process.pid}.${randomId(12)}`), 'partial');
    writeFileSync(join(tmpRoot, 'real.meta.json'), '{}');
    const items = await backend.list({ prefix: '' });
    expect(items.map(i => i.key)).toEqual(['real']);
  });

  test('list still ignores temp files left by an older version', async () => {
    // A directory written before the `randomId` switch can hold leftovers in
    // the old `.tmp.<pid>.<ts>.<rand>` form; upgrading must not start
    // reporting them as objects.
    await backend.put('real', bytes('value'));
    writeFileSync(join(tmpRoot, 'real.tmp.99.1700000000.42'), 'partial');
    const items = await backend.list({ prefix: '' });
    expect(items.map(i => i.key)).toEqual(['real']);
  });

  test('a real key that merely looks temp-ish is still listed', () => {
    // The skip pattern is a filename heuristic, so it has to be tight enough
    // not to swallow ordinary keys.  `.tmp` alone, or a non-numeric middle
    // segment, is not the shape `put` emits.
    writeFileSync(join(tmpRoot, 'notes.tmp'), 'a real object');
    writeFileSync(join(tmpRoot, 'notes.tmp.draft.beef'), 'also real');
    return backend.list({ prefix: '' }).then(items => {
      expect(items.map(i => i.key).sort()).toEqual(['notes.tmp', 'notes.tmp.draft.beef']);
    });
  });
});

describe('FilesystemObjectStorageBackend — CAS', () => {
  test('ifNoneMatch=* succeeds on first write, fails on second', async () => {
    await backend.put('cas/key', bytes('first'), { ifNoneMatch: '*' });
    await expect(
      backend.put('cas/key', bytes('second'), { ifNoneMatch: '*' }),
    ).rejects.toBeInstanceOf(ObjectStorageConcurrencyError);
  });

  test('ifMatch with the correct etag succeeds; with a stale etag fails', async () => {
    const { etag: etagV1 } = await backend.put('cas/key', bytes('v1'));
    const { etag: etagV2 } = await backend.put('cas/key', bytes('v2'), { ifMatch: etagV1 });
    expect(etagV2).not.toBe(etagV1);
    await expect(
      backend.put('cas/key', bytes('v3'), { ifMatch: etagV1 }),
    ).rejects.toBeInstanceOf(ObjectStorageConcurrencyError);
  });

  test('ifMatch on a non-existent key fails (no current etag)', async () => {
    await expect(
      backend.put('absent', bytes('x'), { ifMatch: '"fs-deadbeef-1"' }),
    ).rejects.toBeInstanceOf(ObjectStorageConcurrencyError);
  });

  test('etag is content-derived: equal bytes → equal etag across instances', async () => {
    // Disk-canonical guarantee — a fresh backend instance must produce
    // exactly the same etag as the original, because the etag is derived
    // from the file content alone (no hidden in-memory state).
    const { etag: e1 } = await backend.put('stable', bytes('hello'));
    await backend.close();

    const backendOptions = FilesystemObjectStorageOptions.create()
      .withDir(tmpRoot);
    const fresh = new FilesystemObjectStorageBackend(backendOptions);
    const fetched = await fresh.get('stable');
    expect(fetched.isSome()).toBe(true);
    if (fetched.isSome()) {
      expect(fetched.value.etag).toBe(e1);
    }
    // And ifMatch with the original etag must succeed on the fresh
    // instance — the killer test for "no in-memory ETag map".
    await fresh.put('stable', bytes('world'), { ifMatch: e1 });
  });
});

describe('FilesystemObjectStorageBackend — concurrency', () => {
  test('concurrent ifNoneMatch=* puts: exactly one wins, others see CAS error', async () => {
    // The whole point of #19's fix: CAS is enforced by the per-key file
    // lock, not by an in-memory map.  Hammering the same key with N
    // concurrent create-only puts must leave exactly one survivor — the
    // OS-level atomic-create on the lock file is what serializes them.
    const N = 12;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        backend.put('cas/race', bytes(`v${i}`), { ifNoneMatch: '*' }),
      ),
    );
    const wins = results.filter(r => r.status === 'fulfilled').length;
    const cas = results.filter(
      r => r.status === 'rejected' && r.reason instanceof ObjectStorageConcurrencyError,
    ).length;
    expect(wins).toBe(1);
    expect(cas).toBe(N - 1);

    // Disk state must be one of the bodies — never empty, never garbage.
    const final = await backend.get('cas/race');
    expect(final.isSome()).toBe(true);
    if (final.isSome()) {
      const text = new TextDecoder().decode(final.value.body);
      expect(text).toMatch(/^v\d+$/);
    }
  });

  test('concurrent ifMatch puts with a shared expected etag: exactly one succeeds', async () => {
    // Classic compare-and-swap race: many writers all observed v0 and
    // each tries to publish a successor with `ifMatch: e0`.  Only the
    // first to acquire the lock advances the etag; the rest see the
    // updated disk state and fail their CAS.
    const { etag: e0 } = await backend.put('cas/race', bytes('v0'));
    const N = 10;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        backend.put('cas/race', bytes(`v${i + 1}`), { ifMatch: e0 }),
      ),
    );
    const wins = results.filter(r => r.status === 'fulfilled').length;
    const cas = results.filter(
      r => r.status === 'rejected' && r.reason instanceof ObjectStorageConcurrencyError,
    ).length;
    expect(wins).toBe(1);
    expect(cas).toBe(N - 1);
  });

  test('concurrent puts on different keys do not block one another', async () => {
    // Per-key locking, not whole-backend locking.  A burst of writes to
    // distinct keys must all succeed independently — none of them
    // contend for the same lock file.
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => backend.put(`key/${i}`, bytes(`v${i}`))),
    );
    expect(results).toHaveLength(N);
    const list = await backend.list({ prefix: 'key/' });
    expect(list).toHaveLength(N);
  });
});

/* ------------------------- security: path-traversal -------------------------- */

describe('FilesystemObjectStorageBackend — path-traversal hardening', () => {
  /**
   * **Exploit walkthrough (pre-fix).**  The backend joined the
   * configured root with the user-supplied `key` via `path.join`.
   * Node's `path.join` normalises `..` components, so a key of
   * `'../../etc/passwd'` resolved OUTSIDE the configured root.  An
   * attacker controlling the `key` (e.g., a malicious `persistenceId`
   * flowing into a snapshot-store layer with this backend) could:
   *
   *   - **Read arbitrary files** on the host via `get(key)`.
   *   - **Write/overwrite arbitrary files** via `put(key, body)`.
   *   - **Delete arbitrary files** via `delete(key)`.
   *
   * The cluster's normal threat model trusts the caller of these
   * methods (which is usually the framework itself), but defense-in-
   * depth on persistence-layer entry points is cheap.  Fix:
   * front-line syntactic rejection of `..` / absolute paths / NUL
   * bytes, plus a defense-in-depth post-resolve check that the
   * resolved path stays under the configured root.
   */
  test('exploit: relative `..` traversal in key is rejected (put)', async () => {
    await expect(backend.put('../escape.txt', bytes('evil')))
      .rejects.toThrow(/path-traversal/);
  });

  test('exploit: deeply-nested `..` traversal is rejected (put)', async () => {
    await expect(backend.put('a/b/../../../../escape.txt', bytes('evil')))
      .rejects.toThrow(/path-traversal/);
  });

  test('exploit: absolute POSIX path is rejected (put)', async () => {
    await expect(backend.put('/etc/passwd', bytes('evil')))
      .rejects.toThrow(/absolute paths/);
  });

  test('exploit: absolute Windows path is rejected (put)', async () => {
    await expect(backend.put('C:\\Windows\\System32\\evil.txt', bytes('evil')))
      .rejects.toThrow(/absolute paths/);
  });

  test('exploit: NUL byte in key is rejected (put)', async () => {
    // Rejected as a control character rather than by the NUL-only rule since
    // #747 tightened the write path — `rejectControlChars` subsumes NUL and
    // reports the sharper index/charCode.  The read paths below still take
    // the NUL branch, which is the whole point of the split.
    await expect(backend.put('safe\0../escape', bytes('evil')))
      .rejects.toThrow(/control character at index 4 \(charCode=0\)/);
  });

  test('exploit: NUL byte in key is still rejected on the read paths (get/delete)', async () => {
    // The looser read rule set has to keep rejecting the genuinely dangerous
    // shapes; only the control-character rule is write-path-only.
    await expect(backend.get('safe\0../escape')).rejects.toThrow(/NUL byte/);
    await expect(backend.delete('safe\0../escape')).rejects.toThrow(/NUL byte/);
  });

  test('exploit: traversal blocked on read paths too (get)', async () => {
    await expect(backend.get('../escape.txt')).rejects.toThrow(/path-traversal/);
  });

  test('exploit: traversal blocked on delete', async () => {
    await expect(backend.delete('../escape.txt')).rejects.toThrow(/path-traversal/);
  });

  test('exploit: traversal blocked on list prefix', async () => {
    await expect(backend.list({ prefix: '../etc' })).rejects.toThrow(/path-traversal/);
  });

  test('defense: file outside root is NOT touched even on traversal attempt', async () => {
    // Put a "victim" file outside the configured root, in the parent
    // directory of `tmpRoot`.  After a traversal-attempt put, the
    // victim file must be unchanged.
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, dirname } = await import('node:path');
    const sibling = mkdtempSync(join(dirname(tmpRoot), 'victim-'));
    const victimPath = join(sibling, 'sacred.txt');
    writeFileSync(victimPath, 'untouched');
    try {
      // Relative key that would resolve to the victim path.
      // The check rejects before the write happens.
      const relativeToVictim = `../${sibling.split(/[/\\]/).pop()}/sacred.txt`;
      await expect(backend.put(relativeToVictim, bytes('overwritten')))
        .rejects.toThrow(/path-traversal|absolute/);
      // Victim file is unchanged.
      expect(readFileSync(victimPath, 'utf8')).toBe('untouched');
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test('regression: legitimate nested keys with safe path segments still work', async () => {
    // Make sure the hardening didn't break normal usage.
    await backend.put('users/42/snapshot.json', bytes('safe'));
    const fetched = await backend.get('users/42/snapshot.json');
    expect(fetched.isSome()).toBe(true);
    if (fetched.isSome()) {
      expect(new TextDecoder().decode(fetched.value.body)).toBe('safe');
    }
  });

  test('regression: empty list prefix is unchanged (lists everything)', async () => {
    await backend.put('a', bytes('1'));
    await backend.put('b', bytes('2'));
    const items = await backend.list({ prefix: '' });
    expect(items.map(i => i.key).sort()).toEqual(['a', 'b']);
  });

  test('invalid keys: empty string, non-string, NUL byte all rejected', async () => {
    await expect(backend.put('', bytes('x'))).rejects.toThrow(/non-empty string/);
    await expect(backend.put('\0', bytes('x'))).rejects.toThrow(/control character/);
  });
});

/**
 * #747 — the write path rejects a control character; the read paths do not.
 *
 * The rule exists because the master-key rotation sweep refuses such a key on
 * the way back out of the bucket, so a key this backend writes must be a key
 * the sweep can process.  Applying it to `get`/`delete` as well would not stop
 * a new bad key — it would strand an object an older version already wrote,
 * leaving it unreadable *and* undeletable through the only backend that can
 * reach it.
 */
describe('FilesystemObjectStorageBackend — control characters on the write path (#747)', () => {
  /**
   * Composed rather than written as a literal: a raw 0x01 in a source file
   * makes git treat it as binary, and an escape sequence has to survive every
   * tool that rewrites the file.  Same reasoning `PersistenceIdValidator`
   * gives for scanning code points instead of matching a character class.
   */
  const keyWithControlChar = (charCode: number): string =>
    `pid${String.fromCharCode(charCode)}x/snap.json`;

  // 0x01 and 0x0A are legal in a POSIX filename, which is exactly why the
  // backend used to write them: nothing below it objected.  (NTFS rejects
  // 0x01–0x1F itself, so on Windows only the 0x7F case could ever have been
  // written — the rule closes the gap on every platform regardless.)
  for (const [label, charCode] of [['SOH (0x01)', 1], ['newline (0x0A)', 10], ['DEL (0x7F)', 127]] as const) {
    test(`put rejects a key containing ${label}`, async () => {
      await expect(backend.put(keyWithControlChar(charCode), bytes('body')))
        .rejects.toThrow(new RegExp(`control character at index 3 [(]charCode=${charCode}[)]`));
    });
  }

  test('nothing is written to disk when the key is refused', async () => {
    // The refusal has to come before `mkdir`, or a rejected put still leaves
    // a directory tree behind under an attacker-chosen name.
    await expect(backend.put(keyWithControlChar(1), bytes('body'))).rejects.toThrow();
    expect(await backend.list({ prefix: '' })).toEqual([]);
  });

  test('get and delete still accept a control-character key so existing objects stay reachable', async () => {
    // 0x7F is the one control character NTFS also permits, so it can stand in
    // for "written by a pre-#747 version" on every platform the suite runs on.
    // Written through `node:fs` because the backend itself now refuses.
    const strandedKey = keyWithControlChar(127);
    mkdirSync(join(tmpRoot, `pid${String.fromCharCode(127)}x`), { recursive: true });
    writeFileSync(join(tmpRoot, strandedKey), bytes('legacy'));

    const fetched = await backend.get(strandedKey);
    expect(fetched.isNone()).toBe(false);
    expect(new TextDecoder().decode(fetched.toNullable()!.body)).toBe('legacy');

    await backend.delete(strandedKey);
    expect((await backend.get(strandedKey)).isNone()).toBe(true);
  });

  test('a plain key is unaffected', async () => {
    await backend.put('pid-a/snap.json', bytes('body'));
    const items = await backend.list({ prefix: '' });
    expect(items.map((i) => i.key)).toEqual(['pid-a/snap.json']);
  });
});

/* --------------------- security: symlink containment (#748) ------------------- */

/**
 * Link `linkPath` to the directory `target`.
 *
 * Windows refuses a plain directory symlink without elevation or Developer
 * Mode but creates a **junction** freely, and a junction is dereferenced by
 * `realpath`, traversed by `mkdir(recursive)` and reported by a `readdir`
 * dirent as a link — measured on the maintainer's box, all three.  So the
 * directory half of this fix is exercised where the work happens and not only
 * on the Linux runner, which is the difference between a guard that is tested
 * and one that is skipped into permanent green.
 */
async function linkDirectory(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Capability probes for the two blocks below.  A stock Windows box refuses
 * `fs.symlink` to a file without elevation or Developer Mode, and that is the
 * ONLY reason a block may be skipped: any other failure re-throws, so a
 * genuinely broken filesystem cannot hide behind the guard and let the block
 * pass forever.  Ported from `tests/unit/http/static/StaticFiles.test.ts`,
 * where the same guard covers the same platform gap for #575.
 */
async function fileSymlinksAreCreatable(): Promise<boolean> {
  return await probeLink(async (probeDirectory) => {
    await writeFile(join(probeDirectory, 'target'), 'probe');
    await symlink(join(probeDirectory, 'target'), join(probeDirectory, 'link'));
  });
}

/** Directory-link half of the probe — a junction on Windows, a `'dir'` symlink elsewhere. */
async function directoryLinksAreCreatable(): Promise<boolean> {
  return await probeLink(async (probeDirectory) => {
    await mkdir(join(probeDirectory, 'target'));
    await linkDirectory(join(probeDirectory, 'target'), join(probeDirectory, 'link'));
  });
}

async function probeLink(attempt: (probeDirectory: string) => Promise<void>): Promise<boolean> {
  const probeDirectory = await mkdtemp(join(tmpdir(), 'actor-ts-objstore-link-probe-'));
  try {
    await attempt(probeDirectory);
    return true;
  } catch (error) {
    const code = (error as { readonly code?: string }).code;
    if (code === 'EPERM' || code === 'EACCES') return false;
    throw error;
  } finally {
    await rm(probeDirectory, { recursive: true, force: true });
  }
}

const describeIfDirectoryLinks = (await directoryLinksAreCreatable()) ? describe : describe.skip;
const describeIfFileSymlinks = (await fileSymlinksAreCreatable()) ? describe : describe.skip;

/**
 * The half of #748 the key validator cannot reach.
 *
 * `escape/sacred.txt` is a perfectly well-formed key — no `..`, no absolute
 * prefix, no NUL — so `assertSafeKey` passes it, and `path.join` /
 * `path.resolve` produce a string squarely inside the root.  Only the
 * filesystem knows that `escape` is a door.
 *
 * Which is also why the `/path-traversal/` assertions further up prove
 * nothing about the containment check they appear to cover: every one of them
 * is satisfied by the key validator, whose rejection message carries the same
 * phrase.  These are the ones that reach `assertWithinRoot`'s successor.
 */
describeIfDirectoryLinks('FilesystemObjectStorageBackend — a linked key segment (#748)', () => {
  let outside: string;
  const victimName = 'sacred.txt';

  beforeEach(async () => {
    outside = mkdtempSync(join(tmpdir(), 'actor-ts-objstore-outside-'));
    writeFileSync(join(outside, victimName), 'untouched');
    await linkDirectory(outside, join(tmpRoot, 'escape'));
  });

  afterEach(() => {
    // Remove the link before the outer `afterEach` walks `tmpRoot`, so the
    // recursive delete can never reach through it to the fixture.
    try { rmSync(join(tmpRoot, 'escape'), { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('put through the link is refused and the target file is untouched', async () => {
    await expect(backend.put(`escape/${victimName}`, bytes('overwritten')))
      .rejects.toThrow(/path-traversal/);
    expect(readFileSync(join(outside, victimName), 'utf8')).toBe('untouched');
  });

  test('the refusal happens before the lock file is taken', async () => {
    // Order matters: the containment check sits between `mkdir` and
    // `acquireLock`, so a refused key leaves no `<key>.lock` outside the root
    // either — which would otherwise be an arbitrary-file *create* even
    // though the body write never lands.
    await expect(backend.put(`escape/${victimName}`, bytes('overwritten'))).rejects.toThrow();
    expect(readdirSync(outside).sort()).toEqual([victimName]);
  });

  test('get through the link is refused', async () => {
    await expect(backend.get(`escape/${victimName}`)).rejects.toThrow(/path-traversal/);
  });

  test('delete through the link is refused and the target survives', async () => {
    await expect(backend.delete(`escape/${victimName}`)).rejects.toThrow(/path-traversal/);
    expect(readFileSync(join(outside, victimName), 'utf8')).toBe('untouched');
  });

  test('a prefixed list seeded at the link is refused', async () => {
    // #746 moved the walk's start from the root to the prefix's directory,
    // and `readdir` resolves the directory it is handed — so this is the one
    // hop of a listing a link can move.  Before that change it was
    // unreachable, which is why the guard arrives with the seed.
    await expect(backend.list({ prefix: 'escape/' })).rejects.toThrow(/path-traversal/);
  });

  test('a list-all does not descend into the link', async () => {
    // No check needed for this one, and the test says why it is safe rather
    // than assuming it: the walk classifies from a `withFileTypes` dirent,
    // which describes the link itself — neither a file nor a directory.
    await backend.put('inside', bytes('x'));
    const items = await backend.list({ prefix: '' });
    expect(items.map((i) => i.key)).toEqual(['inside']);
  });
});

describeIfDirectoryLinks('FilesystemObjectStorageBackend — a linked root still works (#748)', () => {
  test('every operation round-trips when `dir` is itself a link', async () => {
    // The regression a containment check causes if it compares against the
    // configured spelling of the root instead of the resolved one.
    // `/var/lib/app -> /mnt/data` is an ordinary deployment, and there every
    // single write resolves "outside" a lexically-compared root — so getting
    // this wrong breaks the backend completely rather than subtly.
    const data = join(tmpRoot, 'data');
    const alias = join(tmpRoot, 'alias');
    mkdirSync(data);
    await linkDirectory(data, alias);
    const aliasOptions = FilesystemObjectStorageOptions.create()
      .withDir(alias);
    const aliased = new FilesystemObjectStorageBackend(aliasOptions);

    await aliased.put('nested/key.json', bytes('first'), { contentType: 'application/json' });
    // The **second** put is the one that matters, and a version of this test
    // that stopped at the first would let a wrong fix through.  `put` now
    // canonicalises `<key>` as well as its parent, and that hop answers `null`
    // on a key that does not exist yet — so a check written against the
    // configured spelling of the root instead of the resolved one is invisible
    // on a first write and refuses every overwrite after it.
    //
    // Measured, by applying exactly that variant (`this.dir` in place of
    // `realRoot` on the key hop) and running the file: 51 pass / 1 fail, the
    // one failure being this line — `"…/alias/nested/key.json" resolves to
    // "…/data/nested/key.json", outside root "…/alias"`.  All four tests in
    // the linked-`<key>` block below stayed green through it, which is why
    // this assertion has to live here and not there.
    await aliased.put('nested/key.json', bytes('through the link'), { contentType: 'application/json' });
    const fetched = await aliased.get('nested/key.json');
    expect(fetched.isSome()).toBe(true);
    if (fetched.isSome()) {
      expect(new TextDecoder().decode(fetched.value.body)).toBe('through the link');
      expect(fetched.value.contentType).toBe('application/json');
    }
    expect((await aliased.list({ prefix: 'nested/' })).map((i) => i.key)).toEqual(['nested/key.json']);
    await aliased.delete('nested/key.json');
    expect((await aliased.get('nested/key.json')).isNone()).toBe(true);
  });
});

/**
 * The final-component cases.  These need a *file* link, which is the one thing
 * a stock Windows box cannot create — see the probe above.
 */
describeIfFileSymlinks('FilesystemObjectStorageBackend — a linked file (#748)', () => {
  let outside: string;
  let victimPath: string;
  const victimContent = '{"contentType":"leaked/secret"}';

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'actor-ts-objstore-outside-file-'));
    victimPath = join(outside, 'secret.json');
    writeFileSync(victimPath, victimContent);
  });

  afterEach(() => {
    try { rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('put does not follow a pre-planted `<key>.meta.json` link', async () => {
    // The sidecar's name is fully deterministic — `<key>.meta.json` — so
    // unlike the CSPRNG temp path it can be pre-planted.  `writeFile`'s
    // default `'w'` flag follows the link and truncates the target;
    // temp+rename replaces the link itself.
    await backend.put('obj', bytes('v1'));
    await symlink(victimPath, join(tmpRoot, 'obj.meta.json'));

    await backend.put('obj', bytes('v2'), { contentType: 'application/json' });

    expect(readFileSync(victimPath, 'utf8')).toBe(victimContent);
    expect(lstatSync(join(tmpRoot, 'obj.meta.json')).isSymbolicLink()).toBe(false);
    const fetched = await backend.get('obj');
    expect(fetched.isSome()).toBe(true);
    if (fetched.isSome()) expect(fetched.value.contentType).toBe('application/json');
  });

  test('get does not follow a `<key>` link out of the root', async () => {
    // `readFile` follows a link at the final component, so without the
    // canonical check this hands the caller the target's bytes under a key
    // the validator was perfectly happy with.  The issue body never mentions
    // the read path.
    await symlink(victimPath, join(tmpRoot, 'peek'));
    await expect(backend.get('peek')).rejects.toThrow(/path-traversal/);
  });

  test('get refuses an escaping `<key>.meta.json` link rather than reading it', async () => {
    // The sidecar is a hop of its own: the body can canonicalise inside the
    // root while its metadata is a link out of it.  Refused, not skipped — a
    // planted link inside the storage root is a compromise indicator, and
    // swallowing it would leave the only symptom in a `catch {}`.
    await backend.put('obj', bytes('v1'));
    await symlink(victimPath, join(tmpRoot, 'obj.meta.json'));
    await expect(backend.get('obj')).rejects.toThrow(/path-traversal/);
  });
});

/**
 * The parts of the #748 change that need no symlink at all, so they run
 * everywhere — including the two "must still work" properties the sidecar's
 * move to temp+rename could plausibly have broken.
 */
describe('FilesystemObjectStorageBackend — sidecar and root resolution (#748)', () => {
  // One test below seeds `fsLazy`; clearing it unconditionally keeps that
  // from leaking into whatever runs next, which is cheap because the next
  // `get()` just re-imports the real modules.
  afterEach(() => { fsLazy.reset(); });

  test('a re-put replaces the metadata sidecar rather than failing on it', async () => {
    // `{ flag: 'wx' }`, the exclusive create #748 suggested for the sidecar,
    // would have made this second put fail: `get` reads that exact
    // deterministic name back, so a re-put has to overwrite it.  That is why
    // the fix here is temp+rename and not `wx`.
    await backend.put('obj', bytes('v1'), { contentType: 'text/plain' });
    await backend.put('obj', bytes('v2'), { contentType: 'application/json', contentEncoding: 'gzip' });
    const fetched = await backend.get('obj');
    expect(fetched.isSome()).toBe(true);
    if (fetched.isSome()) {
      expect(fetched.value.contentType).toBe('application/json');
      expect(fetched.value.contentEncoding).toBe('gzip');
    }
  });

  test('list ignores the sidecar temp file a crashed writer leaves behind', async () => {
    // Same lockstep hazard as #909, one file later: the sidecar's temp name
    // is shaped `<key>.meta.json.tmp.<pid>.<random>` precisely so the
    // existing `TMP_FILE_RE` covers it — the `.meta.json` suffix rule alone
    // would not.
    await backend.put('real', bytes('value'));
    writeFileSync(join(tmpRoot, `real.meta.json.tmp.${process.pid}.${randomId(12)}`), '{}');
    const items = await backend.list({ prefix: '' });
    expect(items.map((i) => i.key)).toEqual(['real']);
  });

  test('get on a root that does not exist answers None', async () => {
    // Resolving the root is now the first thing `get` does, so an absent root
    // has to keep reading as "nothing stored" instead of becoming an error.
    const missingOptions = FilesystemObjectStorageOptions.create()
      .withDir(join(tmpRoot, 'never-created'));
    const missing = new FilesystemObjectStorageBackend(missingOptions);
    expect((await missing.get('anything')).isNone()).toBe(true);
  });

  test('a prefixed list on a root that does not exist answers empty', async () => {
    const missingOptions = FilesystemObjectStorageOptions.create()
      .withDir(join(tmpRoot, 'never-created'));
    const missing = new FilesystemObjectStorageBackend(missingOptions);
    expect(await missing.list({ prefix: 'a/b' })).toEqual([]);
  });

  test('put writes the metadata sidecar through a temp file and renames it into place', async () => {
    // The portable half of the pre-planted-link defence.  A file symlink
    // needs elevation on Windows, so the behavioural test above skips there
    // — but *which path was opened for writing* is observable everywhere, and
    // it is the whole of the fix: the sidecar's own deterministic name must
    // never reach `writeFile`, whose default `'w'` flag follows a link
    // planted at it, only `rename`, which replaces the entry itself.
    //
    // Seeded through `fsLazy`, the same `Lazy.setOverride` seam
    // `FilesystemObjectStorageBackend.listScoping.test.ts` uses.
    const real = await fsLazy.get();
    const written: string[] = [];
    const renamedTo: string[] = [];
    fsLazy.setOverride(Promise.resolve({
      path: real.path,
      fs: {
        ...real.fs,
        writeFile: (
          p: string,
          body: Uint8Array | string,
          writeOptions?: { flag?: string; encoding?: string },
        ): Promise<void> => {
          written.push(p);
          return real.fs.writeFile(p, body, writeOptions);
        },
        rename: (oldPath: string, newPath: string): Promise<void> => {
          renamedTo.push(newPath);
          return real.fs.rename(oldPath, newPath);
        },
      },
    }));

    await backend.put('obj', bytes('body'), { contentType: 'application/json' });

    const metaPath = join(tmpRoot, 'obj.meta.json');
    expect(written).not.toContain(metaPath);
    expect(written.some((p) => p.startsWith(`${metaPath}.tmp.`))).toBe(true);
    expect(renamedTo).toContain(metaPath);
  });

  test('get on a key whose parent is an ordinary file answers None', async () => {
    // `realpath` reports this one differently from a plain absence, and it
    // has to read as absent too — otherwise an ordinary key collision turns
    // into an error the caller never used to see.
    await backend.put('collision', bytes('x'));
    expect((await backend.get('collision/child')).isNone()).toBe(true);
  });
});

/* ------------ security: put's own read of `<key>` follows a link (#748) ------------ */

/**
 * The residual #748 left behind, and the reason it survived review: `put`
 * canonicalises the key's **parent** directory and stops there, while the CAS
 * step a few lines further down opens the key itself with `readFile` — which
 * follows a link at the final component exactly the way it does in `get`.
 *
 * So `<root>/obj` pointing at a file outside the root was read, hashed, and
 * its length and hash handed back to the caller in the mismatch message —
 * measured against the pre-fix tree with the fixture below:
 *
 *     etag mismatch on obj: expected "fs-00000000-0", actual "fs-cb91c885-45"
 *
 * `45` is the target's exact size and `cb91c885` an FNV-1a over its bytes —
 * an oracle for a file both docs pages promise is unreachable through this
 * backend.  `ifNoneMatch: '*'` leaks the coarser half of the same fact.
 *
 * Driven through the `fsLazy` seam rather than a real symlink on purpose.
 * The equivalent behavioural test needs a **file** link, which a stock Windows
 * box cannot create without elevation — so it would sit behind
 * `describeIfFileSymlinks` and skip on the machine this backend is developed
 * on, which is how the gap lasted this long.
 *
 * A seam that models the kernel cannot also *validate* that model, so the
 * assertions are chosen not to need it: what carries the weight is
 * `readsOf` — which path our own code handed to `readFile` — and that is true
 * of the real filesystem or any other.  The model only has to be right about
 * the one fact that makes the name interesting (`realpath` and `readFile`
 * dereference a final-component link, `rename` does not), and that fact is
 * POSIX-specified rather than inferred here.
 */
describe('FilesystemObjectStorageBackend — put and a linked `<key>` (#748)', () => {
  let outside: string;
  let secretPath: string;
  const secretBody = 'outside the root: not this backend\'s to read.';

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'actor-ts-objstore-put-link-'));
    secretPath = join(outside, 'secret.bin');
    writeFileSync(secretPath, secretBody);
  });

  afterEach(() => {
    fsLazy.reset();
    try { rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('put refuses a key that resolves outside the root instead of reading it', async () => {
    const observed = plantFinalComponentLink(await fsLazy.get(), join(tmpRoot, 'obj'), secretPath);

    const thrown = await backend
      .put('obj', bytes('overwritten'), { ifMatch: '"fs-00000000-0"' })
      .then(() => null, (e: unknown) => e as Error);

    expect(thrown).not.toBeNull();
    expect(thrown!.message).toMatch(/path-traversal/);
    // The mechanism, not only the symptom: the escaping name must never be
    // opened.  Asserting on the message alone would still pass an
    // implementation that read the file and then happened to refuse.
    expect(observed.readsOf('obj')).toEqual([]);
    // …and neither fact the old message carried may survive into the new one.
    // A CAS conflict is a different error class from a containment refusal,
    // so the class is part of the assertion too.
    expect(thrown!.message).not.toMatch(/etag mismatch/);
    expect(thrown).not.toBeInstanceOf(ObjectStorageConcurrencyError);
  });

  test('an existence probe through the link is refused the same way', async () => {
    // `ifNoneMatch: '*'` needs only "is anything there", so it leaks a coarser
    // fact than the etag — and it is the precondition
    // `resolveObjectStorageIdentity` uses on every store that opens over this
    // backend, which is what makes the path routine rather than exotic.
    plantFinalComponentLink(await fsLazy.get(), join(tmpRoot, 'obj'), secretPath);

    await expect(backend.put('obj', bytes('claim'), { ifNoneMatch: '*' }))
      .rejects.toThrow(/path-traversal/);
  });

  test('a refused key writes no body and no sidecar, and releases its lock', async () => {
    // A refused key must leave the store as it found it.  It does take the
    // per-key lock first — see the ordering test below for why that is
    // deliberate — so the assertion is not "nothing was written" but "nothing
    // except the lock, and the lock is gone again".
    const observed = plantFinalComponentLink(await fsLazy.get(), join(tmpRoot, 'obj'), secretPath);

    await expect(backend.put('obj', bytes('overwritten'))).rejects.toThrow(/path-traversal/);

    expect(observed.writes()).toEqual([join(tmpRoot, 'obj.lock')]);
    expect(existsSync(join(tmpRoot, 'obj.lock'))).toBe(false);
    expect(existsSync(join(tmpRoot, 'obj.meta.json'))).toBe(false);
    expect(readFileSync(secretPath, 'utf8')).toBe(secretBody);
  });

  test('the key is canonicalised under the lock, never before it', async () => {
    // Ordering, pinned as a call sequence rather than left to a comment,
    // because getting it wrong is invisible in every other assertion here and
    // shows up only as flakiness on Windows under concurrency.
    //
    // Canonicalising a path opens a handle to it, and
    // `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` refuses with EPERM while
    // another handle is open on the destination.  Hoisting this hop above
    // `acquireLock` makes every contending writer hold a handle on exactly
    // the name the lock winner is about to rename over, so the winner's own
    // `put` fails — `filesystem put-write failed … EPERM` — on a key with no
    // link anywhere near it.  Measured on the 10-way CAS race in the
    // concurrency block above, 60 attempts per variant: 0/60 before #748's
    // residual was closed, 8/60 with the hop before the lock, 0/60 with it
    // after.  Under the lock it is also the narrower check — the gap between
    // canonicalising and opening shrinks from a lock acquisition to two
    // statements.
    const observed = plantFinalComponentLink(await fsLazy.get(), join(tmpRoot, 'obj'), join(tmpRoot, 'inside'));
    writeFileSync(join(tmpRoot, 'inside'), 'v1');

    await backend.put('obj', bytes('v2'));

    const lockTaken = observed.indexOf('writeFile', join(tmpRoot, 'obj.lock'));
    const keyResolved = observed.indexOf('realpath', join(tmpRoot, 'obj'));
    expect(lockTaken).toBeGreaterThanOrEqual(0);
    expect(keyResolved).toBeGreaterThan(lockTaken);
    // The parent hop keeps the opposite order, and for a reason that has not
    // changed: it is what makes `<key>.lock` provably land inside the root,
    // so it has to run before the file that proves it.
    expect(observed.indexOf('realpath', tmpRoot)).toBeLessThan(lockTaken);
  });

  test('a key that resolves back inside the root is still read and written', async () => {
    // The guard must refuse where the link leaves the root and nowhere else.
    // An implementation that rejected every resolvable `<key>` — or that
    // skipped the CAS read to avoid the question — passes every test above
    // and breaks every overwrite in the suite.  Same hop through the seam,
    // pointed back inside.
    const inside = join(tmpRoot, 'real-target');
    writeFileSync(inside, 'v1');
    const observed = plantFinalComponentLink(await fsLazy.get(), join(tmpRoot, 'obj'), inside);

    await backend.put('obj', bytes('v2'));

    expect(observed.readsOf('obj')).toEqual([join(tmpRoot, 'obj')]);
    expect(readFileSync(join(tmpRoot, 'obj'), 'utf8')).toBe('v2');
  });
});

/** What {@link plantFinalComponentLink} hands back — an ordered call log, queried. */
type ObservedCalls = {
  /** Every path passed to `readFile` that is the planted link. */
  readsOf(name: string): string[];
  /** Every path passed to `writeFile`, in order. */
  writes(): string[];
  /** Index of the first `op` call on `path` in the ordered log, or `-1`. */
  indexOf(op: string, path: string): number;
};

/**
 * Model a symlink at `linkPath` pointing at `targetPath`, for the two calls
 * whose treatment of a final-component link is the whole question: `realpath`
 * and `readFile` dereference it, `rename` does not.  Everything else delegates
 * to the real module.
 *
 * Every `readFile`, `writeFile` and `realpath` is logged **in order**, because
 * two of the properties worth asserting here are about sequence — that the
 * escaping name is never opened, and that it is canonicalised only once the
 * per-key lock is held.
 */
function plantFinalComponentLink(real: FsModule, linkPath: string, targetPath: string): ObservedCalls {
  const log: { op: string; path: string }[] = [];
  const follow = (p: string): string => (p === linkPath ? targetPath : p);
  const readFile = ((p: string, encoding?: 'utf8') => {
    log.push({ op: 'readFile', path: p });
    return encoding === undefined
      ? real.fs.readFile(follow(p))
      : real.fs.readFile(follow(p), encoding);
  }) as FsModule['fs']['readFile'];
  fsLazy.setOverride(Promise.resolve({
    path: real.path,
    fs: {
      ...real.fs,
      readFile,
      realpath: (p: string): Promise<string> => {
        log.push({ op: 'realpath', path: p });
        return real.fs.realpath(follow(p));
      },
      writeFile: (
        p: string,
        body: Uint8Array | string,
        writeOptions?: { flag?: string; encoding?: string },
      ): Promise<void> => {
        log.push({ op: 'writeFile', path: p });
        return real.fs.writeFile(p, body, writeOptions);
      },
    },
  }));
  return {
    readsOf: (name: string): string[] =>
      log.filter((c) => c.op === 'readFile' && c.path === join(tmpRoot, name)).map((c) => c.path),
    // The body's temp file carries a CSPRNG suffix, so it is normalised to the
    // stem it will be renamed onto — otherwise the expectation could not be
    // written down at all.
    writes: (): string[] =>
      log.filter((c) => c.op === 'writeFile').map((c) => c.path.replace(/\.tmp\.\d+\.[0-9a-f]+$/, '')),
    indexOf: (op: string, path: string): number => log.findIndex((c) => c.op === op && c.path === path),
  };
}

/* -------------- security: the stale-lock reclaim (#1360) ----------------- */

/**
 * `acquireLock` takes `<key>.lock` with `{ flag: 'wx' }`, and that half is safe
 * by construction — POSIX specifies `O_CREAT|O_EXCL` fails with `EEXIST` on a
 * symbolic link whatever it points at.  The **reclaim** is the half that has to
 * make a decision about a name someone else may have planted, and it made two
 * wrong ones: it asked `stat` how old the entry was (which answers about the
 * link's *target*, so whoever planted the link picks the answer), and it then
 * removed whatever was there.
 *
 * Driven through the `fsLazy` seam for the same reason as the `#748` block
 * above: the behavioural version needs a **file** symlink, which a stock
 * Windows box refuses without elevation, so it would skip on the machine this
 * backend is developed on.
 *
 * One claim in the issue does **not** survive contact with the code, and the
 * fixture is shaped so this is visible rather than assumed: `unlink` does not
 * follow a final-component link, so the pre-fix reclaim removed the *link* and
 * never touched its target — the same POSIX rule `delete` already relies on.
 * The reachable damage was the staleness oracle and the spin below.
 */
describe('FilesystemObjectStorageBackend — the lock reclaim and a planted entry (#1360)', () => {
  /** A backend whose lock times out fast enough to reach the reclaim in a test. */
  const impatient = (): FilesystemObjectStorageBackend => new FilesystemObjectStorageBackend(
    FilesystemObjectStorageOptions.create()
      .withDir(tmpRoot)
      .withLockTimeoutMs(30)
      .withStaleLockMs(1_000),
  );

  afterEach(() => { fsLazy.reset(); });

  test('a symbolic link at `<key>.lock` is refused, not reclaimed', async () => {
    // The link is fresh (planted just now) but points at something ancient —
    // exactly the shape that makes `stat` and `lstat` disagree.
    const observed = plantLockEntry(await fsLazy.get(), join(tmpRoot, 'obj.lock'), {
      kind: 'symlink',
      targetMtime: new Date(Date.now() - 60 * 60_000),
    });

    await expect(impatient().put('obj', bytes('v1'))).rejects.toThrow(/refusing to reclaim/);

    // The discriminator, and the reason the message alone is not enough: the
    // pre-fix reclaim read the *target's* hour-old mtime through `stat`, called
    // it stale, and unlinked the name.  A guard that refuses after removing it
    // has not fixed anything.
    expect(observed.unlinked()).not.toContain(join(tmpRoot, 'obj.lock'));
    expect(observed.statted()).toEqual([]);
  });

  test('a genuinely stale regular lock file is still reclaimed', async () => {
    // The other direction, and the one that fails an implementation which
    // simply refuses every reclaim: a real lock file left by a crashed holder
    // is this branch's entire reason to exist.
    const observed = plantLockEntry(await fsLazy.get(), join(tmpRoot, 'obj.lock'), {
      kind: 'stale-file',
      mtime: new Date(Date.now() - 60 * 60_000),
    });

    await impatient().put('obj', bytes('v1'));

    expect(observed.unlinked()).toContain(join(tmpRoot, 'obj.lock'));
    const stored = await backend.get('obj');
    expect(stored.isSome()).toBe(true);
  });

  test('an entry that answers EEXIST and ENOENT forever terminates instead of spinning', async () => {
    // Both `continue`s in the reclaim skip the backoff, and the branch is only
    // reachable once the timeout is already exhausted — so an entry that keeps
    // giving the same pair of answers was an unbounded loop with no exit.  A
    // dangling link was one such entry before the reclaim used `lstat`: `wx`
    // refuses a symbolic link whatever it points at, and `stat` followed it to
    // nothing, so the two disagreed forever.
    //
    // The attempt cap in the fixture is what makes this a *test* rather than a
    // hang, and it is not defensive padding — measured against the unfixed
    // tree, the run wedged and bun's per-test timeout never fired.  It cannot:
    // the loop's only await is on a promise the fixture rejects synchronously,
    // so it never yields to the macrotask queue the runner's timer lives on.
    // With the cap, a regression fails in milliseconds and names itself.
    const observed = plantLockEntry(await fsLazy.get(), join(tmpRoot, 'obj.lock'), { kind: 'phantom' });

    await expect(impatient().put('obj', bytes('v1'))).rejects.toThrow(/timed out acquiring lock/);
    expect(observed.spun()).toBe(false);
  });
});

/** What {@link plantLockEntry} models at the lock path. */
type PlantedLockEntry =
  | { kind: 'symlink'; targetMtime: Date }
  | { kind: 'stale-file'; mtime: Date }
  | { kind: 'phantom' };

/**
 * Occupy `lockPath` with `entry` for the four calls the reclaim makes about it.
 *
 * The model only has to be right about the facts that make the name
 * interesting, and each is POSIX-specified rather than inferred here: an
 * `O_CREAT|O_EXCL` create fails with `EEXIST`, `stat` reports the link's target
 * while `lstat` reports the link, and `unlink` removes the link itself.  Once
 * the entry is unlinked the name is free and every call delegates to the real
 * module, so a reclaim that legitimately succeeds goes on to write for real.
 */
function plantLockEntry(
  real: FsModule,
  lockPath: string,
  entry: PlantedLockEntry,
): { unlinked(): string[]; statted(): string[]; spun(): boolean } {
  let present = true;
  let attempts = 0;
  let spun = false;
  const unlinked: string[] = [];
  const statted: string[] = [];
  const notFound = (): NodeJS.ErrnoException =>
    Object.assign(new Error(`ENOENT: no such file or directory, '${lockPath}'`), { code: 'ENOENT' });
  fsLazy.setOverride(Promise.resolve({
    path: real.path,
    fs: {
      ...real.fs,
      writeFile: (
        p: string,
        body: Uint8Array | string,
        writeOptions?: { flag?: string; encoding?: string },
      ): Promise<void> => {
        if (p === lockPath && present && writeOptions?.flag === 'wx') {
          // Generous next to what a bounded reclaim needs (the acquire, plus
          // one retry per reclaim round), and far below what an unbounded one
          // reaches.  Past it the fixture stops playing along and reports the
          // spin as a value the test can assert on, instead of letting the
          // runner wedge.
          if (++attempts > 8) {
            spun = true;
            return Promise.reject(Object.assign(
              new Error(`fixture: acquireLock retried ${attempts} times without terminating`),
              { code: 'EIO' },
            ));
          }
          return Promise.reject(Object.assign(new Error(`EEXIST: file already exists, '${p}'`), { code: 'EEXIST' }));
        }
        return real.fs.writeFile(p, body, writeOptions);
      },
      stat: (p: string): Promise<{ size: number; mtime: Date }> => {
        // Recorded, never answered for the lock path: the fixed reclaim must
        // not ask this question at all, and `statted()` is what pins that.
        if (p === lockPath && present) {
          statted.push(p);
          return entry.kind === 'symlink'
            ? Promise.resolve({ size: 0, mtime: entry.targetMtime })
            : Promise.reject(notFound());
        }
        return real.fs.stat(p);
      },
      lstat: (p: string): Promise<{ mtime: Date; isFile(): boolean; isSymbolicLink(): boolean }> => {
        if (p === lockPath && present) {
          if (entry.kind === 'phantom') return Promise.reject(notFound());
          const isLink = entry.kind === 'symlink';
          return Promise.resolve({
            mtime: isLink ? new Date() : entry.mtime,
            isFile: () => !isLink,
            isSymbolicLink: () => isLink,
          });
        }
        return real.fs.lstat(p);
      },
      unlink: (p: string): Promise<void> => {
        unlinked.push(p);
        if (p === lockPath && present) { present = false; return Promise.resolve(); }
        return real.fs.unlink(p);
      },
    },
  }));
  return { unlinked: () => unlinked, statted: () => statted, spun: () => spun };
}
