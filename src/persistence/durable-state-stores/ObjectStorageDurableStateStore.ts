import { JournalError } from '../JournalTypes.js';
import { encodeBody, decodeBody } from '../object-storage/BodyCodec.js';
import {
  activeEncryptKey,
  isVersionedKeyShape,
  resolveDecryptSubkey,
} from '../object-storage/Encryption.js';
import {
  ObjectStorageConcurrencyError,
  type ObjectStorageBackend,
} from '../object-storage/ObjectStorageBackend.js';
import {
  resolveCompression,
  resolveEncryption,
  type CompressionConfig,
  type CompressionResolver,
  type EncryptionConfig,
  type EncryptionResolver,
} from '../object-storage/PluginConfig.js';
import {
  DurableStateConcurrencyError,
  type DurableStateRecord,
  type DurableStateStore,
} from '../DurableStateStore.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import { none, some, type Option } from '../../util/Option.js';

/**
 * DurableState backed by any `ObjectStorageBackend`.  Each
 * `persistenceId` lives at the single key
 * `<prefix><pid>/state.json` and is rewritten in place — there is no
 * sequence-padded history, and `revision` lives entirely in the body.
 *
 * Strict CAS via ETag.  Every successful `load` and `upsert` caches the
 * server's ETag; the next `upsert(expectedRevision = N)` translates to:
 *
 *   - `expectedRevision === 0`  → `If-None-Match: '*'` (refuse if the key already exists)
 *   - `expectedRevision > 0`    → `If-Match: <cached etag>` (refuse if the bucket diverged)
 *
 * Either form, when rejected by the backend, surfaces as
 * `DurableStateConcurrencyError` with the expected revision.  The
 * `actual` field defaults to `-1` because the backend doesn't tell us
 * the colliding revision — caller can `load` to read it.
 */

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

export interface ObjectStorageDurableStateStoreOptions {
  readonly backend: ObjectStorageBackend;
  readonly prefix?: string;
  readonly compression?: CompressionConfig | CompressionResolver;
  readonly encryption?: EncryptionConfig | EncryptionResolver;
}

interface CachedEntry {
  readonly etag: string;
  readonly revision: number;
}

export class ObjectStorageDurableStateStore implements DurableStateStore {
  private readonly backend: ObjectStorageBackend;
  private readonly prefix: string;
  private readonly compression: CompressionConfig | CompressionResolver | undefined;
  private readonly encryption: EncryptionConfig | EncryptionResolver | undefined;
  private readonly etagCache = new Map<string, CachedEntry>();

  constructor(opts: ObjectStorageDurableStateStoreOptions) {
    this.backend = opts.backend;
    this.prefix = opts.prefix ?? '';
    this.compression = opts.compression;
    this.encryption = opts.encryption;
  }

  async load<S>(pid: string, options?: PersistenceOptions): Promise<Option<DurableStateRecord<S>>> {
    const fetched = await this.backend.get(this.keyFor(pid));
    if (fetched.isNone()) return none;
    // Per-call encryption (from the actor) wins over the plugin default.
    const encryption = options?.encryption
      ?? resolveEncryption(this.encryption, pid, { mode: 'none' });
    const subKeyFor = resolveDecryptSubkey(encryption, pid);
    const decoded = await decodeBody(
      fetched.value.body,
      subKeyFor ? { encryption: { subKeyFor } } : undefined,
    );
    let parsed: { revision: number; state: S; timestamp: number };
    try { parsed = JSON.parse(utf8Decoder.decode(decoded.payload)); }
    catch (e) {
      throw new JournalError(`ObjectStorageDurableStateStore.load: malformed JSON for ${pid}`, e);
    }
    this.etagCache.set(pid, { etag: fetched.value.etag, revision: parsed.revision });
    return some({
      persistenceId: pid,
      revision: parsed.revision,
      state: parsed.state,
      timestamp: parsed.timestamp,
    });
  }

  async upsert<S>(
    pid: string,
    expectedRevision: number,
    state: S,
    options?: PersistenceOptions,
  ): Promise<DurableStateRecord<S>> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new JournalError(`DurableState.upsert: expectedRevision must be a non-negative integer, got ${expectedRevision}`);
    }
    // Per-call options take precedence over plugin defaults / resolver —
    // matches the SnapshotStore precedence order.
    const compression = options?.compression
      ?? resolveCompression(this.compression, pid, { algorithm: 'gzip' });
    const encryption = options?.encryption
      ?? resolveEncryption(this.encryption, pid, { mode: 'none' });

    const now = Date.now();
    const newRevision = expectedRevision + 1;
    const json = JSON.stringify({ revision: newRevision, state, timestamp: now });
    const active = await activeEncryptKey(encryption, pid);
    const stampVersion = active && isVersionedKeyShape(encryption);
    const body = await encodeBody(utf8.encode(json), {
      compression: compression.algorithm,
      encryption: active
        ? {
            subKey: active.subKey,
            ...(stampVersion ? { keyVersion: active.keyVersion } : {}),
          }
        : undefined,
    });

    const cached = this.etagCache.get(pid);

    // If we have a cached snapshot and its revision doesn't match what the
    // caller expects, the caller is stale — surface CAS up-front rather
    // than overwriting the wrong record.
    if (cached !== undefined && cached.revision !== expectedRevision) {
      throw new DurableStateConcurrencyError(pid, expectedRevision, cached.revision);
    }

    const ifMatch = expectedRevision === 0 ? undefined : cached?.etag;
    const ifNoneMatch: '*' | undefined = expectedRevision === 0 ? '*' : undefined;
    void ifMatch;  // re-read after possible refresh below

    if (expectedRevision > 0 && cached === undefined) {
      // We were asked to expect revision N>0 but have no etag in cache.  Two
      // legitimate paths: caller never `load`ed (operator error) or cache
      // was wiped (e.g. on actor restart).  Do an extra load to refresh;
      // if the bucket's revision matches expected, retry with the fresh
      // etag.  If not, surface the concurrency error so the caller can
      // recover.
      // Pass `options` so the cache-refresh load can decrypt with the
      // caller's encryption preferences.
      const opt = await this.load<S>(pid, options);
      if (opt.isNone()) {
        throw new DurableStateConcurrencyError(pid, expectedRevision, 0);
      }
      if (opt.value.revision !== expectedRevision) {
        throw new DurableStateConcurrencyError(pid, expectedRevision, opt.value.revision);
      }
    }

    const refreshedEtag = this.etagCache.get(pid)?.etag;
    const effectiveIfMatch = expectedRevision === 0 ? undefined : refreshedEtag;

    let etag: string;
    try {
      const result = await this.backend.put(this.keyFor(pid), body, {
        contentType: 'application/json',
        contentEncoding: compression.algorithm === 'none' ? undefined : compression.algorithm,
        ifMatch: effectiveIfMatch,
        ifNoneMatch,
        sse: encryption.mode === 'sse-s3' ? 'AES256'
           : encryption.mode === 'sse-kms' ? { kmsKeyId: encryption.kmsKeyId }
           : undefined,
      });
      etag = result.etag;
    } catch (e) {
      if (e instanceof ObjectStorageConcurrencyError) {
        // -1 communicates "the backend rejected us, but didn't tell us the
        // current revision; load() will fetch the truth".
        throw new DurableStateConcurrencyError(pid, expectedRevision, -1);
      }
      throw e;
    }

    this.etagCache.set(pid, { etag, revision: newRevision });
    return { persistenceId: pid, revision: newRevision, state, timestamp: now };
  }

  async delete(pid: string): Promise<void> {
    await this.backend.delete(this.keyFor(pid));
    this.etagCache.delete(pid);
  }

  async close(): Promise<void> {
    this.etagCache.clear();
    await this.backend.close?.();
  }

  /** Test hook — drop the cached ETag for a pid (simulates actor restart). */
  forgetEtagForTest(pid: string): void {
    this.etagCache.delete(pid);
  }

  /* ----------------------------- internals ------------------------------ */

  private keyFor(pid: string): string {
    return `${this.prefix}${pid}/state.json`;
  }
}
