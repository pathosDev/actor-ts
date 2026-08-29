import { SEQ_PADDING } from '../Constants.js';
import { JournalError, type Snapshot } from '../JournalTypes.js';
import { DEFAULT_MAX_DECOMPRESSED_BYTES, encodeBody, decodeBody } from '../object-storage/BodyCodec.js';
import {
  activeEncryptKey,
  isVersionedKeyShape,
  resolveDecryptSubkey,
} from '../object-storage/Encryption.js';
import type {
  CompressionConfig,
  CompressionResolver,
  EncryptionConfig,
  EncryptionResolver,
  IntegrityConfig,
  IntegrityResolver,
} from '../object-storage/PluginConfig.js';
import { resolveCompression, resolveEncryption, resolveIntegrity } from '../object-storage/PluginConfig.js';
import type { ObjectStorageBackend } from '../object-storage/ObjectStorageBackend.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import type { StorageLocality } from '../StorageLocality.js';
import type { Serializer } from '../../serialization/Serializer.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import { none, some, type Option } from '../../util/Option.js';
import { ObjectStorageSnapshotStoreOptionsValidator } from './ObjectStorageSnapshotStoreOptions.js';
import type { ObjectStorageSnapshotStoreOptions, ObjectStorageSnapshotStoreOptionsType } from './ObjectStorageSnapshotStoreOptions.js';


const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * SnapshotStore backed by any `ObjectStorageBackend`.  Each snapshot
 * lands at `<prefix><persistenceId>/<seq.padStart(20,'0')>.json`.  The
 * padding is what lets `loadLatest` work off ordering alone: zero-padded
 * sequence numbers sort as strings exactly as they sort as numbers, so a
 * full LIST of that one entity's directory — ascending, per the backend
 * contract — puts the newest snapshot last, and nothing has to be parsed
 * to find it.
 *
 * That LIST carries no `limit`, deliberately.  `limit: 1` would return the
 * **oldest** snapshot, since the contract sorts ascending; and a limit is
 * not what bounds the cost here — the per-`persistenceId` directory in the
 * key is.  A backend whose LIST is proportional to the whole store rather
 * than to the prefix makes this O(N) in the entity count no matter what
 * limit the caller passes (#746).
 *
 * `keepN`-based pruning runs after every successful save; older
 * snapshots are deleted in a best-effort post-pass.  A failed prune
 * does not fail the save — the next save retries.
 */
export class ObjectStorageSnapshotStore implements SnapshotStore {
  private readonly backend: ObjectStorageBackend;
  private readonly ownsBackend: boolean;
  private readonly prefix: string;
  private readonly keepN: number;
  private readonly compression: CompressionConfig | CompressionResolver | undefined;
  private readonly encryption: EncryptionConfig | EncryptionResolver | undefined;
  private readonly integrity: IntegrityConfig | IntegrityResolver | undefined;
  private readonly allowUntaggedBodies: boolean;
  private readonly requireContextBinding: boolean;
  private readonly maxDecompressedBytes: number;

  private readonly serializer?: Serializer;

  /** Locality is the backend's property — a store wrapper adds none of its own (#1356). */
  get storageLocality(): StorageLocality | undefined { return this.backend.storageLocality; }

  /** Identity is the backend's too — bucket/directory = database (#1358). */
  async storageIdentity(): Promise<string> {
    if (this.backend.storageIdentity === undefined) {
      throw new JournalError('ObjectStorageSnapshotStore.storageIdentity: the backend declares none');
    }
    return this.backend.storageIdentity();
  }

  constructor(options: ObjectStorageSnapshotStoreOptions) {
    const resolvedOptions = (options as ObjectStorageSnapshotStoreOptionsType);
    if (resolvedOptions.backend === undefined) throw new Error('ObjectStorageSnapshotStore: backend is required (call withBackend()).');
    new ObjectStorageSnapshotStoreOptionsValidator().validate(resolvedOptions);
    this.backend = resolvedOptions.backend;
    this.ownsBackend = resolvedOptions.ownsBackend ?? true;
    this.prefix = resolvedOptions.prefix ?? '';
    this.keepN = resolvedOptions.keepN ?? 3;
    this.compression = resolvedOptions.compression;
    this.encryption = resolvedOptions.encryption;
    this.integrity = resolvedOptions.integrity;
    this.allowUntaggedBodies = resolvedOptions.allowUntaggedBodies ?? false;
    this.requireContextBinding = resolvedOptions.requireContextBinding ?? false;
    this.maxDecompressedBytes = resolvedOptions.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
    this.serializer = resolvedOptions.serializer;
  }

  async save<S>(
    persistenceId: string,
    seq: number,
    state: S,
    options?: PersistenceOptions,
  ): Promise<Snapshot<S>> {
    if (!Number.isFinite(seq) || seq < 0) {
      throw new JournalError(`SnapshotStore.save: invalid sequence ${seq}`);
    }
    // Per-call options (from the actor) take precedence over the
    // plugin-level resolver / default.  An actor that sets nothing falls
    // through to the plugin config; an actor that sets compression but
    // not encryption only overrides compression.
    const compression = options?.compression
      ?? resolveCompression(this.compression, persistenceId, { algorithm: 'gzip' });
    const encryption = options?.encryption
      ?? resolveEncryption(this.encryption, persistenceId, { mode: 'none' });
    const integrity = options?.integrity
      ?? resolveIntegrity(this.integrity, persistenceId, { mode: 'none' });

    const now = Date.now();
    const key = this.snapshotKey(persistenceId, seq);
    const json = encodePayload({ persistenceId: persistenceId, sequenceNr: seq, state, timestamp: now }, this.serializer);
    let body: Uint8Array;
    try {
      const active = await activeEncryptKey(encryption, persistenceId);
      // Only stamp a key version on the wire when the user opted into
      // the keyring shape; the legacy single-key path stays backwards-
      // compatible with bodies written before #8 landed.
      const stampVersion = active && isVersionedKeyShape(encryption);
      body = await encodeBody(utf8.encode(json), {
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
        // The key carries both the persistenceId and the sequence
        // number, so binding it stops an authentic snapshot from being
        // replayed at another pid's key or at another sequence (#612).
        context: key,
      });
    } catch (e) {
      throw new JournalError(`ObjectStorageSnapshotStore.save: encode failed for ${persistenceId}@${seq}: ${(e as Error).message}`, e);
    }

    try {
      await this.backend.put(key, body, {
        contentType: 'application/json',
        contentEncoding: compression.algorithm === 'none' ? undefined : compression.algorithm,
        sse: encryption.mode === 'sse-s3' ? 'AES256'
           : encryption.mode === 'sse-kms' ? { kmsKeyId: encryption.kmsKeyId }
           : undefined,
      });
    } catch (e) {
      throw new JournalError(`ObjectStorageSnapshotStore.save: backend put failed for ${persistenceId}@${seq}: ${(e as Error).message}`, e);
    }

    // Best-effort prune.  Failures here MUST NOT fail the save.
    if (this.keepN > 0) {
      try { await this.pruneToKeepN(persistenceId); } catch { /* swallow */ }
    }

    return { persistenceId: persistenceId, sequenceNr: seq, state, timestamp: now };
  }

  async loadLatest<S>(persistenceId: string, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const items = await this.backend.list({ prefix: this.persistenceIdPrefix(persistenceId) });
    if (items.length === 0) return none;
    // Keys are sorted ascending; we want the highest seq.
    const latest = items[items.length - 1]!;
    return this.fetchSnapshot<S>(persistenceId, latest.key, options);
  }

  async loadBefore<S>(persistenceId: string, seq: number, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const items = await this.backend.list({ prefix: this.persistenceIdPrefix(persistenceId) });
    // Find the highest seq strictly less than the requested one.
    let chosen: string | null = null;
    for (const it of items) {
      const entrySeq = parseSeqFromKey(it.key);
      if (entrySeq !== null && entrySeq < seq) chosen = it.key;
      else if (entrySeq !== null && entrySeq >= seq) break;
    }
    if (!chosen) return none;
    return this.fetchSnapshot<S>(persistenceId, chosen, options);
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    const items = await this.backend.list({ prefix: this.persistenceIdPrefix(persistenceId) });
    for (const it of items) {
      const entrySeq = parseSeqFromKey(it.key);
      if (entrySeq !== null && entrySeq <= toSeq) await this.backend.delete(it.key);
    }
  }

  async close(): Promise<void> {
    // Only close a backend we own.  When it's shared (e.g. registerObjectStoragePlugins
    // hands the same backend to the snapshot + durable-state stores) the owner closes it.
    if (this.ownsBackend) await this.backend.close?.();
  }

  /* ----------------------------- internals ------------------------------ */

  private snapshotKey(persistenceId: string, seq: number): string {
    return `${this.persistenceIdPrefix(persistenceId)}${String(seq).padStart(SEQ_PADDING, '0')}.json`;
  }

  private persistenceIdPrefix(persistenceId: string): string {
    return `${this.prefix}${persistenceId}/`;
  }

  private async fetchSnapshot<S>(
    persistenceId: string,
    key: string,
    options?: PersistenceOptions,
  ): Promise<Option<Snapshot<S>>> {
    const fetched = await this.backend.get(key);
    if (fetched.isNone()) return none;
    // Per-call encryption (from the actor) wins over plugin defaults — same
    // precedence order as the write path.
    const encryption = options?.encryption
      ?? resolveEncryption(this.encryption, persistenceId, { mode: 'none' });
    const integrity = options?.integrity
      ?? resolveIntegrity(this.integrity, persistenceId, { mode: 'none' });
    const subKeyFor = resolveDecryptSubkey(encryption, persistenceId);
    // Handing `decodeBody` the key is what demands a tag — an untagged
    // body is refused unless the operator opened the migration window
    // (#579).  Recovery folds events on top of whatever comes back from
    // here, so an unverified snapshot is an unverified starting state.
    let decoded: import('../object-storage/BodyCodec.js').DecodedBody;
    try {
      decoded = await decodeBody(fetched.value.body, {
        ...(subKeyFor ? { encryption: { subKeyFor } } : {}),
        ...(integrity.mode === 'hmac-sha256'
          ? {
              integrity: {
                integrityKey: integrity.integrityKey,
                allowUntaggedBodies: this.allowUntaggedBodies,
              },
            }
          : {}),
        context: key,
        // Only demand the binding where something authenticates it —
        // see the same guard on the durable-state store (#612).
        ...(this.requireContextBinding
          && (encryption.mode === 'client-aes256-gcm' || integrity.mode === 'hmac-sha256')
          ? { requireContextBinding: true }
          : {}),
        maxOutputBytes: this.maxDecompressedBytes,
      });
    } catch (e) {
      // The codec's own wording goes in the message, not only in the
      // cause: it is the part that names WHICH key or tag was missing,
      // and a wrapper that swallows it turns a diagnosable failure into
      // an unexplained "decode failed".
      throw new JournalError(
        `ObjectStorageSnapshotStore: integrity / decode failure at key ${key}: ${(e as Error).message}`,
        e,
      );
    }
    const json = utf8Decoder.decode(decoded.payload);
    let parsed: { persistenceId: string; sequenceNr: number; state: S; timestamp: number };
    try { parsed = decodePayload(json, this.serializer) as { persistenceId: string; sequenceNr: number; state: S; timestamp: number }; }
    catch (e) {
      throw new JournalError(`ObjectStorageSnapshotStore: malformed JSON at key ${key}`, e);
    }
    return some({
      persistenceId: parsed.persistenceId,
      sequenceNr: parsed.sequenceNr,
      state: parsed.state,
      timestamp: parsed.timestamp,
    });
  }

  private async pruneToKeepN(persistenceId: string): Promise<void> {
    const items = await this.backend.list({ prefix: this.persistenceIdPrefix(persistenceId) });
    if (items.length <= this.keepN) return;
    const toDelete = items.slice(0, items.length - this.keepN);
    for (const it of toDelete) await this.backend.delete(it.key);
  }
}

function parseSeqFromKey(key: string): number | null {
  // Expected suffix: '<seq.padStart(20,'0')>.json'
  const match = /(\d{1,20})\.json$/.exec(key);
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isFinite(seq) ? seq : null;
}
