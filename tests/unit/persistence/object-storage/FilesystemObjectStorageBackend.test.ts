import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
});
