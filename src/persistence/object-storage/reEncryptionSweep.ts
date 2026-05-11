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
}

export interface ReEncryptProgress {
  readonly key: string;
  readonly idx: number;
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
 *     onProgress: (e) => process.stderr.write(`${e.idx}/${e.total} ${e.key}\n`),
 *   });
 *   console.log(`re-encrypted ${result.rewrote} of ${result.scanned}`);
 */
export async function reEncryptObjectStorage(
  backend: ObjectStorageBackend,
  opts: ReEncryptOptions,
): Promise<ReEncryptResult> {
  const items = await backend.list({ prefix: opts.keyPrefix });
  const pidFromKey = opts.pidFromKey ?? defaultPidFromKey;
  const result = {
    scanned: 0,
    rewrote: 0,
    skippedCurrent: 0,
    skippedUnencrypted: 0,
    skippedNonAts1: 0,
  };
  const activeVersion = opts.keyring.active.version;
  if (!Number.isInteger(activeVersion) || activeVersion < 0 || activeVersion > 255) {
    throw new Error(
      `reEncryptObjectStorage: keyring.active.version must be an integer in [0, 255], got ${activeVersion}`,
    );
  }
  const total = items.length;
  for (let idx = 0; idx < total; idx++) {
    const item = items[idx]!;
    if (opts.skip?.(item.key)) continue;
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
      opts.onProgress?.({ key: item.key, idx, total, action: 'skipped-non-ats1' });
      continue;
    }
    const flags = framed[4]!;
    const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
    if (!encrypted) {
      result.skippedUnencrypted += 1;
      opts.onProgress?.({ key: item.key, idx, total, action: 'skipped-unencrypted' });
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
      opts.onProgress?.({ key: item.key, idx, total, action: 'skipped-current' });
      continue;
    }

    const pid = pidFromKey(item.key, opts.keyPrefix);
    const info = opts.info ?? 'actor-ts/snapshot/v1';

    // Decrypt with whatever retired/active key matches the body's version.
    const decoded = await decodeBody(framed, {
      encryption: {
        subKeyFor: async (v: number): Promise<Uint8Array | null> => {
          if (opts.keyring.active.version === v) {
            return deriveSubkey(opts.keyring.active.key, pid, info);
          }
          const retired = opts.keyring.retired?.find((r) => r.version === v);
          return retired ? deriveSubkey(retired.key, pid, info) : null;
        },
      },
    });

    // Re-encrypt with the active key + active version stamp.
    const activeSubkey = await deriveSubkey(opts.keyring.active.key, pid, info);
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
    opts.onProgress?.({ key: item.key, idx, total, action: 'rewrote' });
  }
  return result;
}

/* ----------------------------- internals --------------------------------- */

function startsWithAts1(buf: Uint8Array): boolean {
  return buf.length >= 5
    && buf[0] === ATS1_MAGIC_PREFIX[0]
    && buf[1] === ATS1_MAGIC_PREFIX[1]
    && buf[2] === ATS1_MAGIC_PREFIX[2]
    && buf[3] === ATS1_MAGIC_PREFIX[3];
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
