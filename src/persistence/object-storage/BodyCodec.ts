import { match } from 'ts-pattern';
import { compressorFor, type CompressionAlgo } from './Compression.js';
import { aesGcmDecrypt, aesGcmEncrypt, IV_LENGTH, randomIv } from './Encryption.js';
import { constantTimeEqual, HMAC_TAG_LENGTH, hmacSha256 } from './Integrity.js';

/**
 * Wire-format for snapshot / durable-state bodies stored in object storage.
 *
 *   Bytes 0..3   : MAGIC          "ATS1"  (actor-ts persistence v1)
 *   Byte  4      : flags          bit0..1 = compression: 0=none, 1=gzip, 2=zstd
 *                                  bit2     = encrypted
 *                                  bit3     = key-versioned (#8 — master-key rotation)
 *                                  bit4     = integrity HMAC tag appended (#116)
 *   Byte  5      : keyVersion     (0..255)  — only when bit3 set
 *   Bytes ...    : AES-GCM IV     (12 bytes — only when bit2 set, immediately
 *                                   after the keyVersion byte if present, else
 *                                   immediately after flags)
 *   Bytes ...    : payload        (compressed/encrypted JSON)
 *   Bytes ...    : HMAC tag       (16 bytes — only when bit4 set, suffixed
 *                                   after the payload; HMAC covers every
 *                                   byte BEFORE the tag, including the
 *                                   manifest header)
 *
 * A size-conservative header (5 bytes for unencrypted; 17 for encrypted
 * legacy / 18 for encrypted with explicit version) keeps small snapshots
 * cheap in S3 storage; compressing the JSON before encryption is
 * intentional (encryption defeats compression, so the order matters and
 * is fixed by the format).
 *
 * **Backwards compatibility.**  Encrypted bodies written before rotation
 * support shipped (#8) have bit3 unset and no keyVersion byte — the
 * decoder treats them as version 0, which transparently maps to either
 * the legacy single-key `masterKey` config or `masterKeys.active.version
 * === 0`.  Mixing old and new bodies in one bucket is therefore safe.
 *
 * Same back-compat story for integrity (#116): bodies written before
 * bit4 landed have it unset and decode without an HMAC check.  Callers
 * who want to refuse legacy bodies after a migration can pass
 * `requireIntegrity: true` on decode to enforce.
 */

export const ATS1_MAGIC = new Uint8Array([0x41, 0x54, 0x53, 0x31]); // "ATS1"

export const COMPRESSION_NONE = 0b00;
export const COMPRESSION_GZIP = 0b01;
export const COMPRESSION_ZSTD = 0b10;
export const FLAG_ENCRYPTED = 0b100;
/** When set with FLAG_ENCRYPTED, the byte after `flags` is a 0..255 key version. */
export const FLAG_KEY_VERSIONED = 0b1000;
/** When set, the last {@link HMAC_TAG_LENGTH} bytes are an HMAC-SHA256 over the rest. */
export const FLAG_INTEGRITY_HMAC = 0b10000;

/**
 * Default cap on the decompressed size of a stored body (512 MiB).  Bounds a
 * decompression bomb on read (security audit #3) — a real snapshot /
 * durable-state blob is far smaller.  Override per-decode via
 * {@link DecodeOptions.maxOutputBytes} (`Infinity` opts out).
 */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

export interface EncodeOptions {
  readonly compression?: CompressionAlgo;
  /**
   * Algorithm-specific compression level (gzip 0–9, zstd 1–22) passed
   * through to the compressor.  Out-of-range values are clamped;
   * `undefined` uses the impl default.  Not recorded on the wire — the
   * manifest stores only the algorithm, and decode never needs the level.
   */
  readonly compressionLevel?: number;
  /**
   * When set, the body is encrypted with AES-256-GCM using the supplied
   * 32-byte subkey (typically derived per-pid via HKDF — see
   * `Encryption.deriveSubkey`).  Compression runs first so encryption
   * doesn't fight with compression's information theory; the IV is
   * generated fresh per call and embedded in the manifest header.
   *
   * `keyVersion` (0..255) is embedded in the manifest so decrypt can
   * pick the matching master key from a `MasterKeyRing` (#8).  Omit
   * it for the legacy single-key path — the decoder treats omitted
   * keys as "version 0".
   */
  readonly encryption?: { readonly subKey: Uint8Array; readonly keyVersion?: number };
  /**
   * Opt-in HMAC-SHA256 integrity (#116).  When set, the codec computes
   * an HMAC over the framed body (everything up to the tag) and appends
   * the truncated 16-byte tag.  `FLAG_INTEGRITY_HMAC` is set in the
   * manifest.  Encrypted bodies don't need this for confidentiality
   * (AES-GCM's auth tag already covers ciphertext), but it ties the
   * manifest bytes to the body — useful as defense-in-depth against
   * a manifest-flip attack.
   */
  readonly integrity?: { readonly integrityKey: Uint8Array };
}

/**
 * Subkey resolver — given the version byte the manifest carries, return
 * the subkey to decrypt with.  For a single-key config the resolver
 * ignores the version and always returns the same subkey; for a
 * keyring it dispatches.  Returning `null` means "I don't have a key
 * for that version" — the codec then throws a clear error.
 */
export type SubKeyResolver = (keyVersion: number) => Promise<Uint8Array | null>;

export interface DecodeOptions {
  /**
   * Required when the body is encrypted — callers either supply a
   * single subkey (legacy single-key shape) or a resolver that
   * dispatches on the manifest's key version.  If absent on an
   * encrypted body, `decodeBody` rejects.
   */
  readonly encryption?:
    | { readonly subKey: Uint8Array }
    | { readonly subKeyFor: SubKeyResolver };
  /**
   * When the manifest carries `FLAG_INTEGRITY_HMAC`, the codec verifies
   * the appended HMAC tag against this key.  Mismatch throws — body
   * has been tampered.  Setting `requireIntegrity: true` AND providing
   * a key forces the codec to also REJECT bodies that DON'T carry the
   * flag (use after a migration to ensure no legacy/unprotected
   * bodies slip through).
   */
  readonly integrity?: {
    readonly integrityKey: Uint8Array;
    readonly requireIntegrity?: boolean;
  };
  /**
   * Cap on the decompressed payload size in bytes.  Defaults to
   * {@link DEFAULT_MAX_DECOMPRESSED_BYTES}; pass `Infinity` to disable.
   * Guards against a decompression bomb in a tampered / hostile stored body
   * (security audit #3).
   */
  readonly maxOutputBytes?: number;
}

export interface DecodedBody {
  readonly compression: CompressionAlgo;
  readonly encrypted: boolean;
  /** 0..255 when the body carried a key-version manifest, else `undefined`. */
  readonly keyVersion?: number;
  readonly payload: Uint8Array;     // plaintext, decompressed
}

/**
 * Encode a JSON-stringified payload with the framing above.  Returns a
 * fresh `Uint8Array` ready to ship to the backend.
 */
export async function encodeBody(jsonBytes: Uint8Array, opts: EncodeOptions = {}): Promise<Uint8Array> {
  const algo = opts.compression ?? 'none';
  const subKey = opts.encryption?.subKey;
  const keyVersion = opts.encryption?.keyVersion;
  const integrityKey = opts.integrity?.integrityKey;

  // Step 1: compress (if requested).  Encryption-after-compression
  // because compression-after-encryption would defeat compression
  // (ciphertext is high-entropy) AND it's the order that protects
  // against CRIME-style side channels.
  const compressed = await compressorFor(algo).compress(jsonBytes, opts.compressionLevel);

  // Step 2: encrypt (if requested).  IV goes into the manifest.
  let bodyBeforeIntegrity: Uint8Array;
  if (subKey) {
    if (keyVersion !== undefined) {
      if (!Number.isInteger(keyVersion) || keyVersion < 0 || keyVersion > 255) {
        throw new Error(`BodyCodec: keyVersion must be an integer in [0, 255], got ${keyVersion}`);
      }
    }
    const iv = randomIv();
    const ciphertext = await aesGcmEncrypt(subKey, iv, compressed);
    const versioned = keyVersion !== undefined;
    let flags = encodeCompression(algo) | FLAG_ENCRYPTED;
    if (versioned) flags |= FLAG_KEY_VERSIONED;
    if (integrityKey) flags |= FLAG_INTEGRITY_HMAC;
    const headerLen = ATS1_MAGIC.length + 1 + (versioned ? 1 : 0) + IV_LENGTH;
    bodyBeforeIntegrity = new Uint8Array(headerLen + ciphertext.length);
    bodyBeforeIntegrity.set(ATS1_MAGIC, 0);
    bodyBeforeIntegrity[4] = flags;
    let offset = 5;
    if (versioned) { bodyBeforeIntegrity[offset] = keyVersion!; offset += 1; }
    bodyBeforeIntegrity.set(iv, offset);
    offset += IV_LENGTH;
    bodyBeforeIntegrity.set(ciphertext, offset);
  } else {
    // Step 3 (no encryption): build the plain framed body.
    let flags = encodeCompression(algo);
    if (integrityKey) flags |= FLAG_INTEGRITY_HMAC;
    bodyBeforeIntegrity = new Uint8Array(ATS1_MAGIC.length + 1 + compressed.length);
    bodyBeforeIntegrity.set(ATS1_MAGIC, 0);
    bodyBeforeIntegrity[4] = flags;
    bodyBeforeIntegrity.set(compressed, 5);
  }

  // Step 4 (optional): append the HMAC-SHA256 integrity tag (#116).
  // Covers the manifest header + payload — any tampering of either
  // invalidates the tag.
  if (integrityKey) {
    const tag = await hmacSha256(integrityKey, bodyBeforeIntegrity);
    const out = new Uint8Array(bodyBeforeIntegrity.length + tag.length);
    out.set(bodyBeforeIntegrity, 0);
    out.set(tag, bodyBeforeIntegrity.length);
    return out;
  }
  return bodyBeforeIntegrity;
}

/** Decode a body produced by `encodeBody` back into the plaintext payload. */
export async function decodeBody(framed: Uint8Array, opts: DecodeOptions = {}): Promise<DecodedBody> {
  if (framed.length < 5 || !magicMatches(framed)) {
    throw new Error('BodyCodec: unrecognised body — expected ATS1 magic bytes.');
  }
  const flags = framed[4]!;
  const compression = decodeCompression(flags);
  const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
  const versioned = (flags & FLAG_KEY_VERSIONED) !== 0;
  const hasIntegrity = (flags & FLAG_INTEGRITY_HMAC) !== 0;

  // Integrity check FIRST — before we trust any other manifest byte
  // beyond `flags` (which we already used to know the tag is there).
  // The HMAC tag is the last 16 bytes; verifying it proves the rest of
  // the body wasn't tampered with, including bytes the decode path
  // hasn't even read yet (#116).
  let bodyForRest = framed;
  if (hasIntegrity) {
    if (framed.length < 5 + HMAC_TAG_LENGTH) {
      throw new Error('BodyCodec: integrity-tagged body is shorter than the HMAC tag requires.');
    }
    if (!opts.integrity?.integrityKey) {
      throw new Error(
        'BodyCodec: body carries FLAG_INTEGRITY_HMAC but no integrityKey was supplied for decoding.',
      );
    }
    const sigOffset = framed.length - HMAC_TAG_LENGTH;
    const expected = framed.subarray(sigOffset);
    const signed = framed.subarray(0, sigOffset);
    const actual = await hmacSha256(opts.integrity.integrityKey, signed);
    if (!constantTimeEqual(actual, expected)) {
      throw new Error('BodyCodec: integrity check failed — body tampered or wrong integrity key.');
    }
    bodyForRest = signed;
  } else if (opts.integrity?.requireIntegrity) {
    throw new Error(
      'BodyCodec: body has no integrity tag but requireIntegrity=true was set.  '
      + 'Body was either written before integrity was enabled, or is being injected '
      + 'as part of a downgrade attack.',
    );
  }

  const maxOut = opts.maxOutputBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
  let payload: Uint8Array;
  let keyVersion: number | undefined;
  if (encrypted) {
    if (!opts.encryption) {
      throw new Error('BodyCodec: body is encrypted but no subKey/resolver was supplied for decoding.');
    }
    let offset = 5;
    if (versioned) {
      if (bodyForRest.length < 6) {
        throw new Error('BodyCodec: encrypted body claims key-versioned but is shorter than the version byte requires.');
      }
      keyVersion = bodyForRest[5]!;
      offset = 6;
    }
    if (bodyForRest.length < offset + IV_LENGTH) {
      throw new Error('BodyCodec: encrypted body is shorter than the manifest IV requires.');
    }
    const iv = bodyForRest.subarray(offset, offset + IV_LENGTH);
    const ciphertext = bodyForRest.subarray(offset + IV_LENGTH);

    // Resolve the subkey: prefer the resolver path (versioned), fall
    // back to the legacy single-subkey field.  An unversioned body
    // dispatched against a resolver is treated as version 0 — that's
    // the implicit version the legacy single-key shape always carried.
    const enc = opts.encryption as
      | { readonly subKey: Uint8Array }
      | { readonly subKeyFor: SubKeyResolver };
    let subKey: Uint8Array | null;
    if ('subKeyFor' in enc) {
      subKey = await enc.subKeyFor(keyVersion ?? 0);
      if (!subKey) {
        throw new Error(
          `BodyCodec: no master key registered for version ${keyVersion ?? 0} — `
          + `add it to the keyring's \`retired\` list to decrypt historical blobs.`,
        );
      }
    } else {
      subKey = enc.subKey;
    }

    const compressedPlaintext = await aesGcmDecrypt(subKey, iv, ciphertext);
    payload = await compressorFor(compression).decompress(compressedPlaintext, maxOut);
  } else {
    const compressedSlice = bodyForRest.subarray(5);
    payload = await compressorFor(compression).decompress(compressedSlice, maxOut);
  }

  return {
    compression,
    encrypted,
    ...(keyVersion !== undefined ? { keyVersion } : {}),
    payload,
  };
}

/* ----------------------------- internals -------------------------------- */

function magicMatches(buf: Uint8Array): boolean {
  return buf[0] === ATS1_MAGIC[0]
    && buf[1] === ATS1_MAGIC[1]
    && buf[2] === ATS1_MAGIC[2]
    && buf[3] === ATS1_MAGIC[3];
}

function encodeCompression(algo: CompressionAlgo): number {
  // Exhaustive — adding a new CompressionAlgo variant forces this site.
  return match(algo)
    .with('none', () => COMPRESSION_NONE)
    .with('gzip', () => COMPRESSION_GZIP)
    .with('zstd', () => COMPRESSION_ZSTD)
    .exhaustive();
}

function decodeCompression(flags: number): CompressionAlgo {
  // Decoding the bit-pattern back to the typed union — input is a
  // number (constrained 0..3 by the caller's bitmask), so the default
  // throw stays as runtime guard for bad/legacy bytes.  Cannot use
  // `match().exhaustive()` here because the input type is `number`,
  // not a closed union.
  switch (flags & 0b11) {
    case COMPRESSION_NONE: return 'none';
    case COMPRESSION_GZIP: return 'gzip';
    case COMPRESSION_ZSTD: return 'zstd';
    default:
      throw new Error(`BodyCodec: unknown compression flags ${(flags & 0b11).toString(2)}`);
  }
}
