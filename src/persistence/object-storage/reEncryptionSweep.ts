/**
 * Operator tool for master-key rotation (#70).
 *
 * Background: client-side encryption stamps a 1-byte key version into the
 * body manifest (#8).  When a deployment rotates the master key, the new
 * key becomes `active`, the old one moves to `retired`, and historical
 * bodies stay readable because the decoder dispatches on the version.
 * That's fine forever — until the operator wants to **drop** the retired
 * key from the config (e.g. to revoke the leaked one, or to clear the
 * way for the next rotation).  That requires every historical body to
 * be re-encrypted under the active key first.
 *
 * `reEncryptObjectStorage` is the sweep: it walks every key under a
 * prefix in the underlying `ObjectStorageBackend`, decrypts each body
 * via the keyring (any retired version still works), and re-encrypts
 * under the active key.  Bodies already at the active version are
 * skipped on the fast path (one GET, no PUT), so the sweep is idempotent
 * — re-running it after a successful run is a no-op.
 *
 * The helper operates one level below `ObjectStorageSnapshotStore` /
 * `ObjectStorageDurableStateStore` because per-pid HKDF salting means
 * the pid must be known at decrypt + re-encrypt time.  The default
 * `pidFromKey` extractor matches the layout both built-in stores use
 * (`<prefix><pid>/...`).
 */

import type { MasterKeyRing } from '../PersistenceOptions.js';
import {
  decodeBody,
  encodeBody,
  FLAG_ENCRYPTED,
  FLAG_KEY_VERSIONED,
} from './BodyCodec.js';
import { deriveSubkey } from './Encryption.js';
import type { ObjectStorageBackend } from './ObjectStorageBackend.js';

const ATS1_MAGIC_PREFIX = new Uint8Array([0x41, 0x54, 0x53, 0x31]); // "ATS1"

/* ============================ progress (#109) ============================ */

/**
 * Durable resume state for {@link reEncryptObjectStorage}.  Without
 * this, a crashed sweep had no choice but to re-list and re-check every
 * key from scratch.  With a progress store, the next run picks up
 * immediately past the last fully-rewritten key (#109).
 *
 * (Named `ReEncryptResumeState` to disambiguate from the existing
 * `ReEncryptProgress` shape used by the per-event `onProgress` hook —
 * that one is event-data, this one is durable state.)
 */
export interface ReEncryptResumeState {
  /** Key of the last object the sweep successfully wrote.  `null` = fresh start. */
  readonly lastKey: string | null;
  /** Cumulative count of objects rewritten across runs of the same sweep. */
  readonly processedCount: number;
}

/**
 * Crash-resume hook for the re-encryption sweep.  Same shape pattern
 * as `MigrationProgressStore` (#87) — `load()` once at start, `save()`
 * every Nth object (configurable via `saveProgressEveryN`), `clear()`
 * after a successful end-to-end run.
 *
 * Implementations write to a small KV store: a JSON file next to the
 * operator runbook, a single Redis key, an object in the same bucket
 * under a sentinel prefix, etc.
 */
export interface ReEncryptProgressStore {
  load(): Promise<ReEncryptResumeState>;
  save(state: ReEncryptResumeState): Promise<void>;
  clear(): Promise<void>;
}

/**
 * In-process default.  Useful for tests and short-lived runs.  For
 * long-running sweeps that must survive a process crash, plug a
 * file-backed or backend-backed implementation in instead.
 */
export class InMemoryReEncryptProgressStore implements ReEncryptProgressStore {
  private state: ReEncryptResumeState = { lastKey: null, processedCount: 0 };
  async load(): Promise<ReEncryptResumeState> { return { ...this.state }; }
  async save(state: ReEncryptResumeState): Promise<void> { this.state = { ...state }; }
  async clear(): Promise<void> { this.state = { lastKey: null, processedCount: 0 }; }
}

export interface ReEncryptOptions {
  /** Common key prefix to sweep (e.g. `'snapshots/'` or `'state/'`). */
  readonly keyPrefix: string;
  /**
   * Keyring containing the currently active key plus every retired
   * version the corpus may have been encrypted under.  Without a
   * retired entry for a version, that body's decrypt will fail.
   */
  readonly keyring: MasterKeyRing;
  /**
   * HKDF `info` string — must match the one the encrypting store used
   * (defaults to `actor-ts/snapshot/v1`, identical to {@link deriveSubkey}'s
   * default).  Override if you customised it at the original encrypt
   * site.
   */
  readonly info?: string;
  /**
   * Extracts the `persistenceId` from a backend key.  HKDF uses the
   * pid as a per-pid salt, so the sweep needs to recover it from the
   * key in order to derive the same subkey the original encrypter did.
   *
   * Default: `<keyPrefix><pid>/<rest>` — picks the next path segment
   * after the prefix.  Works for the layouts both built-in object-
   * storage stores use; override for custom layouts.
   */
  readonly pidFromKey?: (key: string, keyPrefix: string) => string;
  /**
   * Optional progress hook called after each object is processed.  Use
   * it to log to stderr / write a progress file / surface to an
   * operator dashboard for long-running sweeps.
   */
  readonly onProgress?: (event: ReEncryptProgress) => void;
  /**
   * When set, skip objects whose key matches this predicate.  Useful
   * for excluding manifest files or other non-body objects that share
   * the prefix.  Default: process every key.
   */
  readonly skip?: (key: string) => boolean;
  /**
   * Crash-resume hook (#109).  When set, the sweep loads the saved
   * `lastKey` at start and skips every key ≤ it; after each Nth object
   * (see {@link saveProgressEveryN}) the new state is persisted.
   * At successful end the store is cleared so a fresh re-run starts
   * from the beginning.  Without this, a crash mid-sweep means the
   * resumed run has to re-list and re-check every key — fine for
   * small buckets, expensive at million-object scale.
   */
  readonly progress?: ReEncryptProgressStore;
  /**
   * How often to persist progress.  Default: every 50 objects.  Lower
   * values trade extra `progress.save()` writes for shorter potential
   * rewind on crash; higher values reduce overhead at the cost of
   * re-doing more work on resume.
   */
  readonly saveProgressEveryN?: number;
  /**
   * When true (default), perform a pre-sweep completeness check on the
   * keyring: sample the first {@link sampleSize} encrypted objects in
   * the prefix, gather their key versions, and refuse to start if any
   * version is missing from `keyring.active`/`retired`.  Catches the
   * "operator dropped the retired key too soon" footgun BEFORE a single
   * decrypt failure (which would otherwise mid-sweep abort, leaving the
   * corpus half-rewritten).  Set `false` to skip — useful when the
   * operator has independent assurance that the keyring is complete.
   */
  readonly verifyKeyringCompleteness?: boolean;
  /** Sample size for the completeness check.  Default: min(100, total). */
  readonly sampleSize?: number;
}

export interface ReEncryptProgress {
  readonly key: string;
  readonly index: number;
  readonly total: number;
  readonly action: 'rewrote' | 'skipped-current' | 'skipped-unencrypted' | 'skipped-non-ats1';
}

export interface ReEncryptResult {
  /** Total objects examined. */
  readonly scanned: number;
  /** Objects that were re-encrypted to the active key. */
  readonly rewrote: number;
  /**
   * Objects skipped because they were already at the active version
   * (the idempotent fast-path).
   */
  readonly skippedCurrent: number;
  /** Objects skipped because they were never encrypted. */
  readonly skippedUnencrypted: number;
  /** Objects skipped because they aren't `ATS1`-framed (e.g. raw user blobs). */
  readonly skippedNonAts1: number;
}

/**
 * Re-encrypt every body under `keyPrefix` to the active key in `keyring`.
 *
 * Idempotent: a body already at the active version is skipped without a
 * PUT.  Safe to interrupt and resume — there's no progress state on
 * disk; a resumed sweep simply re-checks every key and re-skips the
 * ones already at the active version.
 *
 * Per-object failures (decrypt errors, backend faults) are NOT swallowed
 * — they bubble up immediately and stop the sweep.  Run the sweep again
 * after fixing the underlying issue; already-rewritten objects are
 * idempotent on the next pass.
 *
 *   const result = await reEncryptObjectStorage(backend, {
 *     keyPrefix: 'snapshots/',
 *     keyring: { active: { version: 2, key: newKey },
 *                retired: [{ version: 1, key: oldKey }] },
 *     onProgress: (e) => process.stderr.write(`${e.index}/${e.total} ${e.key}\n`),
 *   });
 *   console.log(`re-encrypted ${result.rewrote} of ${result.scanned}`);
 */
export async function reEncryptObjectStorage(
  backend: ObjectStorageBackend,
  options: ReEncryptOptions,
): Promise<ReEncryptResult> {
  const rawItems = await backend.list({ prefix: options.keyPrefix });
  // Sort lexicographically so that resume by `lastKey` is deterministic
  // across backends (FS-backend lists in disk order, S3 lists alphabetic
  // — sorting normalises).
  const items = [...rawItems].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const persistenceIdFromKey = options.pidFromKey ?? defaultPidFromKey;
  const result = {
    scanned: 0,
    rewrote: 0,
    skippedCurrent: 0,
    skippedUnencrypted: 0,
    skippedNonAts1: 0,
  };
  const activeVersion = options.keyring.active.version;
  if (!Number.isInteger(activeVersion) || activeVersion < 0 || activeVersion > 255) {
    throw new Error(
      `reEncryptObjectStorage: keyring.active.version must be an integer in [0, 255], got ${activeVersion}`,
    );
  }

  // Pre-sweep keyring-completeness check (#109).  Sample some bodies,
  // gather their key versions, fail fast if any version isn't in the
  // keyring.  Better to refuse before touching the corpus than to
  // half-rewrite and then crash on a missing retired key.
  if (options.verifyKeyringCompleteness !== false) {
    const sampleSize = options.sampleSize ?? Math.min(100, items.length);
    const haveVersions = new Set<number>([
      options.keyring.active.version,
      ...(options.keyring.retired?.map((r) => r.version) ?? []),
    ]);
    const missing = new Set<number>();
    for (let i = 0; i < sampleSize; i++) {
      const item = items[i]!;
      if (options.skip?.(item.key)) continue;
      const fetched = await backend.get(item.key);
      if (fetched.isNone()) continue;
      const framed = fetched.value.body;
      if (!startsWithAts1(framed)) continue;
      const flags = framed[4]!;
      const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
      if (!encrypted) continue;
      const versioned = (flags & FLAG_KEY_VERSIONED) !== 0;
      const bodyVersion = versioned ? framed[5]! : 0;
      if (!haveVersions.has(bodyVersion)) missing.add(bodyVersion);
    }
    if (missing.size > 0) {
      throw new Error(
        `reEncryptObjectStorage: keyring is incomplete — bodies in the prefix `
        + `reference master-key version(s) [${[...missing].sort((a, b) => a - b).join(', ')}] `
        + `which are absent from the keyring's 'active' and 'retired' lists.  `
        + `Restore those keys before sweeping, or the sweep will fail mid-corpus.`,
      );
    }
  }

  // Resume from saved progress (#109).
  let resumeStartIndex = 0;
  let processedCountBase = 0;
  if (options.progress) {
    const saved = await options.progress.load();
    if (saved.lastKey !== null) {
      // First index where key > lastKey.  Lower-bound scan since items
      // are sorted.
      while (resumeStartIndex < items.length && items[resumeStartIndex]!.key <= saved.lastKey) {
        resumeStartIndex += 1;
      }
      processedCountBase = saved.processedCount;
    }
  }
  const saveEveryN = options.saveProgressEveryN ?? 50;

  const total = items.length;
  for (let index = resumeStartIndex; index < total; index++) {
    const item = items[index]!;
    if (options.skip?.(item.key)) continue;
    result.scanned += 1;

    const fetched = await backend.get(item.key);
    if (fetched.isNone()) {
      // List/get race — object was deleted under us.  Treat as
      // skipped and move on.
      continue;
    }
    const framed = fetched.value.body;

    if (!startsWithAts1(framed)) {
      result.skippedNonAts1 += 1;
      options.onProgress?.({ key: item.key, index, total, action: 'skipped-non-ats1' });
      continue;
    }
    const flags = framed[4]!;
    const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
    if (!encrypted) {
      result.skippedUnencrypted += 1;
      options.onProgress?.({ key: item.key, index, total, action: 'skipped-unencrypted' });
      continue;
    }
    const versioned = (flags & FLAG_KEY_VERSIONED) !== 0;
    const bodyVersion = versioned ? framed[5]! : 0;
    if (bodyVersion === activeVersion && versioned) {
      // Already at the active version with the new framing — nothing
      // to do.  Bodies in the legacy unversioned format are NOT
      // considered "at version 0" for skip purposes — we still rewrite
      // them so the corpus ends up uniformly versioned.
      result.skippedCurrent += 1;
      options.onProgress?.({ key: item.key, index, total, action: 'skipped-current' });
      continue;
    }

    const persistenceId = persistenceIdFromKey(item.key, options.keyPrefix);
    const info = options.info ?? 'actor-ts/snapshot/v1';

    // Decrypt with whatever retired/active key matches the body's version.
    const decoded = await decodeBody(framed, {
      encryption: {
        subKeyFor: async (v: number): Promise<Uint8Array | null> => {
          if (options.keyring.active.version === v) {
            return deriveSubkey(options.keyring.active.key, persistenceId, info);
          }
          const retired = options.keyring.retired?.find((r) => r.version === v);
          return retired ? deriveSubkey(retired.key, persistenceId, info) : null;
        },
      },
    });

    // Re-encrypt with the active key + active version stamp.
    const activeSubkey = await deriveSubkey(options.keyring.active.key, persistenceId, info);
    const rewritten = await encodeBody(decoded.payload, {
      compression: decoded.compression,
      encryption: { subKey: activeSubkey, keyVersion: activeVersion },
    });

    // Use If-Match to detect a concurrent writer — if someone else
    // updated this key while we were re-encrypting, our rewrite would
    // clobber their newer content.  Bubble the conflict up so the
    // operator can decide (typically: re-run the sweep, the new write
    // will already be at the active version).
    await backend.put(item.key, rewritten, {
      ...(fetched.value.contentType ? { contentType: fetched.value.contentType } : {}),
      ...(fetched.value.contentEncoding ? { contentEncoding: fetched.value.contentEncoding } : {}),
      ifMatch: fetched.value.etag,
    });
    result.rewrote += 1;
    options.onProgress?.({ key: item.key, index, total, action: 'rewrote' });

    // Persist progress every Nth REWRITE (skips don't count — they're
    // cheap to redo).
    if (options.progress && result.rewrote % saveEveryN === 0) {
      await options.progress.save({
        lastKey: item.key,
        processedCount: processedCountBase + result.rewrote,
      });
    }
  }
  // Successful end → clear progress so a fresh re-run starts from the
  // beginning.  If we crashed instead, the saved progress stays on
  // disk and the next call resumes.
  if (options.progress) await options.progress.clear();
  return result;
}

/* ----------------------------- internals --------------------------------- */

function startsWithAts1(buffer: Uint8Array): boolean {
  return buffer.length >= 5
    && buffer[0] === ATS1_MAGIC_PREFIX[0]
    && buffer[1] === ATS1_MAGIC_PREFIX[1]
    && buffer[2] === ATS1_MAGIC_PREFIX[2]
    && buffer[3] === ATS1_MAGIC_PREFIX[3];
}

/**
 * Default pid extractor for the layouts the built-in object-storage
 * stores use: `<keyPrefix><pid>/<rest>`.  Returns the substring
 * between the prefix and the next `/`.  Used as the HKDF salt at
 * decrypt + re-encrypt time, so it MUST match what the original
 * write site used.
 */
function defaultPidFromKey(key: string, keyPrefix: string): string {
  let start = 0;
  if (key.startsWith(keyPrefix)) start = keyPrefix.length;
  const slash = key.indexOf('/', start);
  return slash < 0 ? key.slice(start) : key.slice(start, slash);
}
