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
  send: (command: { input: unknown }) => Promise<unknown> = async () => ({});
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
import { S3_MAX_KEY_LENGTH_BYTES } from '../../../../src/persistence/Constants.js';

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
    const config = fakeClientsConstructed[0]!.config as Record<string, unknown>;
    expect(config.region).toBe('auto');
    expect(config.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
    expect(config.forcePathStyle).toBe(true);
    expect(config.credentials).toEqual(creds);
  });

  test('omitting endpoint / credentials passes undefined (SDK default chain)', async () => {
    const s3Options = S3ObjectStorageOptions.create()
      .withBucket('b')
      .withRegion('us-west-2');
    const backend = new S3ObjectStorageBackend(s3Options);
    await backend.list({ prefix: '' });
    const config = fakeClientsConstructed[0]!.config as Record<string, unknown>;
    expect(config.region).toBe('us-west-2');
    expect(config.endpoint).toBeUndefined();
    expect(config.forcePathStyle).toBeUndefined();
    expect(config.credentials).toBeUndefined();
  });
});

describe('S3ObjectStorageBackend — put: SSE / KMS option translation', () => {
  test('sse: "AES256" sets ServerSideEncryption=AES256, no KMS key', async () => {
    let captured: unknown;
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async (command: { input: unknown }) => { captured = command.input; return { ETag: '"e"' }; } },
    ));
    await backend.put('k', new Uint8Array([0]), { sse: 'AES256' });
    const input = captured as Record<string, unknown>;
    expect(input.ServerSideEncryption).toBe('AES256');
    expect(input.SSEKMSKeyId).toBeUndefined();
  });

  test('sse: { kmsKeyId } sets ServerSideEncryption=aws:kms + SSEKMSKeyId', async () => {
    let captured: unknown;
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async (command: { input: unknown }) => { captured = command.input; return { ETag: '"e"' }; } },
    ));
    await backend.put('k', new Uint8Array([0]), { sse: { kmsKeyId: 'arn:aws:kms:us-east-1:111:key/abc' } });
    const input = captured as Record<string, unknown>;
    expect(input.ServerSideEncryption).toBe('aws:kms');
    expect(input.SSEKMSKeyId).toBe('arn:aws:kms:us-east-1:111:key/abc');
  });

  test('no sse option leaves ServerSideEncryption / SSEKMSKeyId undefined', async () => {
    let captured: unknown;
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async (command: { input: unknown }) => { captured = command.input; return { ETag: '"e"' }; } },
    ));
    await backend.put('k', new Uint8Array([0]));
    const input = captured as Record<string, unknown>;
    expect(input.ServerSideEncryption).toBeUndefined();
    expect(input.SSEKMSKeyId).toBeUndefined();
  });

  test('forwards contentType + contentEncoding + ifMatch + ifNoneMatch', async () => {
    let captured: unknown;
    const backend = new S3ObjectStorageBackend(s3OptsWithClient(
      { send: async (command: { input: unknown }) => { captured = command.input; return { ETag: '"e"' }; } },
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
      { send: async (command: { input: unknown }) => {
        seenTokens.push((command.input as { ContinuationToken?: string }).ContinuationToken);
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
      { send: async (command: { input: unknown }) => {
        captured = command.input as Record<string, unknown>;
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

/**
 * #747 — until this issue the S3 backend validated no key at all.
 *
 * `put`/`get`/`delete`/`list` handed the caller's string straight to the SDK
 * command constructor, which made it the one object-storage backend with no
 * front-line key check — and the reason a rotation sweep could meet a key
 * nothing in the framework had ever looked at.  These are unit-level because
 * the live S3 suite is `describe.skip` without MinIO; the assertion is that
 * the SDK is never reached, so a mocked client is the right instrument.
 */
describe('S3ObjectStorageBackend — key validation (#747)', () => {
  /**
   * Records whether the SDK was reached at all — which is the assertion in
   * every case below.  The reply satisfies `put`, `get` and `list` alike so a
   * key that gets through fails on nothing but its own merits.
   */
  const trackingBackend = (): { backend: S3ObjectStorageBackend; sent: () => number } => {
    let sendCalls = 0;
    const backend = new S3ObjectStorageBackend(s3OptsWithClient({
      send: async () => {
        sendCalls++;
        return {
          ETag: '"e"',
          Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
          Contents: [],
          IsTruncated: false,
        };
      },
    }));
    return { backend, sent: () => sendCalls };
  };

  /**
   * Composed rather than written as a literal: a raw control byte in a source
   * file makes git treat it as binary.
   */
  const keyWithControlChar = (charCode: number): string =>
    `pid${String.fromCharCode(charCode)}x/snap.json`;

  test('put refuses an empty key without reaching the SDK', async () => {
    const { backend, sent } = trackingBackend();
    await expect(backend.put('', new Uint8Array([0]))).rejects.toThrow(ObjectStorageBackendError);
    await expect(backend.put('', new Uint8Array([0]))).rejects.toThrow(/must be a non-empty string/);
    expect(sent()).toBe(0);
  });

  test('every operation refuses a NUL byte', async () => {
    const { backend, sent } = trackingBackend();
    await expect(backend.put('a\0b', new Uint8Array([0]))).rejects.toThrow(/invalid key/);
    await expect(backend.get('a\0b')).rejects.toThrow(/NUL byte not allowed/);
    await expect(backend.delete('a\0b')).rejects.toThrow(/NUL byte not allowed/);
    await expect(backend.list({ prefix: 'a\0b' })).rejects.toThrow(/NUL byte not allowed/);
    expect(sent()).toBe(0);
  });

  test('put refuses a control character; get and delete do not', async () => {
    // Write path only, for the same reason as the filesystem backend: a
    // bucket may already hold such a key, and refusing it on read would
    // strand the object rather than prevent anything.
    const { backend, sent } = trackingBackend();
    await expect(backend.put(keyWithControlChar(1), new Uint8Array([0])))
      .rejects.toThrow(/control character at index 3 [(]charCode=1[)]/);
    expect(sent()).toBe(0);

    await expect(backend.get(keyWithControlChar(1))).resolves.toBeDefined();
    await expect(backend.delete(keyWithControlChar(1))).resolves.toBeUndefined();
    expect(sent()).toBe(2);
  });

  test('a key over S3 own 1024-byte ceiling is refused locally', async () => {
    const { backend, sent } = trackingBackend();
    const tooLong = 'a'.repeat(S3_MAX_KEY_LENGTH_BYTES + 1);
    await expect(backend.put(tooLong, new Uint8Array([0]))).rejects.toThrow(/exceeds 1024-byte limit/);
    await expect(backend.get(tooLong)).rejects.toThrow(/exceeds 1024-byte limit/);
    expect(sent()).toBe(0);

    // Exactly at the limit is legal — the bound must not be off by one.
    await backend.put('a'.repeat(S3_MAX_KEY_LENGTH_BYTES), new Uint8Array([0]));
    expect(sent()).toBe(1);
  });

  test('the ceiling counts UTF-8 bytes, which is how S3 states it', async () => {
    const { backend, sent } = trackingBackend();
    // 600 CJK characters: well inside a 1024-*character* check, and 1800
    // bytes on the wire.  A character count would let the SDK take the 400.
    const cjk = '一'.repeat(600);
    expect(cjk.length).toBeLessThan(S3_MAX_KEY_LENGTH_BYTES);
    await expect(backend.put(cjk, new Uint8Array([0])))
      .rejects.toThrow(/exceeds 1024-byte limit \(got 1800 UTF-8 bytes from 600 characters\)/);
    expect(sent()).toBe(0);
  });

  test('list still accepts the empty prefix', async () => {
    // "Everything" is the standard list-all semantic and the one shape the
    // non-empty rules would refuse outright.
    const { backend, sent } = trackingBackend();
    await expect(backend.list({ prefix: '' })).resolves.toEqual([]);
    expect(sent()).toBe(1);
  });

  test('an ordinary key is unaffected on every operation', async () => {
    const { backend, sent } = trackingBackend();
    await backend.put('snapshots/user-1/00000000000000000001.json', new Uint8Array([0]));
    await backend.get('snapshots/user-1/00000000000000000001.json');
    await backend.delete('snapshots/user-1/00000000000000000001.json');
    await backend.list({ prefix: 'snapshots/' });
    expect(sent()).toBe(4);
  });

  test('S3 opaque-key semantics are preserved — traversal shapes are not path rules here', async () => {
    // Deliberately narrower than the filesystem rules: `..` does not resolve
    // in a bucket, so refusing it would reject a legitimate key for a threat
    // that does not exist on this backend.
    const { backend, sent } = trackingBackend();
    await backend.put('a/../b', new Uint8Array([0]));
    await backend.put('/leading-slash', new Uint8Array([0]));
    expect(sent()).toBe(2);
  });
});
