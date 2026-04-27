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

const subtle = globalThis.crypto.subtle;

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
