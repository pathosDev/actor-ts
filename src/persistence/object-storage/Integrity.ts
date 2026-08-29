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
 * Width of the big-endian length prefix that precedes the context in a
 * context-bound HMAC input (#612).
 *
 * The prefix is what makes the concatenation injective.  Signing
 * `context || data` unprefixed would let a body at key `"a/b"` with
 * payload `"cd"` and one at key `"a"` with payload `"bcd"` produce the
 * same input, so a tag valid for one would verify for the other — the
 * very substitution the binding exists to prevent.  Four bytes is one
 * word and covers any key an object store will accept.
 */
export const CONTEXT_LENGTH_PREFIX_BYTES = 4;

/**
 * Length of the truncated HMAC tag appended to bodies.  Truncated
 * SHA-256 stays well above the practical forgery threshold (128 bits =
 * 2^128 attempts).  Keeps the storage overhead constant at 16 bytes
 * per body regardless of payload size.
 */
export const HMAC_TAG_LENGTH = 16;

function getSubtle(): SubtleCrypto {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) {
    throw new Error(
      'SubtleCrypto is not available in this runtime.  Body integrity '
      + 'requires WebCrypto — Node, Bun, or Deno.',
    );
  }
  return subtle;
}

/**
 * Probe whether WebCrypto is available for HMAC.  Resolves on success,
 * throws the same clear error {@link hmacSha256} would throw on the
 * first write.  Called eagerly by `registerObjectStoragePlugins` when
 * an integrity config is present, so a runtime without WebCrypto fails
 * at registration rather than at the first save (#18, #59).
 */
export async function probeIntegrityAvailability(): Promise<void> {
  getSubtle();
}

/**
 * Compute HMAC-SHA256 over `data` with `key`, truncated to
 * {@link HMAC_TAG_LENGTH} bytes.
 *
 * `context` binds the tag to *where the bytes live* (#612).  The
 * integrity key is one flat, deployment-wide secret, so without a
 * context the tag says only "someone holding the key wrote these
 * bytes" — it says nothing about which object they wrote them to.  An
 * attacker with bucket write access could therefore copy one
 * `persistenceId`'s authentic body onto another's key and have it
 * verify, and the store would hand the second pid the first one's
 * state.  Passing the storage key here makes a tag valid for key `K`
 * fail for key `K'`.
 *
 * Omitting `context` reproduces the pre-#612 input byte-for-byte, which
 * is what lets bodies written before the binding keep verifying.
 */
export async function hmacSha256(
  key: Uint8Array,
  data: Uint8Array,
  context?: Uint8Array,
): Promise<Uint8Array> {
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
  const signedInput = context === undefined ? data : withContextPrefix(context, data);
  const sig = await subtle.sign('HMAC', cryptoKey, signedInput as unknown as BufferSource);
  return new Uint8Array(sig).subarray(0, HMAC_TAG_LENGTH);
}

/**
 * Build the length-prefixed signing input
 * `<uint32 be contextLength> || context || data`.
 *
 * See {@link CONTEXT_LENGTH_PREFIX_BYTES} for why the prefix is not
 * optional.
 */
function withContextPrefix(context: Uint8Array, data: Uint8Array): Uint8Array {
  if (context.byteLength > 0xffff_ffff) {
    throw new Error(`integrity context must be at most ${0xffff_ffff} bytes, got ${context.byteLength}`);
  }
  const out = new Uint8Array(CONTEXT_LENGTH_PREFIX_BYTES + context.byteLength + data.byteLength);
  new DataView(out.buffer).setUint32(0, context.byteLength, false);
  out.set(context, CONTEXT_LENGTH_PREFIX_BYTES);
  out.set(data, CONTEXT_LENGTH_PREFIX_BYTES + context.byteLength);
  return out;
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
