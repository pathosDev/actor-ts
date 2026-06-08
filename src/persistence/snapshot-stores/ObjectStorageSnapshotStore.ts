import { JournalError, type Snapshot } from '../JournalTypes.js';
import { encodeBody, decodeBody } from '../object-storage/BodyCodec.js';
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
} from '../object-storage/PluginConfig.js';
import { resolveCompression, resolveEncryption } from '../object-storage/PluginConfig.js';
import type { ObjectStorageBackend } from '../object-storage/ObjectStorageBackend.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { none, some, type Option } from '../../util/Option.js';

/** Sequence-number padding — matches `Number.MAX_SAFE_INTEGER`'s 16 digits with headroom. */
const SEQ_PADDING = 20;

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

export interface ObjectStorageSnapshotStoreOptions {
  /** The underlying storage layer (S3 / Filesystem / …). */
  readonly backend: ObjectStorageBackend;
  /** Prepended to every key before the persistenceId.  Default: ''. */
  readonly prefix?: string;
  /** Keep this many snapshots per persistenceId; older ones are deleted on save.  Default: 3. */
  readonly keepN?: number;
  /** Compression — flat config or per-pid resolver.  Default: `{ algorithm: 'gzip' }`. */
  readonly compression?: CompressionConfig | CompressionResolver;
  /** Encryption — flat config or per-pid resolver.  Default: `{ mode: 'none' }`. */
  readonly encryption?: EncryptionConfig | EncryptionResolver;
}

/**
 * SnapshotStore backed by any `ObjectStorageBackend`.  Each snapshot
 * lands at `<prefix><pid>/<seq.padStart(20,'0')>.json` — the padding
 * scheme is what makes `loadLatest` cheap (single LIST with `limit:1`
 * and reverse iteration over the sorted result).
 *
 * `keepN`-based pruning runs after every successful save; older
 * snapshots are deleted in a best-effort post-pass.  A failed prune
 * does not fail the save — the next save retries.
 */
export class ObjectStorageSnapshotStore implements SnapshotStore {
  private readonly backend: ObjectStorageBackend;
  private readonly prefix: string;
  private readonly keepN: number;
  private readonly compression: CompressionConfig | CompressionResolver | undefined;
  private readonly encryption: EncryptionConfig | EncryptionResolver | undefined;

  constructor(opts: ObjectStorageSnapshotStoreOptions) {
    this.backend = opts.backend;
    this.prefix = opts.prefix ?? '';
    this.keepN = opts.keepN ?? 3;
    this.compression = opts.compression;
    this.encryption = opts.encryption;
  }

  async save<S>(
    pid: string,
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
      ?? resolveCompression(this.compression, pid, { algorithm: 'gzip' });
    const encryption = options?.encryption
      ?? resolveEncryption(this.encryption, pid, { mode: 'none' });

    const now = Date.now();
    const json = JSON.stringify({ persistenceId: pid, sequenceNr: seq, state, timestamp: now });
    let body: Uint8Array;
    try {
      const active = await activeEncryptKey(encryption, pid);
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
      });
    } catch (e) {
      throw new JournalError(`ObjectStorageSnapshotStore.save: encode failed for ${pid}@${seq}: ${(e as Error).message}`, e);
    }

    const key = this.snapshotKey(pid, seq);
    try {
      await this.backend.put(key, body, {
        contentType: 'application/json',
        contentEncoding: compression.algorithm === 'none' ? undefined : compression.algorithm,
        sse: encryption.mode === 'sse-s3' ? 'AES256'
           : encryption.mode === 'sse-kms' ? { kmsKeyId: encryption.kmsKeyId }
           : undefined,
      });
    } catch (e) {
      throw new JournalError(`ObjectStorageSnapshotStore.save: backend put failed for ${pid}@${seq}: ${(e as Error).message}`, e);
    }

    // Best-effort prune.  Failures here MUST NOT fail the save.
    if (this.keepN > 0) {
      try { await this.pruneToKeepN(pid); } catch { /* swallow */ }
    }

    return { persistenceId: pid, sequenceNr: seq, state, timestamp: now };
  }

  async loadLatest<S>(pid: string, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const items = await this.backend.list({ prefix: this.pidPrefix(pid) });
    if (items.length === 0) return none;
    // Keys are sorted ascending; we want the highest seq.
    const latest = items[items.length - 1]!;
    return this.fetchSnapshot<S>(pid, latest.key, options);
  }

  async loadBefore<S>(pid: string, seq: number, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    const items = await this.backend.list({ prefix: this.pidPrefix(pid) });
    // Find the highest seq strictly less than the requested one.
    let chosen: string | null = null;
    for (const it of items) {
      const s = parseSeqFromKey(it.key);
      if (s !== null && s < seq) chosen = it.key;
      else if (s !== null && s >= seq) break;
    }
    if (!chosen) return none;
    return this.fetchSnapshot<S>(pid, chosen, options);
  }

  async delete(pid: string, toSeq: number): Promise<void> {
    const items = await this.backend.list({ prefix: this.pidPrefix(pid) });
    for (const it of items) {
      const s = parseSeqFromKey(it.key);
      if (s !== null && s <= toSeq) await this.backend.delete(it.key);
    }
  }

  async close(): Promise<void> {
    await this.backend.close?.();
  }

  /* ----------------------------- internals ------------------------------ */

  private snapshotKey(pid: string, seq: number): string {
    return `${this.pidPrefix(pid)}${String(seq).padStart(SEQ_PADDING, '0')}.json`;
  }

  private pidPrefix(pid: string): string {
    return `${this.prefix}${pid}/`;
  }

  private async fetchSnapshot<S>(
    pid: string,
    key: string,
    options?: PersistenceOptions,
  ): Promise<Option<Snapshot<S>>> {
    const fetched = await this.backend.get(key);
    if (fetched.isNone()) return none;
    // Per-call encryption (from the actor) wins over plugin defaults — same
    // precedence order as the write path.
    const encryption = options?.encryption
      ?? resolveEncryption(this.encryption, pid, { mode: 'none' });
    const subKeyFor = resolveDecryptSubkey(encryption, pid);
    const decoded = await decodeBody(
      fetched.value.body,
      subKeyFor ? { encryption: { subKeyFor } } : undefined,
    );
    const json = utf8Decoder.decode(decoded.payload);
    let parsed: { persistenceId: string; sequenceNr: number; state: S; timestamp: number };
    try { parsed = JSON.parse(json); }
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

  private async pruneToKeepN(pid: string): Promise<void> {
    const items = await this.backend.list({ prefix: this.pidPrefix(pid) });
    if (items.length <= this.keepN) return;
    const toDelete = items.slice(0, items.length - this.keepN);
    for (const it of toDelete) await this.backend.delete(it.key);
  }
}

function parseSeqFromKey(key: string): number | null {
  // Expected suffix: '<seq.padStart(20,'0')>.json'
  const m = /(\d{1,20})\.json$/.exec(key);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
