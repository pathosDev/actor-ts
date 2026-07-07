/**
 * Integration tests for `S3ObjectStorageBackend` against a live MinIO
 * instance.  Skipped automatically when the env vars are missing — CI
 * stays green even without MinIO running.
 *
 * To run locally:
 *   docker run --rm -p 9000:9000 minio/minio server /data
 *   S3_ENDPOINT=http://localhost:9000 \
 *   S3_ACCESS_KEY=minioadmin \
 *   S3_SECRET_KEY=minioadmin \
 *   S3_BUCKET=actor-ts-test \
 *     bun test tests/unit/persistence/object-storage/S3ObjectStorageBackend.test.ts
 *
 * (Create the bucket once via `mc mb` or the MinIO console.)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { S3ObjectStorageBackend } from '../../../../../src/persistence/object-storage/S3ObjectStorageBackend.js';
import { S3ObjectStorageOptions } from '../../../../../src/persistence/object-storage/S3ObjectStorageOptions.js';
import { ObjectStorageConcurrencyError } from '../../../../../src/persistence/object-storage/ObjectStorageBackend.js';

const endpoint = process.env.S3_ENDPOINT;
const accessKeyId = process.env.S3_ACCESS_KEY;
const secretAccessKey = process.env.S3_SECRET_KEY;
const bucket = process.env.S3_BUCKET;
const minioAvailable = !!(endpoint && accessKeyId && secretAccessKey && bucket);

const describeMaybe = minioAvailable ? describe : describe.skip;

describeMaybe('S3ObjectStorageBackend (integration — MinIO)', () => {
  let backend: S3ObjectStorageBackend;
  // Each run scopes its keys under a unique prefix so re-running the test
  // suite never collides with itself, even if cleanup half-fails.
  const runPrefix = `actor-ts-test/${Date.now()}-${Math.random().toString(36).slice(2)}/`;

  beforeAll(() => {
    const backendOptions = S3ObjectStorageOptions.create()
      .withBucket(bucket!)
      .withRegion('us-east-1')
      .withEndpoint(endpoint!)
      .withForcePathStyle(true)
      .withCredentials({ accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! });
    backend = new S3ObjectStorageBackend(backendOptions);
  });

  afterAll(async () => {
    // Best-effort cleanup of everything under the run prefix.
    const items = await backend.list({ prefix: runPrefix });
    for (const it of items) await backend.delete(it.key);
    await backend.close();
  });

  test('put then get round-trips bytes', async () => {
    const key = `${runPrefix}round-trip.bin`;
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const { etag } = await backend.put(key, body, { contentType: 'application/octet-stream' });
    expect(etag).toMatch(/^"[^"]+"$/);
    const got = await backend.get(key);
    expect(got.isSome()).toBe(true);
    expect(Array.from(got.toNullable()!.body)).toEqual([1, 2, 3, 4, 5]);
    expect(got.toNullable()!.contentType).toBe('application/octet-stream');
  });

  test('get returns None for absent keys', async () => {
    const result = await backend.get(`${runPrefix}does-not-exist.bin`);
    expect(result.isNone()).toBe(true);
  });

  test('list returns objects sorted by key', async () => {
    const a = `${runPrefix}list/aa.bin`;
    const b = `${runPrefix}list/bb.bin`;
    await backend.put(a, new Uint8Array([1]));
    await backend.put(b, new Uint8Array([2]));
    const items = await backend.list({ prefix: `${runPrefix}list/` });
    expect(items.map(i => i.key)).toEqual([a, b]);
  });

  test('ifNoneMatch=* rejects when the key already exists', async () => {
    const key = `${runPrefix}cas/exists.bin`;
    await backend.put(key, new Uint8Array([0]));
    let caught: unknown;
    try { await backend.put(key, new Uint8Array([1]), { ifNoneMatch: '*' }); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ObjectStorageConcurrencyError);
  });

  test('ifMatch rejects when the etag has moved', async () => {
    const key = `${runPrefix}cas/moved.bin`;
    const { etag: stale } = await backend.put(key, new Uint8Array([0]));
    await backend.put(key, new Uint8Array([1])); // someone else writes
    let caught: unknown;
    try { await backend.put(key, new Uint8Array([2]), { ifMatch: stale }); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ObjectStorageConcurrencyError);
  });

  test('delete removes the key (idempotent)', async () => {
    const key = `${runPrefix}delete-me.bin`;
    await backend.put(key, new Uint8Array([0]));
    await backend.delete(key);
    expect((await backend.get(key)).isNone()).toBe(true);
    // Second delete is a no-op.
    await backend.delete(key);
  });
});

if (!minioAvailable) {
  describe.skip('S3ObjectStorageBackend (integration — MinIO)', () => {
    test('skipped: set S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET to enable', () => {});
  });
}
