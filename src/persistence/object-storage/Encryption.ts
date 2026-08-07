/**
 * Client-side encryption helpers for snapshots / durable-state bodies.
 *
 * Uses WebCrypto (`globalThis.crypto.subtle`) — present on Bun, Node,
 * and Deno without any extra import.  AES-256-GCM is the standard
 * authenticated-encryption mode; the IV is per-message (12 bytes) and
 * the auth tag is appended to the ciphertext by the algorithm.
 *
 * Subkeys per `persistenceId` are derived via HKDF-SHA256 from a single
 * master key.  The user provides the master key once (via env var,
 * Secrets Manager, …); we derive a unique subkey per pid so a leaked
 * subkey only compromises one pid's snapshots, not the entire bucket.
 */

/**
 * Lazily resolve `SubtleCrypto`.  Capturing it at module load (the old
 * approach) crashed the import itself on runtimes without WebCrypto;
 * deferring the lookup lets `probeEncryptionAvailability` surface a
 * clear "WebCrypto not available" error at registration time instead
 * (#18, #59).
 */
function getSubtle(): SubtleCrypto {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) {
    throw new Error(
      'SubtleCrypto is not available in this runtime.  Client-side '
      + 'encryption requires WebCrypto support — Node, Bun, or '
      + 'Deno.  In bundled/edge environments, ensure the bundler '
      + 'includes a WebCrypto polyfill.',
    );
  }
  return subtle;
}

/**
 * Probe whether WebCrypto is available.  Resolves on success, throws
 * the same clear error `getSubtle` would throw on failure.  Called
 * eagerly by `registerObjectStoragePlugins` when an encryption config
 * is supplied so the failure surfaces at plugin-init rather than the
 * first save call.
 */
export async function probeEncryptionAvailability(): Promise<void> {
  getSubtle();
}

/** Length of the AES-GCM IV we use, in bytes. */
export const IV_LENGTH = 12;
/** Length of the AES-256 key we derive, in bytes. */
export const KEY_LENGTH = 32;

const utf8 = new TextEncoder();

/**
 * Derive a 32-byte subkey from `masterKey` using HKDF-SHA256.  The
 * `persistenceId` is used as the HKDF `salt` so two different pids
 * produce two different subkeys; `info` is the context-binding string
 * (RFC 5869 §3.2) that separates one deployment / payload kind from
 * the next.
 *
 * `info` is a **required** parameter (#108).  It used to default to a
 * framework constant, which made the subkey for a given pid identical
 * across every deployment sharing a master key — staging and
 * production derived byte-for-byte the same key and nothing said so.
 * See {@link EncryptionConfig} for how to choose a value.
 *
 * The emptiness guard below is not redundant with the type: `info`
 * reaches here from `EncryptionConfig`, which crosses the package
 * boundary into JavaScript callers and `as any` call sites.  Without
 * it, a missing `info` would be encoded as the literal string
 * `"undefined"` — the exact deployment-wide constant this change
 * exists to remove, only harder to spot.
 */
export async function deriveSubkey(
  masterKey: Uint8Array,
  persistenceId: string,
  info: string,
): Promise<Uint8Array> {
  if (masterKey.byteLength !== KEY_LENGTH) {
    throw new Error(`encryption masterKey must be ${KEY_LENGTH} bytes, got ${masterKey.byteLength}`);
  }
  if (typeof info !== 'string' || info.length === 0) {
    throw new Error(
      'encryption info must be a non-empty string — it is the HKDF context '
      + 'that separates one deployment from another.  Set it explicitly on the '
      + "encryption config, e.g. info: 'acme/prod/snapshot/v1'.",
    );
  }
  const subtle = getSubtle();
  const baseKey = await subtle.importKey('raw', masterKey as unknown as BufferSource, 'HKDF', false, ['deriveBits']);
  const derived = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: utf8.encode(persistenceId) as unknown as BufferSource,
      info: utf8.encode(info) as unknown as BufferSource,
    },
    baseKey,
    KEY_LENGTH * 8, // bits
  );
  return new Uint8Array(derived);
}

/**
 * What {@link aesGcmEncryptSafe} produces: the ciphertext (auth tag
 * appended, the standard WebCrypto layout) plus the IV it was sealed
 * under, which the caller has to record — `BodyCodec` writes it into
 * the manifest header — because decryption cannot recover it.
 */
export type AesGcmSealed = {
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
};

/**
 * AES-256-GCM encrypt with a freshly generated IV — the form callers
 * should reach for (#110).
 *
 * GCM does not survive an IV being reused under one key: two messages
 * sealed with the same (key, IV) leak the XOR of their plaintexts, and
 * the authentication tag's forgery resistance is lost for that key
 * altogether, not merely for the two colliding messages.  Nothing in
 * the type system tells a fresh IV from a recycled one, so the durable
 * defence is to leave the caller no IV to recycle: it is generated
 * here, per call, and handed back for the caller to store.
 */
export async function aesGcmEncryptSafe(
  subkey: Uint8Array,
  plaintext: Uint8Array,
): Promise<AesGcmSealed> {
  const iv = randomIv();
  return { iv, ciphertext: await aesGcmEncrypt(subkey, iv, plaintext) };
}

/**
 * AES-256-GCM encrypt with a caller-supplied IV — returns the
 * ciphertext (with appended auth tag, the standard WebCrypto layout).
 *
 * @internal Prefer {@link aesGcmEncryptSafe}.  This form puts IV
 * uniqueness in the caller's hands, and a caller that holds an IV can
 * reuse one; it stays exported only because {@link aesGcmEncryptSafe}
 * is built on it and because the decrypt-side tests need to pin a known
 * IV.  Nothing re-exports it from an `index.ts`, so it is an in-tree
 * contract rather than public API.
 */
export async function aesGcmEncrypt(
  subkey: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  if (subkey.byteLength !== KEY_LENGTH) {
    throw new Error(`subkey must be ${KEY_LENGTH} bytes`);
  }
  if (iv.byteLength !== IV_LENGTH) {
    throw new Error(`iv must be ${IV_LENGTH} bytes`);
  }
  // The casts work around TypeScript 5.7+'s overly-strict DOM typings, where
  // `Uint8Array<ArrayBufferLike>` doesn't subtype `BufferSource` cleanly.
  const subtle = getSubtle();
  const key = await subtle.importKey('raw', subkey as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    plaintext as unknown as BufferSource,
  );
  return new Uint8Array(ciphertext);
}

/** AES-256-GCM decrypt — throws if the auth tag doesn't validate. */
export async function aesGcmDecrypt(
  subkey: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (subkey.byteLength !== KEY_LENGTH) {
    throw new Error(`subkey must be ${KEY_LENGTH} bytes`);
  }
  if (iv.byteLength !== IV_LENGTH) {
    throw new Error(`iv must be ${IV_LENGTH} bytes`);
  }
  const subtle = getSubtle();
  const key = await subtle.importKey('raw', subkey as unknown as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    ciphertext as unknown as BufferSource,
  );
  return new Uint8Array(plaintext);
}

/**
 * Generate a fresh random IV.
 *
 * @internal Paired with {@link aesGcmEncrypt}: leaving the IV generator
 * public while the IV-taking encrypt is internal would be incoherent,
 * since a caller who reaches for this has nowhere non-internal to put
 * the result.
 */
export function randomIv(): Uint8Array {
  const iv = new Uint8Array(IV_LENGTH);
  globalThis.crypto.getRandomValues(iv);
  return iv;
}

/* ============================ Key-ring helpers (#8) =========================== */

import type { EncryptionConfig, MasterKeyRing, MasterKeyRingEntry } from '../PersistenceOptions.js';
import type { SubKeyResolver } from './BodyCodec.js';

/**
 * Highest master-key version a body manifest can carry.  The version
 * travels in a single byte (see `BodyCodec`'s framing), so the ring's
 * version space is 0..255.
 */
export const MAX_KEY_VERSION = 255;

/**
 * Active version from which {@link keyVersionExhaustionWarning} starts
 * warning — 15 numbers of headroom before the byte is full.
 *
 * Deliberately a constant rather than an option.  There is nothing here
 * to tune: the number is derived from the fixed 255 ceiling, the warning
 * is advisory and costs one line at registration, and a knob would only
 * exist so an operator could switch off the one signal that says the
 * version space is running out.
 */
export const KEY_VERSION_EXHAUSTION_THRESHOLD = 240;

/**
 * Reject a structurally unusable {@link MasterKeyRing} (#111).
 *
 * Two rules, both of which the type system does not and cannot enforce:
 *
 * 1. **Every version is an integer in `[0, 255]`.**  Only one byte of the
 *    manifest records it, so a larger number cannot round-trip — it would
 *    be written truncated and read back as something else.
 * 2. **No version appears twice** across `active` and `retired`.  This is
 *    the one that actually bites.  The manifest records the *version*,
 *    never the key, so two entries claiming the same version make the
 *    lookup ambiguous — and {@link resolveDecryptSubkey} resolves that
 *    ambiguity silently, matching `active` first.  A body written under
 *    the older of the two keys then decrypts under the newer one and
 *    fails with an authentication-tag error that says nothing about the
 *    real cause.  It takes no exotic history to produce: promoting a key
 *    without renumbering it, or a typo in the second rotation a
 *    deployment ever performs, is enough.
 *
 * The key-length rule rides along for the same fail-fast reason.  A
 * wrong-sized `retired` key is accepted by the type (`Uint8Array` says
 * nothing about length) and `deriveSubkey` only rejects it when a body at
 * *that* version is finally read — which may be months after the config
 * shipped.
 *
 * Called from the ring's entry points ({@link activeEncryptKey},
 * {@link resolveDecryptSubkey}) so a ring handed in per-call cannot slip
 * past, and eagerly at plugin registration / sweep start so the common
 * case fails before any data is touched.  The per-call cost is a loop
 * over a handful of entries against an HKDF derivation — not measurable.
 *
 * `errorPrefix` names the caller so the message points at the config the
 * operator actually wrote.
 */
export function validateMasterKeyRing(ring: MasterKeyRing, errorPrefix = 'MasterKeyRing'): void {
  if (ring === null || typeof ring !== 'object') {
    throw new Error(`${errorPrefix}: keyring must be an object with an 'active' entry.`);
  }
  const labelled: ReadonlyArray<{ readonly label: string; readonly entry: MasterKeyRingEntry }> = [
    { label: 'active', entry: ring.active },
    ...(ring.retired ?? []).map((entry, index) => ({ label: `retired[${index}]`, entry })),
  ];
  const seenAt = new Map<number, string>();
  for (const { label, entry } of labelled) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`${errorPrefix}: keyring ${label} is not a { version, key } entry.`);
    }
    const version = entry.version;
    if (!Number.isInteger(version) || version < 0 || version > MAX_KEY_VERSION) {
      throw new Error(
        `${errorPrefix}: keyring ${label} version must be an integer in [0, ${MAX_KEY_VERSION}], `
        + `got ${String(version)} — the body manifest carries it in a single byte.`,
      );
    }
    const keyLength = (entry.key as Uint8Array | undefined)?.byteLength;
    if (keyLength !== KEY_LENGTH) {
      throw new Error(
        `${errorPrefix}: keyring ${label} key must be ${KEY_LENGTH} bytes (AES-256), `
        + `got ${String(keyLength)}.`,
      );
    }
    const firstLabel = seenAt.get(version);
    if (firstLabel !== undefined) {
      throw new Error(
        `${errorPrefix}: keyring version ${version} appears twice (${firstLabel} and ${label}).  `
        + 'A body manifest records only the version, so decryption would silently pick one of '
        + 'the two keys and bodies written under the other would fail to authenticate.  '
        + 'Give every entry in the ring its own version.',
      );
    }
    seenAt.set(version, label);
  }
}

/**
 * Advisory message when the active version is running out of room, or
 * `undefined` while there is headroom (#111).
 *
 * The version space is **not** a lifetime cap on how often a deployment
 * may rotate — it caps how many versions can be live in one corpus at
 * once.  A completed re-encryption sweep puts every body at the active
 * version, which empties `retired` and frees every other number for
 * reuse.  So the recovery is ordinary operational work, and it is worth
 * saying out loud while there is still time to schedule it rather than
 * at 255, when the next rotation has nowhere to go.
 */
export function keyVersionExhaustionWarning(ring: MasterKeyRing): string | undefined {
  const activeVersion = ring.active?.version;
  if (typeof activeVersion !== 'number' || activeVersion < KEY_VERSION_EXHAUSTION_THRESHOLD) {
    return undefined;
  }
  const remaining = MAX_KEY_VERSION - activeVersion;
  return 'actor-ts object-storage encryption: the active master-key version is '
    + `${activeVersion} of a maximum ${MAX_KEY_VERSION}; ${remaining} version number(s) remain.  `
    + 'Run reEncryptObjectStorage over every prefix so the whole corpus sits at the active '
    + 'version, then drop the retired entries and restart numbering from 0 — version numbers '
    + 'are reusable once no body references them.';
}

/**
 * Resolve the encrypt-side parameters for a `client-aes256-gcm`
 * config: the per-pid subkey derived from the ACTIVE master key plus
 * the version byte to embed in the body manifest (#8 — master-key
 * rotation).  Returns `undefined` for non-encrypting modes so callers
 * can pass-through to the no-encryption path.
 */
export async function activeEncryptKey(
  encryption: EncryptionConfig, persistenceId: string,
): Promise<{ subKey: Uint8Array; keyVersion: number } | undefined> {
  if (encryption.mode !== 'client-aes256-gcm') return undefined;
  if ('masterKeys' in encryption) {
    validateMasterKeyRing(encryption.masterKeys);
    const active = encryption.masterKeys.active;
    return {
      subKey: await deriveSubkey(active.key, persistenceId, encryption.info),
      keyVersion: active.version,
    };
  }
  // Legacy single-key shape — implicit version 0.  We deliberately do
  // NOT set FLAG_KEY_VERSIONED at the codec layer for this path so old
  // readers (pre-#8) keep working unchanged.
  return {
    subKey: await deriveSubkey(encryption.masterKey, persistenceId, encryption.info),
    keyVersion: 0,
  };
}

/**
 * Build a {@link SubKeyResolver} for decryption that dispatches on the
 * key version byte from the manifest.  For the legacy single-key
 * shape, the resolver always returns the single subkey regardless of
 * version (which means the legacy `masterKey` is treated as
 * "version 0" — backwards-compatible with bodies written before
 * versioning landed).  For the keyring shape, walks `active +
 * retired` looking for a matching version.
 *
 * That walk checks `active` first, which is only unambiguous because
 * {@link validateMasterKeyRing} has already refused a ring with the same
 * version on two entries (#111) — without it, the precedence here would
 * quietly decide which of two keys a body was "meant" to use.
 */
export function resolveDecryptSubkey(
  encryption: EncryptionConfig, persistenceId: string,
): SubKeyResolver | undefined {
  if (encryption.mode !== 'client-aes256-gcm') return undefined;
  if ('masterKeys' in encryption) {
    const ring = encryption.masterKeys;
    validateMasterKeyRing(ring);
    return async (version: number): Promise<Uint8Array | null> => {
      if (ring.active.version === version) {
        return deriveSubkey(ring.active.key, persistenceId, encryption.info);
      }
      const retired = ring.retired?.find((r) => r.version === version);
      if (retired) return deriveSubkey(retired.key, persistenceId, encryption.info);
      return null;
    };
  }
  // Legacy single-key — the version byte is informational only.
  // Derive once and return the same subkey for any version request.
  const masterKey = encryption.masterKey;
  return async (_version: number): Promise<Uint8Array> =>
    deriveSubkey(masterKey, persistenceId, encryption.info);
}

/**
 * Decide whether the encode path should use the new versioned-key
 * wire format.  Bodies written under the legacy single-key shape
 * stay unversioned (FLAG_KEY_VERSIONED unset) so they can still be
 * read by code from before #8 landed.  The keyring shape always
 * writes versioned bodies.
 */
export function isVersionedKeyShape(encryption: EncryptionConfig): boolean {
  return encryption.mode === 'client-aes256-gcm' && 'masterKeys' in encryption;
}
