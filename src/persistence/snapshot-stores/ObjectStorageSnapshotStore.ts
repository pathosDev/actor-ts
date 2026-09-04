import {
  DEFAULT_OBJECT_STORAGE_COMPRESSION_ALGORITHM,
  DEFAULT_OBJECT_STORAGE_ENCRYPTION_MODE,
  OBJECT_STORAGE_SNAPSHOT_LEAF_SUFFIX,
  OBJECT_STORAGE_SNAPSHOT_NAMESPACE,
  SEQ_PADDING,
} from '../Constants.js';
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
import type { PersistenceOptionSupport } from '../PersistenceCapabilities.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import type { StorageLocality } from '../StorageLocality.js';
import type { Serializer } from '../../serialization/Serializer.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import { none, some, type Option } from '../../util/Option.js';
import { DEFAULT_SNAPSHOT_KEEP_N, ObjectStorageSnapshotStoreOptionsValidator } from './ObjectStorageSnapshotStoreOptions.js';
import type { ObjectStorageSnapshotStoreOptions, ObjectStorageSnapshotStoreOptionsType } from './ObjectStorageSnapshotStoreOptions.js';


const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * SnapshotStore backed by any `ObjectStorageBackend`.  Each snapshot
 * lands at `<prefix>snapshots/<persistenceId>/<seq.padStart(20,'0')>.json`.
 * The padding is what lets `loadLatest` work off ordering alone: zero-padded
 * sequence numbers sort as strings exactly as they sort as numbers, so a
 * full LIST of that one entity's directory — ascending, per the backend
 * contract — puts the newest snapshot last, and only the *shape* of a key
 * has to be checked to know it is one of this store's own.
 *
 * The `snapshots/` segment is a namespace this store owns, and it is what
 * keeps the corpus disjoint from `ObjectStorageDurableStateStore`'s (#716):
 * `registerObjectStoragePlugins` hands both stores the same backend and the
 * same `prefix`, and before the split the same entity persisted both ways
 * put `state.json` in this store's own directory, where it collates after
 * every sequence key and was returned as the newest snapshot.  See
 * {@link OBJECT_STORAGE_SNAPSHOT_NAMESPACE}.
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

  /**
   * The one snapshot store that acts on all three fields, on both paths:
   * `save` resolves them at :107-113 and `loadFrom` at :219-223, per-call
   * options winning over the plugin resolver.  This is what the declaration
   * is measured against — `PerActorCompressionEncryption.test.ts` proves the
   * behaviour and the capability inventory pins the claim (#960).  A
   * declaration is a property of the *store*, not of the backend it writes
   * through: the codec runs here, so a backend that stores bytes verbatim
   * changes nothing about it.
   */
  readonly persistenceOptionSupport: PersistenceOptionSupport = {
    encryption: true,
    compression: true,
    integrity: true,
  };

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
    this.keepN = resolvedOptions.keepN ?? DEFAULT_SNAPSHOT_KEEP_N;
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
      ?? resolveCompression(this.compression, persistenceId, { algorithm: DEFAULT_OBJECT_STORAGE_COMPRESSION_ALGORITHM });
    const encryption = options?.encryption
      ?? resolveEncryption(this.encryption, persistenceId, { mode: DEFAULT_OBJECT_STORAGE_ENCRYPTION_MODE });
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
    const entries = await this.ownSnapshotKeys(persistenceId);
    if (entries.length === 0) return none;
    // Keys are sorted ascending; we want the highest seq — of this store's
    // own keys, not of whatever else the prefix happens to hold.
    const latest = entries[entries.length - 1]!;
    return this.fetchSnapshot<S>(persistenceId, latest.key, options);
  }

  async loadBefore<S>(persistenceId: string, seq: number, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const entries = await this.ownSnapshotKeys(persistenceId);
    // Find the highest seq strictly less than the requested one.
    let chosen: string | null = null;
    for (const entry of entries) {
      if (entry.sequenceNr < seq) chosen = entry.key;
      else break;
    }
    if (!chosen) return none;
    return this.fetchSnapshot<S>(persistenceId, chosen, options);
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    const entries = await this.ownSnapshotKeys(persistenceId);
    for (const entry of entries) {
      if (entry.sequenceNr <= toSeq) await this.backend.delete(entry.key);
    }
  }

  async close(): Promise<void> {
    // Only close a backend we own.  When it's shared (e.g. registerObjectStoragePlugins
    // hands the same backend to the snapshot + durable-state stores) the owner closes it.
    if (this.ownsBackend) await this.backend.close?.();
  }

  /* ----------------------------- internals ------------------------------ */

  private snapshotKey(persistenceId: string, seq: number): string {
    return `${this.persistenceIdPrefix(persistenceId)}`
      + `${String(seq).padStart(SEQ_PADDING, '0')}${OBJECT_STORAGE_SNAPSHOT_LEAF_SUFFIX}`;
  }

  private persistenceIdPrefix(persistenceId: string): string {
    return `${this.prefix}${OBJECT_STORAGE_SNAPSHOT_NAMESPACE}${persistenceId}/`;
  }

  /**
   * The entity's own snapshots, in the backend's ascending key order.
   *
   * Every list-driven path goes through here — load-latest, load-before,
   * delete and prune — because prefix membership is not evidence that a key
   * is one of this store's (#716).  A LIST answers with whatever sits under
   * the prefix, and this store is not the only writer a bucket can have:
   * another tool's marker file, a half-finished migration, a foreign object
   * a co-tenant put there.  What identifies a snapshot is its *shape* — this
   * entity's directory, then exactly one zero-padded sequence leaf — so that
   * is what is checked, and the sequence number the check already parsed is
   * carried out so no caller re-derives it from the key.
   *
   * `delete` and `pruneToKeepN` were only incidentally safe before: they ran
   * the sequence parser over every listed key and it happened to return
   * nothing for a foreign one.  Prune was not safe even so — it counted
   * foreign keys towards `keepN` and then deleted from the front of the
   * listing, so a stranger's object under the prefix cost the entity one of
   * its own retained snapshots per object.
   */
  private async ownSnapshotKeys(persistenceId: string): Promise<ReadonlyArray<SnapshotKeyEntry>> {
    const entityPrefix = this.persistenceIdPrefix(persistenceId);
    const items = await this.backend.list({ prefix: entityPrefix });
    const entries: SnapshotKeyEntry[] = [];
    for (const item of items) {
      const sequenceNr = snapshotSequenceOf(item.key, entityPrefix);
      if (sequenceNr === null) continue;
      entries.push({ key: item.key, sequenceNr });
    }
    return entries;
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
      ?? resolveEncryption(this.encryption, persistenceId, { mode: DEFAULT_OBJECT_STORAGE_ENCRYPTION_MODE });
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
    // The body names the entity it was written for, and until #716 that
    // name was returned verbatim without ever being compared to the one the
    // caller asked about.  A snapshot store is a separate trust domain — a
    // shared bucket, a co-tenant, an insider — so "the object under this
    // entity's key says it belongs to another entity" is a claim the store
    // has to disbelieve rather than pass on to recovery.
    //
    // It answers `none` rather than throwing, deliberately.  Together with
    // the key-shape filter above that is what makes a foreign object
    // *recoverable*: the filter drops it from the listing so the newest
    // well-formed snapshot is chosen instead, and on the one path where a
    // foreign body sits at a well-formed key of this entity's own, `none`
    // means recovery replays the journal from the head.  Throwing would
    // trade a wrong starting state for an actor that cannot start at all —
    // which is exactly the failure the namespace split removes, and there is
    // no reason to reintroduce it here.
    if (parsed.persistenceId !== persistenceId) return none;
    return some({
      persistenceId: parsed.persistenceId,
      sequenceNr: parsed.sequenceNr,
      state: parsed.state,
      timestamp: parsed.timestamp,
    });
  }

  private async pruneToKeepN(persistenceId: string): Promise<void> {
    const entries = await this.ownSnapshotKeys(persistenceId);
    if (entries.length <= this.keepN) return;
    const toDelete = entries.slice(0, entries.length - this.keepN);
    for (const entry of toDelete) await this.backend.delete(entry.key);
  }
}

/** One of this store's own keys, with the sequence number its leaf encodes. */
type SnapshotKeyEntry = {
  readonly key: string;
  readonly sequenceNr: number;
};

/**
 * The sequence number `key` encodes when it is one of this store's own
 * snapshots directly under `entityPrefix`, `null` otherwise.
 *
 * Strict by design, and stricter than the regex it replaced.  That one
 * matched `<anything>(\d{1,20})\.json` anywhere in the key, so it accepted a
 * key nested a level deeper, one written by another tool that happens to end
 * in digits, and a leaf whose digit count is not the padding this store
 * writes.  Here the leaf must be exactly {@link SEQ_PADDING} digits followed
 * by `.json`, with nothing between it and the entity's own directory.
 *
 * A digit scan rather than a `RegExp` built from `SEQ_PADDING`: the padding
 * is a constant, and interpolating it into a pattern puts the one thing the
 * check depends on inside a string where no compiler looks at it.
 */
function snapshotSequenceOf(key: string, entityPrefix: string): number | null {
  if (!key.startsWith(entityPrefix)) return null;
  const leaf = key.slice(entityPrefix.length);
  if (leaf.length !== SEQ_PADDING + OBJECT_STORAGE_SNAPSHOT_LEAF_SUFFIX.length) return null;
  if (!leaf.endsWith(OBJECT_STORAGE_SNAPSHOT_LEAF_SUFFIX)) return null;
  for (let index = 0; index < SEQ_PADDING; index++) {
    const code = leaf.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return null;
  }
  const seq = Number(leaf.slice(0, SEQ_PADDING));
  // A 20-digit field holds numbers `save` can never have written: the
  // padding exists for headroom, not because a sequence number can use it.
  return Number.isSafeInteger(seq) ? seq : null;
}
