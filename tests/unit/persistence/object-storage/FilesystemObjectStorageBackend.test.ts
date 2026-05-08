import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemObjectStorageBackend } from '../../../../src/persistence/object-storage/FilesystemObjectStorageBackend.js';
import { ObjectStorageConcurrencyError } from '../../../../src/persistence/object-storage/ObjectStorageBackend.js';

let tmpRoot: string;
let backend: FilesystemObjectStorageBackend;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'actor-ts-objstore-'));
  backend = new FilesystemObjectStorageBackend({ dir: tmpRoot });
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
    for (let i = 0; i < 5; i++) await backend.put(`p/${i}`, bytes(String(i)));
    const items = await backend.list({ prefix: 'p/', limit: 2 });
    expect(items).toHaveLength(2);
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
    writeFileSync(join(tmpRoot, 'real.lock'), '12345 2024-01-01\n');
    writeFileSync(join(tmpRoot, 'real.tmp.99.1700000000.42'), 'partial');
    writeFileSync(join(tmpRoot, 'real.meta.json'), '{}');
    const items = await backend.list({ prefix: '' });
    expect(items.map(i => i.key)).toEqual(['real']);
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

    const fresh = new FilesystemObjectStorageBackend({ dir: tmpRoot });
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
