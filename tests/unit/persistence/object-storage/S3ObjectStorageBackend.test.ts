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
  send: (command: { input: unknown }) => Promise<unknown> =
    async (command) => respondFromFakeBucket(command.input as Record<string, unknown>);
  destroy(): void { this.destroyed = true; }
  destroyed = false;
}
class FakeCommand { constructor(public readonly input: unknown) {} }

const fakeClientsConstructed: FakeS3Client[] = [];

/**
 * Opt-in in-memory bucket for the config-driven round trip at the bottom of
 * this file.  `null` everywhere else, where `send` answers `{}` exactly as it
 * did before — every other test either injects its own `send` or asserts on
 * what the backend *sent*, not on what came back.
 */
let fakeBucket: Map<string, { body: Uint8Array; contentType?: string }> | null = null;

/**
 * Dispatch on the input shape, which is all a `FakeCommand` records: a PUT is
 * the only input carrying `Body`, a LIST the only one carrying `Prefix`.  A
 * DELETE is indistinguishable from a GET here and falls into the GET branch —
 * harmless, because `delete` ignores the response and the round trip below
 * saves one snapshot under the default `keepN`, so it never prunes.
 */
async function respondFromFakeBucket(input: Record<string, unknown>): Promise<unknown> {
  if (fakeBucket === null) return {};
  if (input.Body !== undefined) {
    fakeBucket.set(input.Key as string, {
      body: input.Body as Uint8Array,
      contentType: input.ContentType as string | undefined,
    });
    return { ETag: '"stored"' };
  }
  if (input.Prefix !== undefined) {
    const prefix = input.Prefix as string;
    const Contents = [...fakeBucket.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([Key, value]) => ({ Key, Size: value.body.length, LastModified: new Date(0) }));
    return { Contents, IsTruncated: false };
  }
  const stored = fakeBucket.get(input.Key as string);
  if (stored === undefined) {
    const missing = new Error('NoSuchKey');
    missing.name = 'NoSuchKey';
    throw missing;
  }
  return {
    Body: { transformToByteArray: async () => stored.body },
    ETag: '"stored"',
    ContentType: stored.contentType,
  };
}

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
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { PersistenceExtensionId } from '../../../../src/persistence/PersistenceExtension.js';
import {
  OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID,
  registerObjectStoragePlugins,
} from '../../../../src/persistence/object-storage/ObjectStoragePlugin.js';

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

/*
 * #873 — the acceptance criterion, made into a test: an S3 snapshot store
 * configured entirely from HOCON round-trips a snapshot, and key material
 * never appears in the config.
 *
 * It lives here rather than under `tests/integration/` because
 * `@aws-sdk/client-s3` is an optional peer that is NOT in root
 * `devDependencies` — it lives in `tests/integration/brokers/package.json` —
 * so a real S3 round trip cannot run under `bun test` at all.  The fake above
 * is the only place the whole path can be observed end to end.
 */
describe('S3ObjectStorageBackend — built from HOCON by the object-storage plugin (#873)', () => {
  beforeEach(() => { fakeBucket = new Map(); });
  afterEach(() => { fakeBucket = null; });

  /** The plugin block, nested — the dotted-key form stays a literal in HOCON. */
  function systemOptionsFor(objectStorage: ConfigObject): ActorSystemOptions {
    return ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: {
            'snapshot-store': {
              plugin: OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID,
              'object-storage': objectStorage,
            },
          },
        },
      });
  }

  test('the config block reaches the S3Client, round-trips a snapshot, and carries no credentials', async () => {
    const sys = ActorSystem.create('s3-snapshot-store-from-config', systemOptionsFor({
      backend: 's3',
      prefix: 'snapshots/',
      s3: {
        bucket: 'my-app',
        region: 'auto',
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        'force-path-style': true,
      },
    }));
    const ext = sys.extension(PersistenceExtensionId);
    // No options argument at all — everything below came out of the block.
    const { close } = await registerObjectStoragePlugins(ext);

    await ext.snapshotStore.save('account-42', 7, { balance: 255 });
    const latest = await ext.snapshotStore.loadLatest<{ balance: number }>('account-42');

    expect(latest.toNullable()?.state).toEqual({ balance: 255 });
    expect(latest.toNullable()?.sequenceNr).toBe(7);
    // Asserted as "configured prefix … entity tail" rather than as one literal
    // key.  What this test owns is that the prefix out of the config block
    // reached the store; whatever the store puts between the two is the
    // snapshot store's own key layout, pinned by its own suite.
    const storedKeys = [...fakeBucket!.keys()];
    expect(storedKeys.length).toBe(1);
    expect(storedKeys[0]!.startsWith('snapshots/')).toBe(true);
    expect(storedKeys[0]!.endsWith('account-42/00000000000000000007.json')).toBe(true);

    expect(fakeClientsConstructed.length).toBe(1);
    const clientConfig = fakeClientsConstructed[0]!.config as Record<string, unknown>;
    expect(clientConfig.region).toBe('auto');
    expect(clientConfig.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
    expect(clientConfig.forcePathStyle).toBe(true);
    // The security half of the criterion.  `credentials` has no leaf in the
    // block, so the SDK falls through to its default chain (env vars, an EC2
    // instance profile, IRSA) — there is nothing for a config file to leak.
    expect(clientConfig.credentials).toBeUndefined();

    await close();
    await sys.terminate();
  });

  test('the published empty endpoint does not become an endpoint', async () => {
    // reference.conf publishes `endpoint = ""` as the shape of the key.  Passed
    // through it would fail `S3ObjectStorageOptionsValidator`'s URL rule on a
    // leaf the operator never filled in — plain AWS S3 has to stay the default.
    const sys = ActorSystem.create('s3-snapshot-store-plain-aws', systemOptionsFor({
      backend: 's3',
      s3: { bucket: 'my-app', region: 'eu-central-1' },
    }));
    const ext = sys.extension(PersistenceExtensionId);
    const { close } = await registerObjectStoragePlugins(ext);

    await ext.snapshotStore.save('account-1', 1, { balance: 1 });

    const clientConfig = fakeClientsConstructed[0]!.config as Record<string, unknown>;
    expect(clientConfig.region).toBe('eu-central-1');
    expect(clientConfig.endpoint).toBeUndefined();
    // reference.conf's `force-path-style = off` is a real read, so it arrives
    // as an explicit false rather than as an absent field.
    expect(clientConfig.forcePathStyle).toBe(false);

    await close();
    await sys.terminate();
  });
});
