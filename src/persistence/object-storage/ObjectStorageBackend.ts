import type { Option } from '../../util/Option.js';

/**
 * Generic object-storage abstraction — the same surface that an S3-style
 * service exposes (PUT / GET / DELETE / LIST), reduced to the minimum
 * actor-ts needs.  Two implementations ship: `FilesystemObjectStorage
 * Backend` for tests and local dev, `S3ObjectStorageBackend` for any
 * S3-compatible service (AWS S3, MinIO, Cloudflare R2, Backblaze B2, …).
 *
 * The `ifMatch` / `ifNoneMatch` options exist to support optimistic
 * concurrency control — required by `ObjectStorageDurableStateStore` to
 * detect concurrent writers.  Backends that can't honour them (e.g. some
 * older S3-compatible stores) must throw `ObjectStorageBackendError` with
 * a clear message rather than silently ignoring them, so callers know
 * their CAS expectation was lost.
 */

export interface PutOptions {
  readonly contentType?: string;
  /** Set when the body is compressed; matches the HTTP `Content-Encoding` header. */
  readonly contentEncoding?: string;
  /**
   * Strict CAS: the operation succeeds only if the object's current ETag
   * matches.  Mismatch → `ObjectStorageConcurrencyError`.  S3 maps this
   * to the `If-Match` request header.
   */
  readonly ifMatch?: string;
  /**
   * Create-only — succeed only if the object does NOT yet exist.  The
   * sentinel `'*'` matches S3's `If-None-Match: *` semantics.
   */
  readonly ifNoneMatch?: '*';
  /**
   * Server-side encryption hint.  Only honoured by S3-style backends;
   * filesystem backends ignore it.
   */
  readonly sse?: 'AES256' | { readonly kmsKeyId: string };
}

export interface ObjectInfo {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
}

export interface ObjectFetched {
  readonly body: Uint8Array;
  readonly etag: string;
  readonly lastModified: Date;
  readonly contentEncoding?: string;
  readonly contentType?: string;
}

export interface ObjectStorageBackend {
  /** PUT — returns the new ETag.  Throws on CAS failure. */
  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<{ etag: string }>;
  /** GET — None if the object doesn't exist. */
  get(key: string): Promise<Option<ObjectFetched>>;
  /** DELETE — idempotent; deleting a non-existent key is a no-op. */
  delete(key: string): Promise<void>;
  /**
   * LIST — returns object keys under `prefix`, sorted ascending by key.
   * `limit` is a soft cap, the backend may return fewer entries.
   */
  list(opts: { readonly prefix: string; readonly limit?: number }): Promise<ObjectInfo[]>;
  /** Optional: shut down any underlying client / file handle. */
  close?(): Promise<void>;
}

/**
 * CAS conflict — thrown by `put` when `ifMatch` / `ifNoneMatch` rejects.
 * Backends should map their native conflict (412 Precondition Failed for
 * S3, OS-level rename-failure for filesystem) to this error type so
 * higher layers can detect it portably.
 */
export class ObjectStorageConcurrencyError extends Error {
  constructor(public readonly key: string, message?: string) {
    super(message ?? `object-storage CAS conflict on key ${key}`);
    this.name = 'ObjectStorageConcurrencyError';
  }
}

/** Generic fault from a backend operation that isn't a CAS conflict. */
export class ObjectStorageBackendError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ObjectStorageBackendError';
  }
}
