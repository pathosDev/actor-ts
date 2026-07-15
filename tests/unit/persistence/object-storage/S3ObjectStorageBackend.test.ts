/**
 * Pure-unit tests for `S3ObjectStorageBackend` — exercises the SDK-
 * lazy-load contract, endpoint / region / forcePathStyle / credentials
 * pass-through, the SSE / KMS option translation, and the error-
 * translation paths (412 → ObjectStorageConcurrencyError, 404 →
 * `none`).  No network, no MinIO, no AWS SDK installed.  The SDK module
 * is replaced via `mock.module` with a fake that records command inputs
 * so we can introspect what the backend would have sent to S3.
 *
 * The existing live-integration test under
 * `tests/integration/in-process/persistence/object-storage/
 * S3ObjectStorageBackend.test.ts` is skipped without env vars — this
 * file gives the same code path real coverage in CI.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Capture-based fake — every PutObjectCommand / GetObjectCommand /
 * DeleteObjectCommand / ListObjectsV2Command stores its input on
 * `this.input` (mirroring the real SDK).  The fake S3Client's `send`
 * function is mutable per-test so each scenario decides what to
 * return / throw.
 *
 * The test file is the FIRST place that imports
 * `@aws-sdk/client-s3` so this stub is what
 * `S3ObjectStorageBackend`'s lazy import resolves to.
 */
class FakeS3Client {
  constructor(public readonly config: unknown) {
    fakeClientsConstructed.push(this);
  }
  send: (cmd: { input: unknown }) => Promise<unknown> = async () => ({});
  destroy(): void { this.destroyed = true; }
  destroyed = false;
}
class FakeCommand { constructor(public readonly input: unknown) {} }

const fakeClientsConstructed: FakeS3Client[] = [];

mock.module('@aws-sdk/client-s3', () => ({
  S3Client: FakeS3Client,
  PutObjectCommand: FakeCommand,
  GetObjectCommand: FakeCommand,
  DeleteObjectCommand: FakeCommand,
  ListObjectsV2Command: FakeCommand,
}));

// Import AFTER the mock — the dynamic `import('@aws-sdk/client-s3')`
// inside the backend's s3SdkLazy resolves to the fake.
import {
  S3ObjectStorageBackend,
  type S3ClientLike,
} from '../../../../src/persistence/object-storage/S3ObjectStorageBackend.js';
import { S3ObjectStorageOptions, S3ObjectStorageOptionsBuilder } from '../../../../src/persistence/object-storage/S3ObjectStorageOptions.js';
import {
  ObjectStorageBackendError,
  ObjectStorageConcurrencyError,
} from '../../../../src/persistence/object-storage/ObjectStorageBackend.js';

/** Terse builder helpers so these many constructions stay readable. */
const s3Opts = (): S3ObjectStorageOptionsBuilder =>
  S3ObjectStorageOptions.create().withBucket('b').withRegion('us-east-1');
const s3OptsWithClient = (client: S3ClientLike): S3ObjectStorageOptionsBuilder =>
  s3Opts().withClient(client);

beforeEach(() => { fakeClientsConstructed.length = 0; });
afterEach(() => { fakeClientsConstructed.length = 0; });

describe('S3ObjectStorageBackend — SDK lazy-load', () => {
  test('constructor does NOT instantiate the SDK or S3Client', () => {
    new S3ObjectStorageBackend(s3Opts());
    // No client constructed until the first operation.
    expect(fakeClientsConstructed.length).toBe(0);
  });

  test('first operation triggers S3Client construction', async () => {
    const s3Options = S3ObjectStorageOptions.create()
      .withBucket('b')
      .withRegion('eu-central-1');
    const backend = new S3ObjectStorageBackend(s3Options);
    // Fake send returns {} by default which makes put fail the
    // "no ETag" assertion — we don't care here, only that the
    // S3Client was constructed.
    await backend.put('k', new Uint8Array([0])).catch(() => { /* expected */ });
    expect(fakeClientsConstructed.length).toBe(1);
  });

  test('user-injected client short-circuits S3Client construction entirely', async () => {
    let sendCalls = 0;
    const injected = {
      send: async () => { sendCalls++; return { ETag: '"x"' }; },
    };
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(injected));
    await backend.put('k', new Uint8Array([0]));
    expect(sendCalls).toBe(1);
    // No FakeS3Client was constructed — the injected one was used.
    expect(fakeClientsConstructed.length).toBe(0);
  });
});

describe('S3ObjectStorageBackend — endpoint + region + credentials pass-through', () => {
  test('forwards endpoint, forcePathStyle, region, credentials to the S3Client', async () => {
    const creds = { accessKeyId: 'AKIA...', secretAccessKey: 'shhh', sessionToken: 'tok' };
    const s3Options = S3ObjectStorageOptions.create()
      .withBucket('b')
      .withRegion('auto');
    const backend = new S3ObjectStorageBackend(
      s3Options // R2 sentinel
        .withEndpoint('https://acct.r2.cloudflarestorage.com')
        .withForcePathStyle(true)
        .withCredentials(creds),
    );
    await backend.list({ prefix: '' });
    expect(fakeClientsConstructed.length).toBe(1);
    const cfg = fakeClientsConstructed[0]!.config as Record<string, unknown>;
    expect(cfg.region).toBe('auto');
    expect(cfg.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
    expect(cfg.forcePathStyle).toBe(true);
    expect(cfg.credentials).toEqual(creds);
  });

  test('omitting endpoint / credentials passes undefined (SDK default chain)', async () => {
    const s3Options = S3ObjectStorageOptions.create()
      .withBucket('b')
      .withRegion('us-west-2');
    const backend = new S3ObjectStorageBackend(s3Options);
    await backend.list({ prefix: '' });
    const cfg = fakeClientsConstructed[0]!.config as Record<string, unknown>;
    expect(cfg.region).toBe('us-west-2');
    expect(cfg.endpoint).toBeUndefined();
    expect(cfg.forcePathStyle).toBeUndefined();
    expect(cfg.credentials).toBeUndefined();
  });
});

describe('S3ObjectStorageBackend — put: SSE / KMS option translation', () => {
  test('sse: "AES256" sets ServerSideEncryption=AES256, no KMS key', async () => {
    let captured: unknown;
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async (cmd: { input: unknown }) => { captured = cmd.input; return { ETag: '"e"' }; } },
    ));
    await backend.put('k', new Uint8Array([0]), { sse: 'AES256' });
    const input = captured as Record<string, unknown>;
    expect(input.ServerSideEncryption).toBe('AES256');
    expect(input.SSEKMSKeyId).toBeUndefined();
  });

  test('sse: { kmsKeyId } sets ServerSideEncryption=aws:kms + SSEKMSKeyId', async () => {
    let captured: unknown;
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async (cmd: { input: unknown }) => { captured = cmd.input; return { ETag: '"e"' }; } },
    ));
    await backend.put('k', new Uint8Array([0]), { sse: { kmsKeyId: 'arn:aws:kms:us-east-1:111:key/abc' } });
    const input = captured as Record<string, unknown>;
    expect(input.ServerSideEncryption).toBe('aws:kms');
    expect(input.SSEKMSKeyId).toBe('arn:aws:kms:us-east-1:111:key/abc');
  });

  test('no sse option leaves ServerSideEncryption / SSEKMSKeyId undefined', async () => {
    let captured: unknown;
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async (cmd: { input: unknown }) => { captured = cmd.input; return { ETag: '"e"' }; } },
    ));
    await backend.put('k', new Uint8Array([0]));
    const input = captured as Record<string, unknown>;
    expect(input.ServerSideEncryption).toBeUndefined();
    expect(input.SSEKMSKeyId).toBeUndefined();
  });

  test('forwards contentType + contentEncoding + ifMatch + ifNoneMatch', async () => {
    let captured: unknown;
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async (cmd: { input: unknown }) => { captured = cmd.input; return { ETag: '"e"' }; } },
    ));
    await backend.put('k', new Uint8Array([0]), {
      contentType: 'application/json',
      contentEncoding: 'gzip',
      ifMatch: '"old-etag"',
    });
    const input = captured as Record<string, unknown>;
    expect(input.ContentType).toBe('application/json');
    expect(input.ContentEncoding).toBe('gzip');
    expect(input.IfMatch).toBe('"old-etag"');

    // Separate call with ifNoneMatch.
    await backend.put('k2', new Uint8Array([0]), { ifNoneMatch: '*' });
    const input2 = captured as Record<string, unknown>;
    expect(input2.IfNoneMatch).toBe('*');
  });
});

describe('S3ObjectStorageBackend — error translation', () => {
  test('412 PreconditionFailed → ObjectStorageConcurrencyError', async () => {
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => {
        const error = new Error('Precondition Failed') as Error & {
          name: string; $metadata: { httpStatusCode: number };
        };
        error.name = 'PreconditionFailed';
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      } },
    ));
    let caught: unknown;
    try { await backend.put('k', new Uint8Array([0]), { ifMatch: '"x"' }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ObjectStorageConcurrencyError);
    expect((caught as ObjectStorageConcurrencyError).key).toBe('k');
  });

  test('plain 412 via $metadata also translates (name not set)', async () => {
    // Some S3-compatible stores (MinIO, R2) return 412 but with a
    // generic name — the http status alone must trigger CAS handling.
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => {
        const error = new Error('precondition') as Error & {
          $metadata: { httpStatusCode: number };
        };
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      } },
    ));
    await expect(backend.put('k', new Uint8Array([0]), { ifMatch: '"x"' }))
      .rejects.toBeInstanceOf(ObjectStorageConcurrencyError);
  });

  test('non-CAS PUT error → ObjectStorageBackendError', async () => {
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => { throw new Error('connection reset'); } },
    ));
    await expect(backend.put('k', new Uint8Array([0])))
      .rejects.toBeInstanceOf(ObjectStorageBackendError);
  });

  test('get NoSuchKey (by name) → none', async () => {
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => {
        const error = new Error('absent') as Error & { name: string };
        error.name = 'NoSuchKey';
        throw error;
      } },
    ));
    const out = await backend.get('absent-key');
    expect(out.isNone()).toBe(true);
  });

  test('get NoSuchKey (by Code field) → none', async () => {
    // AWS SDK v3 sometimes surfaces error.Code instead of error.name —
    // the legacy SDK path.  Pin that we accept both.
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => {
        const error = new Error('absent') as Error & { Code: string };
        error.Code = 'NoSuchKey';
        throw error;
      } },
    ));
    const out = await backend.get('absent-key');
    expect(out.isNone()).toBe(true);
  });

  test('get 404 via $metadata.httpStatusCode → none', async () => {
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => {
        const error = new Error('not found') as Error & {
          $metadata: { httpStatusCode: number };
        };
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      } },
    ));
    const out = await backend.get('absent-key');
    expect(out.isNone()).toBe(true);
  });

  test('non-404 GET error → ObjectStorageBackendError', async () => {
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => { throw new Error('AccessDenied'); } },
    ));
    await expect(backend.get('k')).rejects.toBeInstanceOf(ObjectStorageBackendError);
  });

  test('DELETE error → ObjectStorageBackendError (not swallowed)', async () => {
    // S3 DELETE is normally idempotent — we only get here on a real
    // failure (auth, network), and the error must propagate so the
    // caller can retry.
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => { throw new Error('AccessDenied'); } },
    ));
    await expect(backend.delete('k')).rejects.toBeInstanceOf(ObjectStorageBackendError);
  });

  test('LIST error → ObjectStorageBackendError with the prefix in the message', async () => {
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => { throw new Error('boom'); } },
    ));
    let caught: Error | undefined;
    try { await backend.list({ prefix: 'snapshots/' }); }
    catch (error) { caught = error as Error; }
    expect(caught).toBeInstanceOf(ObjectStorageBackendError);
    expect(caught!.message).toContain('snapshots/');
  });

  test('put with no ETag in response throws ObjectStorageBackendError', async () => {
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => ({ /* no ETag */ }) },
    ));
    await expect(backend.put('k', new Uint8Array([0])))
      .rejects.toBeInstanceOf(ObjectStorageBackendError);
  });
});

describe('S3ObjectStorageBackend — get: body stream decoding', () => {
  test('transformToByteArray-style Body is decoded', async () => {
    const payload = new Uint8Array([10, 20, 30]);
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => ({
        Body: { transformToByteArray: async () => payload },
        ETag: '"e"',
        ContentType: 'text/plain',
      }) },
    ));
    const got = await backend.get('k');
    expect(got.isSome()).toBe(true);
    const result = got.toNullable()!;
    expect(Array.from(result.body)).toEqual([10, 20, 30]);
    expect(result.contentType).toBe('text/plain');
    // ETag is re-quoted (the source strips then re-adds quotes).
    expect(result.etag).toBe('"e"');
  });

  test('async-iterable Body is decoded (older shim path)', async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4, 5]);
    }
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => ({
        Body: chunks(), // no transformToByteArray
        ETag: '"e"',
      }) },
    ));
    const got = await backend.get('k');
    expect(Array.from(got.toNullable()!.body)).toEqual([1, 2, 3, 4, 5]);
  });

  test('get with no ETag throws ObjectStorageBackendError', async () => {
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => ({
        Body: { transformToByteArray: async () => new Uint8Array([0]) },
        /* no ETag */
      }) },
    ));
    await expect(backend.get('k')).rejects.toBeInstanceOf(ObjectStorageBackendError);
  });

  test('get with empty Body throws ObjectStorageBackendError', async () => {
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => ({ /* no Body */ ETag: '"e"' }) },
    ));
    await expect(backend.get('k')).rejects.toBeInstanceOf(ObjectStorageBackendError);
  });
});

describe('S3ObjectStorageBackend — list pagination', () => {
  test('follows ContinuationToken across multiple pages', async () => {
    const pages = [
      {
        Contents: [{ Key: 'a/1', Size: 10, LastModified: new Date(0) }],
        IsTruncated: true, NextContinuationToken: 'cursor-1',
      },
      {
        Contents: [{ Key: 'a/2', Size: 20, LastModified: new Date(0) }],
        IsTruncated: true, NextContinuationToken: 'cursor-2',
      },
      {
        Contents: [{ Key: 'a/3', Size: 30, LastModified: new Date(0) }],
        IsTruncated: false,
      },
    ];
    let call = 0;
    const seenTokens: Array<string | undefined> = [];
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async (cmd: { input: unknown }) => {
        seenTokens.push((cmd.input as { ContinuationToken?: string }).ContinuationToken);
        return pages[call++];
      } },
    ));
    const items = await backend.list({ prefix: 'a/' });
    expect(items.map(i => i.key)).toEqual(['a/1', 'a/2', 'a/3']);
    expect(seenTokens).toEqual([undefined, 'cursor-1', 'cursor-2']);
  });

  test('respects soft `limit` — slices the merged result', async () => {
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => ({
        Contents: [
          { Key: 'a', Size: 1, LastModified: new Date(0) },
          { Key: 'b', Size: 1, LastModified: new Date(0) },
          { Key: 'c', Size: 1, LastModified: new Date(0) },
          { Key: 'd', Size: 1, LastModified: new Date(0) },
        ],
        IsTruncated: false,
      }) },
    ));
    const items = await backend.list({ prefix: '', limit: 2 });
    expect(items.map(i => i.key)).toEqual(['a', 'b']);
  });

  test('caps MaxKeys at 1000 per page', async () => {
    let captured: Record<string, unknown> | undefined;
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async (cmd: { input: unknown }) => {
        captured = cmd.input as Record<string, unknown>;
        return { Contents: [], IsTruncated: false };
      } },
    ));
    // Asking for 5000 — must clamp to 1000 per page.
    await backend.list({ prefix: '', limit: 5000 });
    expect(captured!.MaxKeys).toBe(1000);
  });

  test('skips Contents entries with missing Key', async () => {
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => ({
        Contents: [
          { Key: 'a', Size: 1, LastModified: new Date(0) },
          { Size: 1, LastModified: new Date(0) }, // no Key — skip
          { Key: 'b', Size: 1, LastModified: new Date(0) },
        ],
        IsTruncated: false,
      }) },
    ));
    const items = await backend.list({ prefix: '' });
    expect(items.map(i => i.key)).toEqual(['a', 'b']);
  });

  test('handles empty Contents (undefined) without crashing', async () => {
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => ({ /* no Contents */ IsTruncated: false }) },
    ));
    expect(await backend.list({ prefix: '' })).toEqual([]);
  });
});

describe('S3ObjectStorageBackend — close()', () => {
  test('close before any operation is a no-op (client never constructed)', async () => {
    const backend = new S3ObjectStorageBackend(s3Opts());
    await backend.close();
    expect(fakeClientsConstructed.length).toBe(0);
  });

  test('close after operation destroys the constructed S3Client', async () => {
    const backend = new S3ObjectStorageBackend(s3Opts());
    void backend.list({ prefix: '' }).catch(() => {});
    await Promise.resolve(); await Promise.resolve();
    expect(fakeClientsConstructed.length).toBe(1);
    // Replace send so close()'s await doesn't trip on the default empty result.
    fakeClientsConstructed[0]!.send = async () => ({ Contents: [], IsTruncated: false });
    await backend.close();
    expect(fakeClientsConstructed[0]!.destroyed).toBe(true);
  });

  test('close is safe when the injected client lacks destroy()', async () => {
    // Some users inject a thin S3ClientLike that doesn't expose
    // destroy.  close() must not throw.
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async () => ({ Contents: [], IsTruncated: false }) },
    ));
    await backend.list({ prefix: '' });
    await expect(backend.close()).resolves.toBeUndefined();
  });
});
