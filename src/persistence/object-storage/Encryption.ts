/**
 * Client-side encryption helpers for snapshots / durable-state bodies.
 *
 * Uses WebCrypto (`globalThis.crypto.subtle`) — present on Bun, Node 20+,
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
      + 'encryption requires WebCrypto support — Node 20+, Bun, or '
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
 * produce two different subkeys; `info` is a domain-separator string.
 */
export async function deriveSubkey(
  masterKey: Uint8Array,
  persistenceId: string,
  info: string = 'actor-ts/snapshot/v1',
): Promise<Uint8Array> {
  if (masterKey.byteLength !== KEY_LENGTH) {
    throw new Error(`encryption masterKey must be ${KEY_LENGTH} bytes, got ${masterKey.byteLength}`);
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
 * AES-256-GCM encrypt — returns the ciphertext (with appended auth tag,
 * the standard WebCrypto layout).  The IV is supplied by the caller so
 * `BodyCodec` can put it in the manifest header.
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

/** Generate a fresh random IV. */
export function randomIv(): Uint8Array {
  const iv = new Uint8Array(IV_LENGTH);
  globalThis.crypto.getRandomValues(iv);
  return iv;
}

/* ============================ Key-ring helpers (#8) =========================== */

import type { EncryptionConfig } from '../PersistenceOptions.js';
import type { SubKeyResolver } from './BodyCodec.js';

/**
 * Resolve the encrypt-side parameters for a `client-aes256-gcm`
 * config: the per-pid subkey derived from the ACTIVE master key plus
 * the version byte to embed in the body manifest (#8 — master-key
 * rotation).  Returns `undefined` for non-encrypting modes so callers
 * can pass-through to the no-encryption path.
 */
export async function activeEncryptKey(
  encryption: EncryptionConfig, pid: string,
): Promise<{ subKey: Uint8Array; keyVersion: number } | undefined> {
  if (encryption.mode !== 'client-aes256-gcm') return undefined;
  if ('masterKeys' in encryption) {
    const active = encryption.masterKeys.active;
    return {
      subKey: await deriveSubkey(active.key, pid, encryption.info),
      keyVersion: active.version,
    };
  }
  // Legacy single-key shape — implicit version 0.  We deliberately do
  // NOT set FLAG_KEY_VERSIONED at the codec layer for this path so old
  // readers (pre-#8) keep working unchanged.
  return {
    subKey: await deriveSubkey(encryption.masterKey, pid, encryption.info),
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
 */
export function resolveDecryptSubkey(
  encryption: EncryptionConfig, pid: string,
): SubKeyResolver | undefined {
  if (encryption.mode !== 'client-aes256-gcm') return undefined;
  if ('masterKeys' in encryption) {
    const ring = encryption.masterKeys;
    return async (version: number): Promise<Uint8Array | null> => {
      if (ring.active.version === version) {
        return deriveSubkey(ring.active.key, pid, encryption.info);
      }
      const retired = ring.retired?.find((r) => r.version === version);
      if (retired) return deriveSubkey(retired.key, pid, encryption.info);
      return null;
    };
  }
  // Legacy single-key — the version byte is informational only.
  // Derive once and return the same subkey for any version request.
  const masterKey = encryption.masterKey;
  return async (_version: number): Promise<Uint8Array> =>
    deriveSubkey(masterKey, pid, encryption.info);
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
