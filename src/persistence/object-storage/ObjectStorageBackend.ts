import type { Option } from '../../util/Option.js';
import type { StorageLocality } from '../StorageLocality.js';

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

export type PutOptions = {
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
};

export type ObjectInfo = {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
};

export type ObjectFetched = {
  readonly body: Uint8Array;
  readonly etag: string;
  readonly lastModified: Date;
  readonly contentEncoding?: string;
  readonly contentType?: string;
};

export interface ObjectStorageBackend {
  /** PUT — returns the new ETag.  Throws on CAS failure. */
  put(key: string, body: Uint8Array, options?: PutOptions): Promise<{ etag: string }>;
  /** GET — None if the object doesn't exist. */
  get(key: string): Promise<Option<ObjectFetched>>;
  /** DELETE — idempotent; deleting a non-existent key is a no-op. */
  delete(key: string): Promise<void>;
  /**
   * LIST — returns object keys under `prefix`, sorted ascending by key.
   * `limit` is a soft cap, the backend may return fewer entries.
   */
  list(options: { readonly prefix: string; readonly limit?: number }): Promise<ObjectInfo[]>;
  /**
   * Where objects written through this backend live relative to cluster
   * nodes — the object-storage stores delegate their own declaration here,
   * because locality is the backend's property, not the wrapper's.  See
   * {@link StorageLocality}; absence means unknown (#1356).
   */
  readonly storageLocality?: StorageLocality;
  /**
   * Identity of the bucket/directory behind this backend, minted on first
   * contact and persisted as an object at the root key `storage-identity` —
   * outside every `<prefix><persistenceId>/` layout, because the backend is
   * the database here and stores over one bucket share one identity.  See
   * `Journal.storageIdentity` for the full semantics (#1358).
   */
  storageIdentity?(): Promise<string>;
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

/**
 * Root key of the identity object (#1358) — outside every
 * `<prefix><persistenceId>/` layout by construction: stream keys always
 * carry a `/` after the id, and a bare root key matches no stream prefix.
 */
export const OBJECT_STORAGE_IDENTITY_KEY = 'storage-identity';

/**
 * Claim-or-read the backend's identity (#1358) — one implementation for the
 * in-repo backends, because it needs nothing beyond the contract: a
 * create-only `put` (`ifNoneMatch: '*'`) is the claim, the CAS conflict is
 * the expected losing path, and the stored object wins either way.
 */
export async function resolveObjectStorageIdentity(backend: ObjectStorageBackend): Promise<string> {
  try {
    await backend.put(
      OBJECT_STORAGE_IDENTITY_KEY,
      new TextEncoder().encode(crypto.randomUUID()),
      { contentType: 'text/plain', ifNoneMatch: '*' },
    );
  } catch (e) {
    if (!(e instanceof ObjectStorageConcurrencyError)) throw e;
  }
  const fetched = await backend.get(OBJECT_STORAGE_IDENTITY_KEY);
  const object = fetched.toNullable();
  if (object === null) {
    throw new ObjectStorageBackendError(
      `${OBJECT_STORAGE_IDENTITY_KEY} object missing after the create-only put`,
    );
  }
  const identity = new TextDecoder().decode(object.body).trim();
  if (identity.length === 0) {
    throw new ObjectStorageBackendError(`${OBJECT_STORAGE_IDENTITY_KEY} object is empty`);
  }
  return identity;
}
