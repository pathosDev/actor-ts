import { Lazy } from '../../util/Lazy.js';
import { none, some, type Option } from '../../util/Option.js';
import { wrapError } from '../../util/WrapError.js';
import {
  ObjectStorageBackendError,
  ObjectStorageConcurrencyError,
  type ObjectFetched,
  type ObjectInfo,
  type ObjectStorageBackend,
  type PutOptions,
} from './ObjectStorageBackend.js';
import { S3ObjectStorageOptionsValidator } from './S3ObjectStorageOptions.js';
import type { S3ObjectStorageOptions, S3ObjectStorageOptionsType } from './S3ObjectStorageOptions.js';

/**
 * S3-compatible `ObjectStorageBackend` — wraps AWS SDK v3
 * (`@aws-sdk/client-s3`) and works against AWS S3, MinIO, Cloudflare R2,
 * Backblaze B2, DigitalOcean Spaces, Wasabi … any service that speaks the
 * S3 API.
 *
 * `@aws-sdk/client-s3` is an **optional peer dependency**: this module
 * lazy-imports the SDK only when `put`/`get`/`delete`/`list` is first
 * called, so users who don't reach for the S3 backend don't pay the
 * ~3-4 MB SDK weight.  The same pattern is used by `NodeHonoRunner`
 * for `@hono/node-server`.
 *
 * **Strict CAS** maps to S3's HTTP preconditions:
 *
 *   - `ifMatch:    '<etag>'` → HTTP `If-Match: <etag>` — refuse if changed
 *   - `ifNoneMatch: '*'`     → HTTP `If-None-Match: *` — refuse if exists
 *
 * Both surface as `412 Precondition Failed` from S3, which we translate
 * to `ObjectStorageConcurrencyError`.  S3 added `If-None-Match` PUT
 * support in August 2024; older S3-compatible stores may reject it —
 * that's a backend-version issue, not a code issue, and the resulting
 * error is propagated as `ObjectStorageBackendError`.
 *
 * **Endpoint override** — for MinIO / R2 / Backblaze: pass `endpoint`
 * and (for path-style services like MinIO) `forcePathStyle: true`.  For
 * R2 the canonical region is `'auto'`.
 */

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export class S3ObjectStorageBackend implements ObjectStorageBackend {
  private readonly clientLazy: Lazy<Promise<S3ClientLike>>;
  private readonly bucket: string;

  constructor(options: S3ObjectStorageOptions) {
    const s = (options as S3ObjectStorageOptionsType);
    new S3ObjectStorageOptionsValidator().validate(s);
    this.bucket = s.bucket;
    this.clientLazy = Lazy.of(async () => {
      if (s.client) return s.client;
      const sdk = await s3SdkLazy.get();
      return new sdk.S3Client({
        region: s.region!,
        endpoint: s.endpoint,
        forcePathStyle: s.forcePathStyle,
        credentials: s.credentials,
      });
    });
  }

  async put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<{ etag: string }> {
    const client = await this.clientLazy.get();
    const sdk = await s3SdkLazy.get();
    const cmd = new sdk.PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: opts.contentType,
      ContentEncoding: opts.contentEncoding,
      IfMatch: opts.ifMatch,
      IfNoneMatch: opts.ifNoneMatch,
      ServerSideEncryption: opts.sse === 'AES256' ? 'AES256'
                          : (opts.sse && typeof opts.sse === 'object') ? 'aws:kms'
                          : undefined,
      SSEKMSKeyId: (opts.sse && typeof opts.sse === 'object') ? opts.sse.kmsKeyId : undefined,
    });
    let result;
    try { result = await client.send(cmd); }
    catch (e) {
      if (isS3PreconditionFailed(e)) {
        throw new ObjectStorageConcurrencyError(
          key, `S3 PUT rejected for ${key}: ${(e as { name?: string }).name ?? 'PreconditionFailed'}`,
        );
      }
      throw wrapError(e, ObjectStorageBackendError, `S3 PUT failed for ${key}`);
    }
    const etag = stripQuotes(result.ETag);
    if (!etag) throw new ObjectStorageBackendError(`S3 PUT returned no ETag for ${key}`);
    return { etag: quote(etag) };
  }

  async get(key: string): Promise<Option<ObjectFetched>> {
    const client = await this.clientLazy.get();
    const sdk = await s3SdkLazy.get();
    const cmd = new sdk.GetObjectCommand({ Bucket: this.bucket, Key: key });
    let result;
    try { result = await client.send(cmd); }
    catch (e) {
      if (isS3NotFound(e)) return none;
      throw wrapError(e, ObjectStorageBackendError, `S3 GET failed for ${key}`);
    }
    if (!result.Body) {
      throw new ObjectStorageBackendError(`S3 GET for ${key} returned empty Body`);
    }
    const body = await readToUint8Array(result.Body);
    const etag = stripQuotes(result.ETag);
    if (!etag) throw new ObjectStorageBackendError(`S3 GET returned no ETag for ${key}`);
    return some({
      body,
      etag: quote(etag),
      lastModified: result.LastModified ?? new Date(),
      contentEncoding: result.ContentEncoding,
      contentType: result.ContentType,
    });
  }

  async delete(key: string): Promise<void> {
    const client = await this.clientLazy.get();
    const sdk = await s3SdkLazy.get();
    const cmd = new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: key });
    try { await client.send(cmd); }
    catch (e) {
      // S3 DELETE is already idempotent — 200/204 even when the key was absent.
      // We only reach this branch on a real error (auth, network, …).
      throw wrapError(e, ObjectStorageBackendError, `S3 DELETE failed for ${key}`);
    }
  }

  async list(opts: { prefix: string; limit?: number }): Promise<ObjectInfo[]> {
    const client = await this.clientLazy.get();
    const sdk = await s3SdkLazy.get();
    const out: ObjectInfo[] = [];
    let continuationToken: string | undefined;
    // Page until either we hit the soft limit or the bucket is exhausted.
    while (true) {
      const remaining = opts.limit ? Math.max(0, opts.limit - out.length) : undefined;
      if (remaining === 0) break;
      const cmd = new sdk.ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: opts.prefix,
        // S3 caps MaxKeys at 1000; we ask for our remaining or 1000.
        MaxKeys: remaining ? Math.min(remaining, 1000) : 1000,
        ContinuationToken: continuationToken,
      });
      let result;
      try { result = await client.send(cmd); }
      catch (e) {
        throw wrapError(e, ObjectStorageBackendError, `S3 LIST failed for prefix=${opts.prefix}`);
      }
      for (const obj of result.Contents ?? []) {
        if (!obj.Key) continue;
        out.push({
          key: obj.Key,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified ?? new Date(0),
        });
      }
      if (!result.IsTruncated || !result.NextContinuationToken) break;
      continuationToken = result.NextContinuationToken;
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  async close(): Promise<void> {
    if (!this.clientLazy.isEvaluated) return;
    const client = await this.clientLazy.get();
    client.destroy?.();
  }
}

/* ----------------------------- internals -------------------------------- */

interface S3SdkModule {
  S3Client: new (config: {
    region: string;
    endpoint?: string;
    forcePathStyle?: boolean;
    credentials?: S3Credentials;
  }) => S3ClientLike;
  PutObjectCommand: new (input: PutObjectCommandInput) => unknown;
  GetObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
  DeleteObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
  ListObjectsV2Command: new (input: ListObjectsV2CommandInput) => unknown;
}

interface PutObjectCommandInput {
  Bucket: string;
  Key: string;
  Body: Uint8Array;
  ContentType?: string;
  ContentEncoding?: string;
  IfMatch?: string;
  IfNoneMatch?: string;
  ServerSideEncryption?: 'AES256' | 'aws:kms';
  SSEKMSKeyId?: string;
}

interface ListObjectsV2CommandInput {
  Bucket: string;
  Prefix: string;
  MaxKeys?: number;
  ContinuationToken?: string;
}

interface S3PutResult { ETag?: string; }
interface S3GetResult {
  Body?: unknown;
  ETag?: string;
  LastModified?: Date;
  ContentEncoding?: string;
  ContentType?: string;
}
interface S3ListResult {
  Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }>;
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

export interface S3ClientLike {
  send(cmd: unknown): Promise<S3PutResult & S3GetResult & S3ListResult>;
  destroy?(): void;
}

const s3SdkLazy: Lazy<Promise<S3SdkModule>> = Lazy.of(async () => {
  try {
    const name = '@aws-sdk/client-s3';
    return (await import(name)) as unknown as S3SdkModule;
  } catch (e) {
    throw new Error(
      'S3ObjectStorageBackend requires the "@aws-sdk/client-s3" package.  Install it with: '
      + 'npm install @aws-sdk/client-s3\nOriginal error: '
      + (e instanceof Error ? e.message : String(e)),
    );
  }
});

function isS3PreconditionFailed(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412;
}

function isS3NotFound(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === 'NoSuchKey' || err.Code === 'NoSuchKey'
      || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404;
}

/**
 * AWS SDK v3 returns `Body` as a stream-like object with helper methods
 * (`transformToByteArray`, `transformToString`).  Bun & Node 20+ provide
 * `.transformToByteArray()` directly; we fall back to manual stream
 * reading for older shims.
 */
async function readToUint8Array(body: unknown): Promise<Uint8Array> {
  if (!body || typeof body !== 'object') {
    throw new Error('S3 GET Body is not a stream object');
  }
  const b = body as { transformToByteArray?: () => Promise<Uint8Array> } & AsyncIterable<Uint8Array>;
  if (typeof b.transformToByteArray === 'function') {
    return await b.transformToByteArray();
  }
  // Fallback: collect chunks from an async iterator.
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of b) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function stripQuotes(s: string | undefined): string | undefined {
  if (!s) return s;
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function quote(s: string): string { return `"${s}"`; }
