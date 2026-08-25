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
 * The same machinery rotates the HKDF `info` context (#108) via
 * `newInfo`.  That axis is invisible on the wire — no manifest byte
 * records it — so the version fast-path cannot be trusted while it is
 * in play; see `ReEncryptOptions.newInfo`.
 *
 * Since #612 the sweep is also the corpus-wide migration to
 * storage-key-bound bodies.  It rewrites a body that lacks the binding
 * even when its key version is already active, and re-binds every body
 * it touches to the key it read it from — which is what lets an
 * operator eventually set `requireContextBinding` on the stores.
 *
 * The integrity HMAC (#116) is the third axis, and until #739 it was the
 * one the sweep could not see.  The tag covers the manifest bytes, so a
 * tagged body cannot be decoded without the integrity key and cannot be
 * written back without recomputing the tag — and `ReEncryptOptions` had
 * no way to supply one.  A sweep over such a corpus aborted on its first
 * tagged object, which made master-key rotation and integrity mutually
 * exclusive: the operator had to give up tamper protection or leave a
 * leaked master key in `retired` forever.  {@link
 * ReEncryptOptions.integrity} closes that — tags are verified on the way
 * in and re-applied on the way out, and the pre-sweep sampler refuses up
 * front when a tagged body has no key to verify it with.
 *
 * The helper operates one level below `ObjectStorageSnapshotStore` /
 * `ObjectStorageDurableStateStore` because per-pid HKDF salting means
 * the pid must be known at decrypt + re-encrypt time.  The default
 * `pidFromKey` extractor matches the layout both built-in stores use
 * (`<prefix><pid>/...`).
 */

import type { IntegrityConfig, MasterKeyRing } from '../PersistenceOptions.js';
import {
  ATS1_MAGIC,
  decodeBody,
  encodeBody,
  FLAG_CONTEXT_BOUND,
  FLAG_ENCRYPTED,
  FLAG_INTEGRITY_HMAC,
  FLAG_KEY_VERSIONED,
  type DecodedBody,
  type SubKeyResolver,
} from './BodyCodec.js';
import { deriveSubkey, validateMasterKeyRing } from './Encryption.js';
import type { ObjectStorageBackend } from './ObjectStorageBackend.js';
import { resolveIntegrity, type IntegrityResolver } from './PluginConfig.js';
import { makeKeyValidator, ObjectStorageWriteKeyRules } from '../storage/KeyValidator.js';
import { MAX_REPORTED_MALFORMED_KEYS } from '../Constants.js';

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
export type ReEncryptResumeState = {
  /** Key of the last object the sweep successfully wrote.  `null` = fresh start. */
  readonly lastKey: string | null;
  /** Cumulative count of objects rewritten across runs of the same sweep. */
  readonly processedCount: number;
};

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

export type ReEncryptOptions = {
  /** Common key prefix to sweep (e.g. `'snapshots/'` or `'state/'`). */
  readonly keyPrefix: string;
  /**
   * Keyring containing the currently active key plus every retired
   * version the corpus may have been encrypted under.  Without a
   * retired entry for a version, that body's decrypt will fail.
   */
  readonly keyring: MasterKeyRing;
  /**
   * HKDF `info` string the corpus was **written** under — it must match
   * the encrypting store's `EncryptionConfig.info` exactly, or every
   * decrypt in the sweep fails.  Required since #108: there is no
   * framework-wide default to fall back on any more, and guessing one
   * would silently produce the wrong subkey.
   */
  readonly info: string;
  /**
   * HKDF `info` to **re-encrypt** under.  Unset (the normal case) means
   * "same as {@link info}" — a pure master-key rotation.  Set it to
   * rotate the derivation context itself, e.g. when splitting a shared
   * `'actor-ts/snapshot/v1'` into per-environment contexts (#108).
   *
   * Rotating `info` changes what the sweep can skip.  The key version
   * is stamped in the body manifest; the `info` is not, so a body at
   * the active key version may still be at the *old* context and there
   * is no cheap way to tell.  The version fast-path is therefore
   * disabled while `newInfo` differs from `info`, and every object is
   * decrypted to find out — slower, but the alternative is a sweep that
   * reports success having rewritten nothing.
   */
  readonly newInfo?: string;
  /**
   * Integrity configuration the corpus was **written** under (#116) —
   * either a flat `IntegrityConfig` or the very
   * per-`persistenceId` resolver the owning store was given, so that a
   * corpus with different keys per tenant resolves the same way here as
   * it does on the store's own read path.
   *
   * Required whenever a body under the prefix carries the HMAC tag.  The
   * tag authenticates the manifest bytes, so the sweep has to verify it
   * to read the body at all and recompute it to write one back; without
   * the key `decodeBody` refuses the first tagged object it meets and
   * the sweep aborts mid-corpus (#739).
   *
   * The tag is re-applied only where the body already carried one.  An
   * untagged body is not promoted, because that decision is not the
   * sweep's to make: every rewritten body would become unreadable to any
   * reader not yet configured with the integrity key, and rotation runs
   * while the application is serving.  Turning integrity on corpus-wide
   * is the stores' own read-then-write migration (see
   * {@link allowUntaggedBodies}).
   *
   * This is the key the corpus is already under, **not** a key to move
   * it to.  There is deliberately no `newIntegrity` beside
   * {@link newInfo} (#1354).  `newInfo` gets away with having no wire
   * byte because AES-GCM decryption is its own oracle — the probe in
   * the rewrite loop retries under the target context and only a
   * keyholder can make that succeed.  Integrity has no such oracle
   * that helps: nothing records which integrity key sealed a body, so
   * every reader would have to accept both keys for the duration of
   * the sweep — keeping the leaked key trusted for exactly the window
   * the revocation exists to close — and the "returning is the
   * certificate" contract (#747) would have nothing to rest on, since
   * the pre-sweep sampler can enumerate live *master* key versions off
   * the frame without holding a key and has no counterpart here.
   *
   * Rolling the integrity key is therefore a per-`persistenceId`
   * read-old / write-new pass through the stores' per-call
   * `PersistenceOptions.integrity`, not a sweep and not a migration
   * window; #1354 records that and what a wire-format answer (an
   * integrity-key version byte mirroring `FLAG_KEY_VERSIONED`) would
   * cost.
   */
  readonly integrity?: IntegrityConfig | IntegrityResolver;
  /**
   * Re-admit untagged bodies while {@link integrity} is set — the
   * migration window of a corpus that still holds bodies written before
   * integrity was enabled (#579).  Mirrors the stores' option of the
   * same name, and defaults to `false` for the same reason: a missing
   * tag and a stripped one look identical from here, so the safe reading
   * has to be the default and the unsafe one has to be spelled out.
   *
   * Without it, a sweep over a half-migrated corpus fails on the first
   * untagged body — correct, but not what an operator rotating a key in
   * the middle of an integrity rollout wants.
   */
  readonly allowUntaggedBodies?: boolean;
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
   *
   * The same pass covers the integrity dimension (#739): a sampled body
   * carrying the HMAC tag that {@link integrity} resolves no key for
   * refuses the sweep here rather than at the first tagged object in the
   * rewrite loop.  Both halves sample rather than enumerate, so both are
   * a footgun catcher and not a proof — a straggler past `sampleSize`
   * still aborts mid-corpus.
   */
  readonly verifyKeyringCompleteness?: boolean;
  /**
   * Sample size for the completeness check.  Default: min(100, total).
   *
   * Clamped to the corpus, so a value larger than the object count
   * samples every object rather than running off the end of the list
   * (#1353) — the rolling-migration runbook suggests an override of
   * 200, which a staging bucket rarely reaches.
   */
  readonly sampleSize?: number;
};

export type ReEncryptProgress = {
  readonly key: string;
  readonly index: number;
  readonly total: number;
  readonly action: 'rewrote' | 'skipped-current' | 'skipped-unencrypted' | 'skipped-non-ats1' | 'skipped-malformed-key';
};

export type ReEncryptResult = {
  /** Total objects examined. */
  readonly scanned: number;
  /**
   * Objects that were re-encoded — re-encrypted to the active key, and,
   * since #739, also the unencrypted-but-tagged bodies that were
   * re-framed only to pick up their storage-key binding (#612).  The
   * latter have no master key to rotate; they are counted here because
   * they cost a PUT and because a run that leaves them alone is a run
   * whose `requireContextBinding` migration cannot finish.
   */
  readonly rewrote: number;
  /**
   * Objects skipped because they were already at the active version
   * (the idempotent fast-path).
   */
  readonly skippedCurrent: number;
  /**
   * Objects skipped because they were never encrypted — and, when they
   * carry an integrity tag, because they are already bound to their
   * storage key, so there is nothing left for the sweep to do to them.
   */
  readonly skippedUnencrypted: number;
  /** Objects skipped because they aren't `ATS1`-framed (e.g. raw user blobs). */
  readonly skippedNonAts1: number;
  /**
   * Objects skipped because their key could not yield a usable persistence id.
   *
   * Keys come from the store's `list()`, i.e. from the bucket rather than from
   * us, and the sweep derives its HKDF salt from the key.  Since it then
   * *rewrites* the body, a key that yields the wrong salt would not merely fail
   * — it would re-encrypt data under a salt the owning store never reproduces,
   * leaving it permanently undecryptable.  Such keys are skipped instead.
   *
   * **A non-zero count fails the sweep** (#747): `reEncryptObjectStorage`
   * finishes the pass and then throws {@link ReEncryptIncompleteError} rather
   * than returning, because the run's whole purpose is to certify that the
   * retired key can be dropped — and every object counted here is one still
   * encrypted under it.  Reading this field off a *returned* result therefore
   * only ever yields `0`; the non-zero case is on the error.
   *
   * Reaching it needs a key this framework did not write — either one added
   * out-of-band, one written by a version that predates the control-character
   * rule on the write path (#747), or a `keyPrefix` that does not line up with
   * the owning store's own `prefix`, which shifts every key's pid segment by
   * one.  Excluding deliberately foreign objects is what `skip` is for.
   */
  readonly skippedMalformedKey: number;
};

/**
 * Thrown when the sweep completed its pass but cannot certify the corpus,
 * because {@link ReEncryptResult.skippedMalformedKey} objects were left
 * behind (#747).
 *
 * A counter alone was not enough.  The rotation runbook's next step is to
 * drop the retired master key, and every skipped object is still encrypted
 * under it — so a result that has to be *inspected* to notice the problem
 * puts an irreversible action behind an optional read.  The sweep is the
 * thing that tells the operator "you may now drop v1"; it says so by
 * returning, and it must not return here.
 *
 * Thrown at the end of the pass rather than at the first bad key on purpose:
 * every healthy object still gets rotated, and the operator gets the whole
 * set of offenders from one run instead of one per run.
 */
export class ReEncryptIncompleteError extends Error {
  constructor(
    /** Counts from the pass that just finished, `skippedMalformedKey` included. */
    public readonly result: ReEncryptResult,
    /**
     * Up to `MAX_REPORTED_MALFORMED_KEYS` of the offending keys — a sample
     * for recognising the pattern, not the full list.  `result
     * .skippedMalformedKey` is the exact count.
     */
    public readonly malformedKeys: readonly string[],
  ) {
    const shown = malformedKeys.map((key) => JSON.stringify(key)).join(', ');
    const elided = result.skippedMalformedKey - malformedKeys.length;
    super(
      `reEncryptObjectStorage: ${result.skippedMalformedKey} of ${result.scanned} objects were `
      + `skipped because their key yields no usable persistence id, so they are still encrypted `
      + `under a key this sweep was meant to retire.  Do NOT drop the retired master key.  `
      + `Offending key(s): ${shown}${elided > 0 ? ` (+${elided} more)` : ''}.  `
      + `Either correct those keys, or exclude them with the 'skip' predicate if they are not `
      + `this framework's objects.`,
    );
    this.name = 'ReEncryptIncompleteError';
  }
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
 * **Returning is the certificate.**  A key that yields no usable persistence
 * id is skipped rather than rewritten under a salt nobody can reproduce, and
 * a pass that skipped any such key throws {@link ReEncryptIncompleteError}
 * at the end instead of returning (#747) — the corpus is not fully under the
 * active key, so the runbook's next step (dropping the retired key) would
 * destroy those bodies.  Exclude genuinely foreign objects with `skip`.
 *
 *   const result = await reEncryptObjectStorage(backend, {
 *     keyPrefix: 'snapshots/',
 *     keyring: { active: { version: 2, key: newKey },
 *                retired: [{ version: 1, key: oldKey }] },
 *     info: 'acme/prod/snapshot/v1',
 *     onProgress: (e) => process.stderr.write(`${e.index}/${e.total} ${e.key}\n`),
 *   });
 *   console.log(`re-encrypted ${result.rewrote} of ${result.scanned}`);
 *
 * Rotating the HKDF context instead of (or alongside) the key adds
 * `newInfo`; the sweep then decrypts under `info` and writes under
 * `newInfo`:
 *
 *   await reEncryptObjectStorage(backend, {
 *     keyPrefix: 'snapshots/',
 *     keyring,
 *     info:    'actor-ts/snapshot/v1',    // the shared legacy context
 *     newInfo: 'acme/prod/snapshot/v1',   // per-environment from now on
 *   });
 *
 * A corpus written with the integrity HMAC (#116) hands the same key the
 * stores use, so every tag is verified on read and rebuilt on write:
 *
 *   await reEncryptObjectStorage(backend, {
 *     keyPrefix: 'state/',
 *     keyring,
 *     info: 'acme/prod/durable-state/v1',
 *     integrity: { mode: 'hmac-sha256', integrityKey },
 *   });
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
    skippedMalformedKey: 0,
  };
  // Bounded sample for the failure message — the exact count lives in
  // `result.skippedMalformedKey`, so retaining every key would only add a
  // per-object memory cost to a run that is already going to fail.
  const malformedKeys: string[] = [];
  // Validates the whole ring, not just `active` (#111).  The sweep's own
  // resolver below matches `active` before `retired`, so a version that
  // appears on both would decide silently which key a historical body is
  // read with — and the sweep then *rewrites* that body, turning a bad
  // read into a bad write.
  validateMasterKeyRing(options.keyring, 'reEncryptObjectStorage');
  const activeVersion = options.keyring.active.version;

  // Decrypt under the corpus's current context, re-encrypt under the
  // target one.  They coincide for a plain key rotation (#70/#109); they
  // differ when the operator is also rotating the HKDF context (#108).
  const decryptInfo = options.info;
  const encryptInfo = options.newInfo ?? options.info;
  const rotatingInfo = encryptInfo !== decryptInfo;

  /**
   * The HMAC key that verifies (and re-seals) the body at `key`, or
   * `undefined` when the operator configured no integrity for its pid.
   *
   * Resolved per key rather than once, because `integrity` accepts the
   * same per-`persistenceId` resolver the stores take: a deployment that
   * keys integrity per tenant must resolve here exactly as its store
   * does, or the sweep verifies against the wrong secret.
   */
  const integrityKeyFor = (key: string): Uint8Array | undefined => {
    if (options.integrity === undefined) return undefined;
    const resolved = resolveIntegrity(
      options.integrity, persistenceIdFromKey(key, options.keyPrefix), { mode: 'none' },
    );
    return resolved.mode === 'hmac-sha256' ? resolved.integrityKey : undefined;
  };

  // Pre-sweep keyring-completeness check (#109).  Sample some bodies,
  // gather their key versions, fail fast if any version isn't in the
  // keyring.  Better to refuse before touching the corpus than to
  // half-rewrite and then crash on a missing retired key.  Since #739 the
  // same pass answers the integrity half of the question.
  if (options.verifyKeyringCompleteness !== false) {
    const sampleSize = Math.min(options.sampleSize ?? 100, items.length);
    const haveVersions = new Set<number>([
      options.keyring.active.version,
      ...(options.keyring.retired?.map((r) => r.version) ?? []),
    ]);
    const missing = new Set<number>();
    // One example is enough here, unlike the malformed-key sample: the
    // remedy is the same for every offender — supply the key — so a list
    // would only restate it.
    let unverifiableKey: string | undefined;
    for (let i = 0; i < sampleSize; i++) {
      const item = items[i]!;
      if (options.skip?.(item.key)) continue;
      // A key the loop will refuse to sweep is a key whose body says
      // nothing about what the sweep needs — and fetching it here would
      // spend a GET on an object we have already decided not to touch.
      if (!isUsableSweepKey(item.key, options.keyPrefix, persistenceIdFromKey)) continue;
      const fetched = await backend.get(item.key);
      if (fetched.isNone()) continue;
      const framed = fetched.value.body;
      if (!startsWithAts1(framed)) continue;
      const manifest = readManifest(framed);
      // Gated on the rewrite decision, so a corpus that has already
      // converged is not refused over a key the sweep would never use.
      if (unverifiableKey === undefined
        && manifest.integrityTagged
        && willDecodeBody(manifest, activeVersion, rotatingInfo)
        && integrityKeyFor(item.key) === undefined) {
        unverifiableKey = item.key;
      }
      if (!manifest.encrypted) continue;
      if (!haveVersions.has(manifest.keyVersion)) missing.add(manifest.keyVersion);
    }
    if (missing.size > 0) {
      throw new Error(
        `reEncryptObjectStorage: keyring is incomplete — bodies in the prefix `
        + `reference master-key version(s) [${[...missing].sort((a, b) => a - b).join(', ')}] `
        + `which are absent from the keyring's 'active' and 'retired' lists.  `
        + `Restore those keys before sweeping, or the sweep will fail mid-corpus.`,
      );
    }
    if (unverifiableKey !== undefined) {
      throw new Error(
        `reEncryptObjectStorage: bodies in the prefix carry an integrity HMAC (#116) but no `
        + `integrity key was resolved for them — e.g. ${JSON.stringify(unverifiableKey)}.  `
        + `Pass the store's own configuration as the 'integrity' option (an IntegrityConfig or `
        + `the same per-persistenceId resolver) so the sweep can verify each tag and re-apply `
        + `it.  Without it the sweep aborts on the first tagged body, leaving the corpus `
        + `half-rewritten.`,
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

    // Validate before fetching: the key decides the HKDF salt, and a rewrite
    // under the wrong salt is unrecoverable.  See `skippedMalformedKey`.
    if (!isUsableSweepKey(item.key, options.keyPrefix, persistenceIdFromKey)) {
      result.skippedMalformedKey += 1;
      if (malformedKeys.length < MAX_REPORTED_MALFORMED_KEYS) malformedKeys.push(item.key);
      options.onProgress?.({ key: item.key, index, total, action: 'skipped-malformed-key' });
      continue;
    }

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
    const manifest = readManifest(framed);
    const atActiveVersion = manifest.versioned && manifest.keyVersion === activeVersion;
    // A body written before context binding (#612) is rewritten even
    // when its key version is already current: the sweep is the only
    // tool that rewrites a whole corpus, so it is what an operator runs
    // before turning `requireContextBinding` on.  Skipping such bodies
    // would leave the migration with no way to finish.
    if (!willDecodeBody(manifest, activeVersion, rotatingInfo)) {
      // Two distinct reasons, both "nothing left to do", kept apart in
      // the counters because they mean different things to an operator:
      // an encrypted body is converged on the axis this tool rotates,
      // an unencrypted one was never on it.
      if (manifest.encrypted) {
        result.skippedCurrent += 1;
        options.onProgress?.({ key: item.key, index, total, action: 'skipped-current' });
      } else {
        result.skippedUnencrypted += 1;
        options.onProgress?.({ key: item.key, index, total, action: 'skipped-unencrypted' });
      }
      continue;
    }

    const persistenceId = persistenceIdFromKey(item.key, options.keyPrefix);
    const integrityKey = integrityKeyFor(item.key);
    // Supplying the key is the assertion "this corpus is protected", so
    // the codec then demands a tag on every body — see
    // `allowUntaggedBodies` for the migration window that re-admits one.
    const decodeIntegrity = integrityKey !== undefined
      ? {
          integrity: {
            integrityKey,
            allowUntaggedBodies: options.allowUntaggedBodies === true,
          },
        }
      : {};
    const subKeyResolverFor = (hkdfInfo: string): SubKeyResolver =>
      async (keyVersion: number): Promise<Uint8Array | null> => {
        if (options.keyring.active.version === keyVersion) {
          return deriveSubkey(options.keyring.active.key, persistenceId, hkdfInfo);
        }
        const retired = options.keyring.retired?.find((r) => r.version === keyVersion);
        return retired ? deriveSubkey(retired.key, persistenceId, hkdfInfo) : null;
      };

    // Decrypt with whatever retired/active key matches the body's version.
    let decoded: DecodedBody;
    let alreadyAtNewInfo = false;
    try {
      decoded = await decodeBody(framed, {
        encryption: { subKeyFor: subKeyResolverFor(decryptInfo) },
        ...decodeIntegrity,
        context: item.key,
      });
    } catch (decryptError) {
      // An `info` rotation is the one situation where a well-formed body
      // legitimately fails to decrypt under the configured context: it
      // may have been rewritten by an earlier run of this same sweep.
      // Probe the target context before giving up, so that re-running an
      // interrupted info rotation stays idempotent instead of aborting on
      // the first already-converted object.  Anything else re-throws
      // unchanged.
      if (!rotatingInfo) throw decryptError;
      try {
        decoded = await decodeBody(framed, {
          encryption: { subKeyFor: subKeyResolverFor(encryptInfo) },
          ...decodeIntegrity,
          context: item.key,
        });
      } catch {
        throw decryptError;
      }
      alreadyAtNewInfo = true;
    }
    if (alreadyAtNewInfo && atActiveVersion && manifest.contextBound) {
      // Converged on both axes — the previous run already did this one.
      result.skippedCurrent += 1;
      options.onProgress?.({ key: item.key, index, total, action: 'skipped-current' });
      continue;
    }

    // Re-encrypt with the active key + active version stamp.  An
    // unencrypted body has no master key to rotate — it is only here to
    // pick up its #612 binding — so it is re-framed without one rather
    // than promoted to encrypted, which would make it unreadable to a
    // store that has no encryption configured.
    const activeSubkey = manifest.encrypted
      ? await deriveSubkey(options.keyring.active.key, persistenceId, encryptInfo)
      : undefined;
    const rewritten = await encodeBody(decoded.payload, {
      compression: decoded.compression,
      ...(activeSubkey !== undefined
        ? { encryption: { subKey: activeSubkey, keyVersion: activeVersion } }
        : {}),
      // Re-seal the tag only where the body already carried one.  The bit
      // is read off the body rather than off the options on purpose: an
      // operator who supplies `integrity` so the sweep can *read* a
      // half-migrated corpus has not thereby asked for every untagged
      // body in it to be promoted (#739).
      ...(manifest.integrityTagged && integrityKey !== undefined
        ? { integrity: { integrityKey } }
        : {}),
      // Rewritten in place, so the binding is to the same key it came
      // from — which also upgrades a pre-#612 body on the way past.
      context: item.key,
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
  // End of the pass → clear progress so a fresh re-run starts from the
  // beginning.  If we crashed instead, the saved progress stays on
  // disk and the next call resumes.
  //
  // Cleared before the malformed-key verdict below, and that ordering is
  // load-bearing: `lastKey` advances on rewrites, so leaving resume state
  // behind would let the re-run start *past* a malformed key and finish with
  // `skippedMalformedKey === 0` — a clean bill of health for the exact corpus
  // this call is about to refuse.  A pass that reached the end has no work
  // left to resume anyway.
  if (options.progress) await options.progress.clear();
  // Every object counted here is still under a key the operator is about to
  // drop, so the sweep must not hand back a result that reads as success.
  if (result.skippedMalformedKey > 0) {
    throw new ReEncryptIncompleteError({ ...result }, malformedKeys);
  }
  return result;
}

/* ----------------------------- internals --------------------------------- */

function startsWithAts1(buffer: Uint8Array): boolean {
  return buffer.length >= 5
    && buffer[0] === ATS1_MAGIC[0]
    && buffer[1] === ATS1_MAGIC[1]
    && buffer[2] === ATS1_MAGIC[2]
    && buffer[3] === ATS1_MAGIC[3];
}

/** The manifest bits the sweep dispatches on, read straight off the frame. */
type BodyManifest = {
  readonly encrypted: boolean;
  /** True only when the version byte is both claimed and actually present. */
  readonly versioned: boolean;
  /** 0 for a body that carries no version byte — the implicit legacy version. */
  readonly keyVersion: number;
  /** Whether an HMAC-SHA256 tag is appended (#116). */
  readonly integrityTagged: boolean;
  /** Whether the storage key was authenticated with the body (#612). */
  readonly contextBound: boolean;
};

function readManifest(framed: Uint8Array): BodyManifest {
  const flags = framed[4]!;
  // A body that claims a version byte it is too short to hold is malformed.
  // Reading it as unversioned keeps it off every fast path, so `decodeBody`
  // is the one that reports it — with the precise message, rather than this
  // function inventing a version out of a byte that is not there.
  const versioned = (flags & FLAG_KEY_VERSIONED) !== 0 && framed.length > 5;
  return {
    encrypted: (flags & FLAG_ENCRYPTED) !== 0,
    versioned,
    keyVersion: versioned ? framed[5]! : 0,
    integrityTagged: (flags & FLAG_INTEGRITY_HMAC) !== 0,
    contextBound: (flags & FLAG_CONTEXT_BOUND) !== 0,
  };
}

/**
 * Whether the sweep will decode and rewrite this body, or leave it alone.
 *
 * Both the pre-sweep sampler and the rewrite loop go through here, and that
 * is the point: the sampler exists to predict what the loop will need, so a
 * prediction that drifts from the loop either refuses a converged corpus over
 * a key the loop never uses, or misses the gap the check was added to catch.
 *
 * An unencrypted body has no master key to rotate, so the only thing that
 * could bring it here is the #612 binding — and only a tagged body carries an
 * authenticator that could hold one.  A plain body has nothing to bind and is
 * skipped, exactly as before integrity entered the picture.
 */
function willDecodeBody(
  manifest: BodyManifest, activeVersion: number, rotatingInfo: boolean,
): boolean {
  if (manifest.encrypted) {
    // Bodies in the legacy unversioned format are NOT considered "at version
    // 0" for skip purposes — they are rewritten so the corpus ends up
    // uniformly versioned.
    //
    // The `!rotatingInfo` guard is load-bearing: the manifest records the key
    // version but not the HKDF context, so during an `info` rotation the
    // version test is true for every not-yet-rewritten body.  Skipping on it
    // would make the whole sweep a silent no-op that reports
    // `skippedCurrent === scanned` and looks successful.
    const atActiveVersion = manifest.versioned && manifest.keyVersion === activeVersion;
    return !(atActiveVersion && !rotatingInfo && manifest.contextBound);
  }
  return manifest.integrityTagged && !manifest.contextBound;
}

/**
 * Key-level rules for a key that came back out of the bucket.
 *
 * `ObjectStorageWriteKeyRules` is the same object `FilesystemWriteKeyRules`
 * and `S3WriteKeyRules` spread into their own write rules, so a key either
 * backend accepted on `put` is a key this check accepts (#747).  Only the
 * factory was ever shared — the rules themselves were restated, and the sweep
 * being the strict end of that mismatch is what let the framework write keys
 * its own rotation tool then refused.
 *
 * The path-traversal rules the filesystem backend adds are deliberately
 * absent: they bound where a key may *write*, and nothing here writes to a
 * path — the sweep reads and rewrites keys the backend itself already
 * vetted.
 */
const assertSweepKeyShape = makeKeyValidator({
  errorClass: Error,
  errorPrefix: 'reEncryptObjectStorage: key',
  ...ObjectStorageWriteKeyRules,
});

/**
 * True when `key` can be swept safely.
 *
 * Two independent checks.  The shared validator covers the key's own shape.
 * The second is specific to what the sweep *does* with the key: the extracted
 * persistence id becomes the HKDF salt, so an empty or whitespace-only id
 * would derive a subkey that the owning store never uses — and because the
 * sweep rewrites the body afterwards, that is silent, permanent data loss
 * rather than a failed read.  A custom `pidFromKey` is covered too, since the
 * check runs on its output.
 *
 * The extractor is called inside the guard rather than beside it: a custom
 * `pidFromKey` that throws on a key it does not recognise is stating the same
 * thing `''` states, and routing both through the malformed counter means the
 * caller sees one verdict — {@link ReEncryptIncompleteError}, naming the key —
 * instead of a bare extractor stack trace from the middle of the corpus.
 */
function isUsableSweepKey(
  key: string,
  keyPrefix: string,
  pidFromKey: (key: string, keyPrefix: string) => string,
): boolean {
  let persistenceId: string;
  try {
    assertSweepKeyShape(key);
    persistenceId = pidFromKey(key, keyPrefix);
  } catch {
    return false;
  }
  return typeof persistenceId === 'string' && persistenceId.trim().length > 0;
}

/**
 * Default pid extractor for the layouts the built-in object-storage stores
 * use: `<keyPrefix><pid>/<leaf>` — `<prefix><pid>/<seq>.json` for
 * `ObjectStorageSnapshotStore`, `<prefix><pid>/state.json` for
 * `ObjectStorageDurableStateStore`.  The result is the HKDF salt at decrypt
 * and re-encrypt time, so it MUST match what the original write site used.
 *
 * Returns `''` — which {@link isUsableSweepKey} reads as "not sweepable" —
 * for anything that is not exactly one non-empty segment followed by one
 * non-empty leaf.  It used to return the first segment and discard the rest
 * (#747), which turned two distinct mismatches into a *plausible* id and
 * therefore a wrong salt:
 *
 *   - a `persistenceId` containing `/` — `snapshots/tenant/user1/00…json`
 *     yielded `'tenant'`, one salt shared by every pid under that tenant;
 *   - a `keyPrefix` shorter than the owning store's own `prefix` — sweeping
 *     `'snapshots/'` when the store writes `'snapshots/prod/'` yielded
 *     `'prod'` for the entire corpus.
 *
 * Neither is caught by validating the persistence id at the actor boundary
 * (#133), because in the second case the bad segment does not come from the
 * id at all.  Refusing the key shape is what catches both, and refusing is
 * safe in a way that guessing is not: the sweep *rewrites* what it reads, so
 * a wrong salt is not a failed decrypt, it is a body re-encrypted under a
 * salt the owning store never derives again.  A layout that genuinely nests
 * deeper supplies its own `pidFromKey`.
 */
function defaultPidFromKey(key: string, keyPrefix: string): string {
  if (!key.startsWith(keyPrefix)) return '';
  const remainder = key.slice(keyPrefix.length);
  const slash = remainder.indexOf('/');
  if (slash <= 0) return '';
  // Exactly one separator: a second one means the key carries a level the
  // built-in layouts do not have, and the segment before it is not reliably
  // the pid.
  if (remainder.indexOf('/', slash + 1) >= 0) return '';
  // A non-empty leaf, so `<pid>/` on its own is refused rather than read as
  // a pid whose object happens to have no name.
  if (slash === remainder.length - 1) return '';
  return remainder.slice(0, slash);
}
