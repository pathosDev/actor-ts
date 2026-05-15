/**
 * HMAC-SHA256 helpers for unencrypted body integrity (#116).
 *
 * Closes a gap in the wire format: AES-GCM's auth tag protects
 * encrypted bodies against tampering, but `mode: 'none'` bodies (the
 * default) had no integrity field.  An attacker with write access to
 * the object-storage backend could flip JSON bytes — including the
 * `revision` digit used by DurableState's CAS — without detection.
 *
 * Fix: opt-in HMAC-SHA256 over the payload bytes, truncated to 16
 * bytes (128-bit MAC strength), appended to the body and flagged in
 * the manifest.  Key is **separate** from the encryption master key
 * (the threat is tampering, not confidentiality), held by the same
 * deployment.  Verification runs at the codec boundary before the
 * payload is returned to the store layer.
 *
 * Defaults to off so legacy bodies (no `FLAG_INTEGRITY_HMAC`) keep
 * decoding cleanly.  Operators opt in by setting the new
 * `IntegrityConfig` on a `ObjectStorageDurableStateStore` (or the
 * `integrity` option on a single call).
 */

/** Length of the HMAC key, in bytes. */
export const HMAC_KEY_LENGTH = 32;

/**
 * Length of the truncated HMAC tag appended to bodies.  Truncated
 * SHA-256 stays well above the practical forgery threshold (128 bits =
 * 2^128 attempts).  Keeps the storage overhead constant at 16 bytes
 * per body regardless of payload size.
 */
export const HMAC_TAG_LENGTH = 16;

function getSubtle(): SubtleCrypto {
  const s = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!s) {
    throw new Error(
      'SubtleCrypto is not available in this runtime.  Body integrity '
      + 'requires WebCrypto — Node 20+, Bun, or Deno.',
    );
  }
  return s;
}

/**
 * Compute HMAC-SHA256 over `data` with `key`, truncated to
 * {@link HMAC_TAG_LENGTH} bytes.
 */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (key.byteLength !== HMAC_KEY_LENGTH) {
    throw new Error(`integrity key must be ${HMAC_KEY_LENGTH} bytes, got ${key.byteLength}`);
  }
  const subtle = getSubtle();
  const cryptoKey = await subtle.importKey(
    'raw',
    key as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', cryptoKey, data as unknown as BufferSource);
  return new Uint8Array(sig).subarray(0, HMAC_TAG_LENGTH);
}

/**
 * Constant-time comparison of two byte arrays.  Avoids leaking the
 * position of the first mismatch via timing.  Returns `false` for
 * length-mismatches as a fast-path (no information leak since length
 * is part of the wire format).
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
