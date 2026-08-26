import { JournalError } from '../JournalTypes.js';
import { DEFAULT_MAX_DECOMPRESSED_BYTES, encodeBody, decodeBody } from '../object-storage/BodyCodec.js';
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
  resolveIntegrity,
  type CompressionConfig,
  type CompressionResolver,
  type EncryptionConfig,
  type EncryptionResolver,
  type IntegrityConfig,
  type IntegrityResolver,
} from '../object-storage/PluginConfig.js';
import {
  DurableStateConcurrencyError,
  type DurableStateRecord,
  type DurableStateStore,
} from '../DurableStateStore.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { StorageLocality } from '../StorageLocality.js';
import type { Serializer } from '../../serialization/Serializer.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import { none, some, type Option } from '../../util/Option.js';
import { ObjectStorageDurableStateStoreOptionsValidator } from './ObjectStorageDurableStateStoreOptions.js';
import type { ObjectStorageDurableStateStoreOptions, ObjectStorageDurableStateStoreOptionsType } from './ObjectStorageDurableStateStoreOptions.js';

/**
 * DurableState backed by any `ObjectStorageBackend`.  Each
 * `persistenceId` lives at the single key
 * `<prefix><persistenceId>/state.json` and is rewritten in place — there is no
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

type CachedEntry = {
  readonly etag: string;
  readonly revision: number;
};

export class ObjectStorageDurableStateStore implements DurableStateStore {
  private readonly backend: ObjectStorageBackend;

  /** Locality is the backend's property — a store wrapper adds none of its own (#1356). */
  get storageLocality(): StorageLocality | undefined { return this.backend.storageLocality; }

  /** Identity is the backend's too — bucket/directory = database (#1358). */
  async storageIdentity(): Promise<string> {
    if (this.backend.storageIdentity === undefined) {
      throw new JournalError('ObjectStorageDurableStateStore.storageIdentity: the backend declares none');
    }
    return this.backend.storageIdentity();
  }
  private readonly ownsBackend: boolean;
  private readonly prefix: string;
  private readonly compression: CompressionConfig | CompressionResolver | undefined;
  private readonly encryption: EncryptionConfig | EncryptionResolver | undefined;
  private readonly integrity: IntegrityConfig | IntegrityResolver | undefined;
  private readonly allowUntaggedBodies: boolean;
  private readonly requireContextBinding: boolean;
  private readonly rejectRevisionRollback: boolean;
  private readonly maxDecompressedBytes: number;
  private readonly etagCache = new Map<string, CachedEntry>();
  /**
   * Highest revision this process has ever seen per persistenceId — the
   * in-process rollback floor (#612).
   *
   * Deliberately NOT folded into {@link etagCache}.  That cache is
   * dropped whenever the backend rejects a CAS (#117), which is exactly
   * how a stale writer recovers; a floor that vanished with it would
   * evaporate on the first CAS conflict an attacker can provoke.  The
   * two have opposite lifetimes — one is a hint that must be
   * discardable, the other a monotonic assertion that must not be — so
   * they get separate maps.
   */
  private readonly revisionFloor = new Map<string, number>();

  private readonly serializer?: Serializer;

  constructor(options: ObjectStorageDurableStateStoreOptions) {
    const resolvedOptions = (options as ObjectStorageDurableStateStoreOptionsType);
    if (resolvedOptions.backend === undefined) throw new Error('ObjectStorageDurableStateStore: backend is required (call withBackend()).');
    new ObjectStorageDurableStateStoreOptionsValidator().validate(resolvedOptions);
    this.backend = resolvedOptions.backend;
    this.ownsBackend = resolvedOptions.ownsBackend ?? true;
    this.prefix = resolvedOptions.prefix ?? '';
    this.compression = resolvedOptions.compression;
    this.encryption = resolvedOptions.encryption;
    this.integrity = resolvedOptions.integrity;
    this.allowUntaggedBodies = resolvedOptions.allowUntaggedBodies ?? false;
    this.requireContextBinding = resolvedOptions.requireContextBinding ?? false;
    this.rejectRevisionRollback = resolvedOptions.rejectRevisionRollback ?? true;
    this.maxDecompressedBytes = resolvedOptions.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
    this.serializer = resolvedOptions.serializer;
  }

  async load<S>(persistenceId: string, options?: PersistenceOptions): Promise<Option<DurableStateRecord<S>>> {
    const storageKey = this.keyFor(persistenceId);
    const fetched = await this.backend.get(storageKey);
    if (fetched.isNone()) return none;
    // Per-call encryption (from the actor) wins over the plugin default.
    const encryption = options?.encryption
      ?? resolveEncryption(this.encryption, persistenceId, { mode: 'none' });
    const integrity = options?.integrity
      ?? resolveIntegrity(this.integrity, persistenceId, { mode: 'none' });
    const subKeyFor = resolveDecryptSubkey(encryption, persistenceId);
    // Handing `decodeBody` the key is what demands a tag — an untagged
    // body is refused unless the operator opened the migration window
    // (#579).  Note this covers the per-call `options.integrity` path
    // too: the demand travels with the key, not with the store field.
    const decodeOptions: import('../object-storage/BodyCodec.js').DecodeOptions = {
      ...(subKeyFor ? { encryption: { subKeyFor } } : {}),
      ...(integrity.mode === 'hmac-sha256'
        ? {
            integrity: {
              integrityKey: integrity.integrityKey,
              allowUntaggedBodies: this.allowUntaggedBodies,
            },
          }
        : {}),
      context: storageKey,
      // Only demand the binding where something authenticates it.  A
      // store with neither encryption nor integrity has no bound bodies
      // of its own to read back, so the demand there would reject
      // everything including its own writes (#612).
      ...(this.requireContextBinding && authenticates(encryption, integrity)
        ? { requireContextBinding: true }
        : {}),
      maxOutputBytes: this.maxDecompressedBytes,
    };
    let decoded: import('../object-storage/BodyCodec.js').DecodedBody;
    try {
      decoded = await decodeBody(fetched.value.body, decodeOptions);
    } catch (e) {
      throw new JournalError(
        `ObjectStorageDurableStateStore.load: integrity / decode failure for ${persistenceId}`,
        e,
      );
    }
    let parsed: { revision: number; state: S; timestamp: number };
    try { parsed = decodePayload(utf8Decoder.decode(decoded.payload), this.serializer) as { revision: number; state: S; timestamp: number }; }
    catch (e) {
      throw new JournalError(`ObjectStorageDurableStateStore.load: malformed JSON for ${persistenceId}`, e);
    }
    this.assertNoRollback(persistenceId, parsed.revision);
    // Cache AFTER decode succeeds (integrity check inside decodeBody).
    // Before #116 we cached before parsing; an attacker could tamper
    // with the revision in the body and the cache would trust it.
    this.etagCache.set(persistenceId, { etag: fetched.value.etag, revision: parsed.revision });
    this.raiseRevisionFloor(persistenceId, parsed.revision);
    return some({
      persistenceId: persistenceId,
      revision: parsed.revision,
      state: parsed.state,
      timestamp: parsed.timestamp,
    });
  }

  async upsert<S>(
    persistenceId: string,
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
      ?? resolveCompression(this.compression, persistenceId, { algorithm: 'gzip' });
    const encryption = options?.encryption
      ?? resolveEncryption(this.encryption, persistenceId, { mode: 'none' });
    const integrity = options?.integrity
      ?? resolveIntegrity(this.integrity, persistenceId, { mode: 'none' });

    const now = Date.now();
    const newRevision = expectedRevision + 1;
    const storageKey = this.keyFor(persistenceId);
    const json = encodePayload({ revision: newRevision, state, timestamp: now }, this.serializer);
    const active = await activeEncryptKey(encryption, persistenceId);
    const stampVersion = active && isVersionedKeyShape(encryption);
    const body = await encodeBody(utf8.encode(json), {
      compression: compression.algorithm,
      compressionLevel: compression.level,
      encryption: active
        ? {
            subKey: active.subKey,
            ...(stampVersion ? { keyVersion: active.keyVersion } : {}),
          }
        : undefined,
      ...(integrity.mode === 'hmac-sha256'
        ? { integrity: { integrityKey: integrity.integrityKey } }
        : {}),
      context: storageKey,
    });

    const cached = this.etagCache.get(persistenceId);

    // If we have a cached snapshot and its revision doesn't match what the
    // caller expects, the caller is stale — surface CAS up-front rather
    // than overwriting the wrong record.
    if (cached !== undefined && cached.revision !== expectedRevision) {
      throw new DurableStateConcurrencyError(persistenceId, expectedRevision, cached.revision);
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
      const option = await this.load<S>(persistenceId, options);
      if (option.isNone()) {
        throw new DurableStateConcurrencyError(persistenceId, expectedRevision, 0);
      }
      if (option.value.revision !== expectedRevision) {
        throw new DurableStateConcurrencyError(persistenceId, expectedRevision, option.value.revision);
      }
    }

    const refreshedEtag = this.etagCache.get(persistenceId)?.etag;
    const effectiveIfMatch = expectedRevision === 0 ? undefined : refreshedEtag;

    let etag: string;
    try {
      const result = await this.backend.put(storageKey, body, {
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
        // Drop the cached etag: the backend just told us it is stale, and the
        // `If-Match` above is built from this cache.  Keeping it meant every
        // retry re-sent the same stale etag and was rejected again, so an
        // entry stayed wedged until something happened to call `load` (which
        // refreshes the cache) or `delete`.  Forgetting it makes the next
        // attempt fetch the real etag instead.
        this.etagCache.delete(persistenceId);
        // -1 communicates "the backend rejected us, but didn't tell us the
        // current revision; load() will fetch the truth".
        throw new DurableStateConcurrencyError(persistenceId, expectedRevision, -1);
      }
      throw e;
    }

    this.etagCache.set(persistenceId, { etag, revision: newRevision });
    this.raiseRevisionFloor(persistenceId, newRevision);
    return { persistenceId: persistenceId, revision: newRevision, state, timestamp: now };
  }

  async delete(persistenceId: string): Promise<void> {
    await this.backend.delete(this.keyFor(persistenceId));
    this.etagCache.delete(persistenceId);
    // The record is gone on purpose, so the next `upsert(0)` legitimately
    // starts over at revision 1.  Keeping the floor would make this
    // store refuse to read back a record it deleted itself.
    this.revisionFloor.delete(persistenceId);
  }

  async close(): Promise<void> {
    this.etagCache.clear();
    this.revisionFloor.clear();
    // Only close a backend we own.  When it's shared (e.g. registerObjectStoragePlugins
    // hands the same backend to the snapshot + durable-state stores) the owner closes it.
    if (this.ownsBackend) await this.backend.close?.();
  }

  /**
   * Test hook — drop the cached ETag for a persistenceId (simulates
   * actor restart).
   *
   * It deliberately leaves {@link revisionFloor} alone.  An actor
   * restart does not restart the process, and the floor is process-local
   * state that outlives any one actor — clearing it here would make the
   * hook simulate something stronger than the restart it is named for,
   * and would hand every rollback test a free pass (#612).
   */
  forgetEtagForTest(persistenceId: string): void {
    this.etagCache.delete(persistenceId);
  }

  /* ----------------------------- internals ------------------------------ */

  /**
   * Refuse a body whose revision is below the highest this process has
   * already observed for the same persistenceId (#612).
   *
   * Both authenticators cover the bytes of one body, and the revision
   * lives inside those bytes — so an *authentic older* body replayed
   * over a newer one passes every check the codec makes.  Nothing on the
   * read path had a reason to disbelieve it: `load` adopted whatever
   * revision arrived, and an ordinary actor restart was enough to make
   * the store hand that rolled-back state to the actor.
   *
   * The floor is in-process only, so it does not survive a restart of
   * the process itself; a durable floor needs trusted state outside the
   * bucket, which the framework has no seam for yet.  This closes the
   * cheap version of the attack, not every version of it.
   */
  private assertNoRollback(persistenceId: string, revision: number): void {
    if (!this.rejectRevisionRollback) return;
    const floor = this.revisionFloor.get(persistenceId);
    if (floor === undefined || revision >= floor) return;
    throw new JournalError(
      `ObjectStorageDurableStateStore.load: revision rollback for ${persistenceId} — the `
      + `stored body claims revision ${revision} but this process has already seen `
      + `${floor}.  An authentic older body was replayed over a newer one, or the bucket `
      + `was restored from a backup underneath a running process.  Restart the process `
      + `after a deliberate restore, or set rejectRevisionRollback: false if this store `
      + `shares a bucket with a writer that recreates records from scratch.`,
    );
  }

  private raiseRevisionFloor(persistenceId: string, revision: number): void {
    if (!this.rejectRevisionRollback) return;
    const floor = this.revisionFloor.get(persistenceId);
    if (floor === undefined || revision > floor) this.revisionFloor.set(persistenceId, revision);
  }

  private keyFor(persistenceId: string): string {
    return `${this.prefix}${persistenceId}/state.json`;
  }
}

/**
 * Whether the resolved configuration authenticates a body at all — the
 * precondition for demanding a context binding on read (#612).
 */
function authenticates(encryption: EncryptionConfig, integrity: IntegrityConfig): boolean {
  return encryption.mode === 'client-aes256-gcm' || integrity.mode === 'hmac-sha256';
}
