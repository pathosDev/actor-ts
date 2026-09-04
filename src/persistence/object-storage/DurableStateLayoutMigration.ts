/**
 * Operator tool for the #716 durable-state key-layout change.
 *
 * #716 gave the two object-storage stores disjoint namespaces under the
 * prefix they share, which moved every durable-state record from
 * `<prefix><persistenceId>/state.json` to
 * `<prefix>state/<persistenceId>/state.json`.  Snapshots need no migration —
 * a load that finds nothing replays the journal — but durable state *is* the
 * source of truth, so the records have to arrive at the new keys before the
 * new version reads them.
 *
 * **Why this is a tool and not a paragraph.**  The obvious recipe — run the
 * old version with the store's `prefix` set to `<prefix>state/` and re-`upsert`
 * every record — cannot be carried out:
 *
 *   - a store pointed at the destination cannot read the source, so the recipe
 *     needs two store instances and never says so;
 *   - `upsert(id, record.revision, state)` throws.  The destination is empty,
 *     so the store's compare-and-swap refresh finds no entry and raises
 *     `DurableStateConcurrencyError(expected = revision, actual = 0)`;
 *   - `upsert(id, 0, state)` is the only form that lands, and it writes
 *     revision 1.  A record at revision 7 arrives at the new key having
 *     forgotten six revisions, and every CAS the application performs
 *     afterwards is against the wrong number.  That is a quieter kind of data
 *     loss than a failed upgrade, not a smaller one.
 *
 * This moves the **body** instead of replaying the record through the store,
 * so `revision` and `timestamp` are the bytes that were already there rather
 * than numbers the store re-derives.  Two paths, chosen per object off the
 * frame:
 *
 *   - a body that is **not** bound to its storage key is copied verbatim —
 *     the same bytes at the new key, no keys needed and nothing re-derived;
 *   - a body that **is** bound (#612) is decoded against its old key and
 *     re-sealed against its new one, because the storage key is inside what
 *     AES-GCM and the HMAC authenticate.  Copying those bytes produces an
 *     object that fails to decode at its destination, which is why the two
 *     paths cannot be collapsed into one.
 *
 * It never writes over an object that is already at the destination, and it
 * leaves the source in place unless {@link
 * DurableStateLayoutMigrationOptions.deleteSource} says otherwise — so a run
 * is repeatable, and a corpus is recoverable while the operator verifies the
 * upgrade.
 *
 * Run it with the application **stopped**: a live writer at the old keys
 * writes records this pass has already moved, and the pass has no way to
 * notice.
 *
 * Options are a plain type rather than the project's `XOptions` builder trio,
 * matching `ReEncryptOptions` beside it: both are one-shot operator entry
 * points with no HOCON leaves behind them, and the trio's naming lockstep
 * exists to keep a builder, a field and a config key in step.
 *
 *   import { migrateObjectStorageDurableStateLayout } from 'actor-ts';
 *
 *   const result = await migrateObjectStorageDurableStateLayout(backend, {
 *     prefix: 'acme/',
 *     // Only needed for a corpus whose bodies are sealed — pass the very
 *     // configuration the durable-state store was given.
 *     encryption: { mode: 'client-aes256-gcm', masterKeys, info: 'acme/prod/durable-state/v1' },
 *     integrity: { mode: 'hmac-sha256', integrityKey },
 *     onProgress: (event) => process.stderr.write(`${event.index}/${event.total} ${event.action} ${event.sourceKey}\n`),
 *   });
 *   console.log(`migrated ${result.migrated} of ${result.scanned}`);
 */

import {
  OBJECT_STORAGE_DURABLE_STATE_LEAF,
  OBJECT_STORAGE_DURABLE_STATE_NAMESPACE,
} from '../Constants.js';
import type { EncryptionConfig, IntegrityConfig } from '../PersistenceOptions.js';
import {
  ATS1_MAGIC,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  FLAG_CONTEXT_BOUND,
  FLAG_ENCRYPTED,
  FLAG_INTEGRITY_HMAC,
  decodeBody,
  encodeBody,
  type DecodeOptions,
} from './BodyCodec.js';
import { activeEncryptKey, isVersionedKeyShape, resolveDecryptSubkey } from './Encryption.js';
import type { ObjectStorageBackend } from './ObjectStorageBackend.js';
import {
  resolveEncryption,
  resolveIntegrity,
  type EncryptionResolver,
  type IntegrityResolver,
} from './PluginConfig.js';

export type DurableStateLayoutMigrationOptions = {
  /**
   * The prefix the two object-storage stores share — the `prefix` the
   * durable-state store was configured with, unchanged.  Both the old keys
   * and the new ones live under it, so the migration never needs a second
   * prefix and an operator never has to invent one.
   */
  readonly prefix: string;
  /**
   * The durable-state store's own `encryption` configuration, flat or the
   * per-`persistenceId` resolver.  Required only for a corpus whose bodies
   * are encrypted: the sealed path decrypts under the version each body
   * carries and re-encrypts under the ring's *active* key, so a migration of
   * an encrypted corpus is also a rotation onto the active version.
   */
  readonly encryption?: EncryptionConfig | EncryptionResolver;
  /**
   * The durable-state store's own `integrity` configuration.  Required only
   * for a corpus whose bodies carry the HMAC tag: the tag covers the storage
   * key, so it is verified against the old key and recomputed against the new
   * one.
   */
  readonly integrity?: IntegrityConfig | IntegrityResolver;
  /**
   * Re-admit untagged bodies while {@link integrity} is set — the same
   * migration window the stores spell out, for a corpus that still holds
   * bodies written before integrity was turned on.  Default `false`.
   */
  readonly allowUntaggedBodies?: boolean;
  /**
   * Delete each source object once its destination is written.  Default
   * `false`: the old corpus is what an operator rolls back to, and deleting
   * it is a decision that belongs after the upgrade has been verified, not
   * during it.  A second run with the flag set deletes the sources the first
   * run left behind.
   */
  readonly deleteSource?: boolean;
  /**
   * Cap on a decompressed body, mirroring the stores' option of the same
   * name.  Only reached on the sealed path, which is the only one that
   * decodes anything.
   */
  readonly maxDecompressedBytes?: number;
  /** Per-object hook for logging a long-running pass. */
  readonly onProgress?: (event: DurableStateLayoutMigrationProgress) => void;
};

export type DurableStateLayoutMigrationProgress = {
  readonly sourceKey: string;
  /** The destination — absent for a key the pass did not move. */
  readonly targetKey?: string;
  readonly index: number;
  readonly total: number;
  readonly action: 'copied' | 'resealed' | 'skipped-already-migrated' | 'skipped-not-a-legacy-record';
};

export type DurableStateLayoutMigrationResult = {
  /** Every key listed under the prefix, whatever became of it. */
  readonly scanned: number;
  /** Old-layout records now present at their new key — copied plus re-sealed. */
  readonly migrated: number;
  /**
   * Old-layout records whose destination already held an object, so this pass
   * left both alone.  A second run over a corpus the first run moved reports
   * every record here and `migrated: 0` — that is what makes the pass
   * repeatable after an interruption.
   */
  readonly skippedAlreadyMigrated: number;
  /**
   * Keys that are not an old-layout durable-state record: the snapshot
   * corpus, records already in the new layout, and anything else sharing the
   * prefix.  Counted rather than silently dropped, because "the pass scanned
   * a thousand keys and migrated none" is the answer to a misconfigured
   * `prefix`.
   */
  readonly skippedNotALegacyRecord: number;
};

/**
 * Thrown when a body is sealed against its storage key but the pass was given
 * no key to open it with.
 *
 * Reported as its own error rather than left to `decodeBody`, because the
 * remedy is a *migration* argument and the codec can only describe a body: an
 * operator reading "no subkey resolver" mid-corpus has to work back to the
 * fact that the durable-state store's `encryption` config belongs in this
 * call.
 */
export class DurableStateLayoutMigrationKeyError extends Error {
  constructor(public readonly sourceKey: string) {
    super(
      `migrateObjectStorageDurableStateLayout: ${JSON.stringify(sourceKey)} is sealed against `
      + `its storage key (#612), so its bytes cannot simply be moved — the key is inside what `
      + `AES-GCM and the HMAC authenticate.  Re-sealing it needs the durable-state store's own `
      + `configuration: pass its 'encryption' and/or 'integrity' (the flat config, or the very `
      + `per-persistenceId resolver the store was given) to this call.`,
    );
    this.name = 'DurableStateLayoutMigrationKeyError';
  }
}

/**
 * Move every pre-#716 durable-state record under `prefix` to the layout this
 * version reads, preserving each record's `revision` and `timestamp`.
 *
 * Per-object failures are not swallowed — they stop the pass, and the pass is
 * safe to re-run once the cause is fixed, because everything already moved is
 * skipped rather than rewritten.
 */
export async function migrateObjectStorageDurableStateLayout(
  backend: ObjectStorageBackend,
  options: DurableStateLayoutMigrationOptions,
): Promise<DurableStateLayoutMigrationResult> {
  const listed = await backend.list({ prefix: options.prefix });
  // Sorted so a pass is deterministic across backends — the filesystem
  // backend lists in disk order, S3 alphabetically.
  const items = [...listed].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const maxOutputBytes = options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;

  let migrated = 0;
  let skippedAlreadyMigrated = 0;
  let skippedNotALegacyRecord = 0;

  const total = items.length;
  for (let index = 0; index < total; index++) {
    const sourceKey = items[index]!.key;
    const persistenceId = legacyPersistenceIdOf(sourceKey, options.prefix);
    if (persistenceId === undefined) {
      skippedNotALegacyRecord += 1;
      options.onProgress?.({ sourceKey, index, total, action: 'skipped-not-a-legacy-record' });
      continue;
    }

    const targetKey = `${options.prefix}${OBJECT_STORAGE_DURABLE_STATE_NAMESPACE}`
      + `${persistenceId}/${OBJECT_STORAGE_DURABLE_STATE_LEAF}`;
    if ((await backend.get(targetKey)).isSome()) {
      skippedAlreadyMigrated += 1;
      options.onProgress?.({ sourceKey, targetKey, index, total, action: 'skipped-already-migrated' });
    } else {
      const fetched = await backend.get(sourceKey);
      // List/get race — the object went away under us.  Nothing to move, and
      // nothing was left behind either.
      if (fetched.isNone()) continue;
      const source = fetched.value;
      const putOptions = {
        ...(source.contentType !== undefined ? { contentType: source.contentType } : {}),
        ...(source.contentEncoding !== undefined ? { contentEncoding: source.contentEncoding } : {}),
        // Never clobber a destination.  The existence check above is the
        // ordinary path; this closes the window between it and the write.
        ifNoneMatch: '*' as const,
      };

      if (isSealedAgainstItsKey(source.body)) {
        const resealed = await reseal(source.body, {
          persistenceId, sourceKey, targetKey, maxOutputBytes, options,
        });
        await backend.put(targetKey, resealed, putOptions);
        options.onProgress?.({ sourceKey, targetKey, index, total, action: 'resealed' });
      } else {
        // The whole body moves untouched, which is the strongest guarantee
        // available: revision, timestamp, compression, key version and tag
        // are the bytes that were already there.
        await backend.put(targetKey, source.body, putOptions);
        options.onProgress?.({ sourceKey, targetKey, index, total, action: 'copied' });
      }
      migrated += 1;
    }

    // One rule for both branches: a source is redundant exactly when its
    // destination is present, and it does not matter whether this pass put it
    // there or an earlier one did.  Which is what lets the cleanup be a
    // second run — move first, verify the upgrade, then re-run with the flag
    // — rather than a decision the operator has to make up front, before
    // there is anything to verify.
    if (options.deleteSource === true) await backend.delete(sourceKey);
  }

  return { scanned: total, migrated, skippedAlreadyMigrated, skippedNotALegacyRecord };
}

/* ----------------------------- internals ------------------------------ */

/**
 * The `persistenceId` a key carries if it is a pre-#716 durable-state record,
 * else `undefined`.
 *
 * Shape rather than namespace exclusion, and the difference is not cosmetic.
 * `state` is a legal `persistenceId`, so its old key is
 * `<prefix>state/state.json` — which sits *inside* the directory the new
 * layout owns.  A filter that skipped everything under `state/` would strand
 * exactly that entity and report a clean run.  Counting segments separates
 * them without a special case: an old record is `<pid>/state.json`, a new one
 * is `state/<pid>/state.json`, and no key is both.
 */
function legacyPersistenceIdOf(key: string, prefix: string): string | undefined {
  if (!key.startsWith(prefix)) return undefined;
  const segments = key.slice(prefix.length).split('/');
  if (segments.length !== 2) return undefined;
  if (segments[1] !== OBJECT_STORAGE_DURABLE_STATE_LEAF) return undefined;
  const persistenceId = segments[0]!;
  return persistenceId.length > 0 ? persistenceId : undefined;
}

/**
 * Whether the body announces that its storage key was authenticated with it
 * (#612) — the one bit that decides between moving bytes and re-sealing them.
 *
 * Read straight off the frame rather than inferred from the migration's own
 * options, for the same reason the re-encryption sweep reads it there: a
 * corpus written across an upgrade holds both, and the options describe the
 * configuration, not any particular object.  A body this framework did not
 * write carries no frame to read and is moved untouched.
 */
function isSealedAgainstItsKey(body: Uint8Array): boolean {
  if (body.length < 5) return false;
  for (let index = 0; index < ATS1_MAGIC.length; index++) {
    if (body[index] !== ATS1_MAGIC[index]) return false;
  }
  return (body[4]! & FLAG_CONTEXT_BOUND) !== 0;
}

type ResealContext = {
  readonly persistenceId: string;
  readonly sourceKey: string;
  readonly targetKey: string;
  readonly maxOutputBytes: number;
  readonly options: DurableStateLayoutMigrationOptions;
};

/**
 * Decode a sealed body against the key it lived at and re-seal it against the
 * key it is moving to, leaving the payload — and therefore the revision and
 * the timestamp — exactly as it was.
 *
 * Which authenticators are re-applied is read off the *body*, not off the
 * options: an operator who supplies an integrity key so a half-migrated
 * corpus can be read has not asked for every untagged body in it to be
 * promoted, and an unencrypted body must not come out encrypted or the store
 * that has no encryption configured can no longer read it.  Same rule the
 * re-encryption sweep applies, for the same reason.
 */
async function reseal(body: Uint8Array, context: ResealContext): Promise<Uint8Array> {
  const { persistenceId, sourceKey, targetKey, maxOutputBytes, options } = context;
  const encryption = resolveEncryption(options.encryption, persistenceId, { mode: 'none' });
  const integrity = resolveIntegrity(options.integrity, persistenceId, { mode: 'none' });
  const subKeyFor = resolveDecryptSubkey(encryption, persistenceId);
  const integrityKey = integrity.mode === 'hmac-sha256' ? integrity.integrityKey : undefined;
  if (subKeyFor === undefined && integrityKey === undefined) {
    throw new DurableStateLayoutMigrationKeyError(sourceKey);
  }

  const flags = body[4]!;
  const wasEncrypted = (flags & FLAG_ENCRYPTED) !== 0;
  const wasTagged = (flags & FLAG_INTEGRITY_HMAC) !== 0;

  const decodeOptions: DecodeOptions = {
    ...(subKeyFor !== undefined ? { encryption: { subKeyFor } } : {}),
    ...(integrityKey !== undefined
      ? { integrity: { integrityKey, allowUntaggedBodies: options.allowUntaggedBodies === true } }
      : {}),
    context: sourceKey,
    maxOutputBytes,
  };
  const decoded = await decodeBody(body, decodeOptions);

  // The ring's active key, not the version the body happened to be at: a body
  // still on a retired version has to be re-encrypted anyway to change its
  // binding, and writing it back under a retired key would leave the corpus
  // needing a rotation sweep it does not otherwise need.
  const active = wasEncrypted ? await activeEncryptKey(encryption, persistenceId) : undefined;
  return encodeBody(decoded.payload, {
    // The level is not on the wire, so a re-sealed body is recompressed at the
    // algorithm's default.  The algorithm is what a reader dispatches on.
    compression: decoded.compression,
    ...(active !== undefined
      ? {
          encryption: {
            subKey: active.subKey,
            ...(isVersionedKeyShape(encryption) ? { keyVersion: active.keyVersion } : {}),
          },
        }
      : {}),
    ...(wasTagged && integrityKey !== undefined ? { integrity: { integrityKey } } : {}),
    context: targetKey,
  });
}
