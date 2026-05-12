import { match } from 'ts-pattern';
import { compressorFor, type CompressionAlgo } from './Compression.js';
import { aesGcmDecrypt, aesGcmEncrypt, IV_LENGTH, randomIv } from './Encryption.js';

/**
 * Wire-format for snapshot / durable-state bodies stored in object storage.
 *
 *   Bytes 0..3   : MAGIC          "ATS1"  (actor-ts persistence v1)
 *   Byte  4      : flags          bit0..1 = compression: 0=none, 1=gzip, 2=zstd
 *                                  bit2     = encrypted
 *                                  bit3     = key-versioned (#8 — master-key rotation)
 *   Byte  5      : keyVersion     (0..255)  — only when bit3 set
 *   Bytes ...    : AES-GCM IV     (12 bytes — only when bit2 set, immediately
 *                                   after the keyVersion byte if present, else
 *                                   immediately after flags)
 *   Bytes ...    : payload        (compressed/encrypted JSON)
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
 */

export const ATS1_MAGIC = new Uint8Array([0x41, 0x54, 0x53, 0x31]); // "ATS1"

export const COMPRESSION_NONE = 0b00;
export const COMPRESSION_GZIP = 0b01;
export const COMPRESSION_ZSTD = 0b10;
export const FLAG_ENCRYPTED = 0b100;
/** When set with FLAG_ENCRYPTED, the byte after `flags` is a 0..255 key version. */
export const FLAG_KEY_VERSIONED = 0b1000;

export interface EncodeOptions {
  readonly compression?: CompressionAlgo;
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

  // Step 1: compress (if requested).  Encryption-after-compression
  // because compression-after-encryption would defeat compression
  // (ciphertext is high-entropy) AND it's the order that protects
  // against CRIME-style side channels.
  const compressed = await compressorFor(algo).compress(jsonBytes);

  // Step 2: encrypt (if requested).  IV goes into the manifest.
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
    const headerLen = ATS1_MAGIC.length + 1 + (versioned ? 1 : 0) + IV_LENGTH;
    const out = new Uint8Array(headerLen + ciphertext.length);
    out.set(ATS1_MAGIC, 0);
    out[4] = flags;
    let offset = 5;
    if (versioned) { out[offset] = keyVersion!; offset += 1; }
    out.set(iv, offset);
    offset += IV_LENGTH;
    out.set(ciphertext, offset);
    return out;
  }

  // Step 3 (no encryption): build the plain framed body.
  const flags = encodeCompression(algo);
  const out = new Uint8Array(ATS1_MAGIC.length + 1 + compressed.length);
  out.set(ATS1_MAGIC, 0);
  out[4] = flags;
  out.set(compressed, 5);
  return out;
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

  let payload: Uint8Array;
  let keyVersion: number | undefined;
  if (encrypted) {
    if (!opts.encryption) {
      throw new Error('BodyCodec: body is encrypted but no subKey/resolver was supplied for decoding.');
    }
    let offset = 5;
    if (versioned) {
      if (framed.length < 6) {
        throw new Error('BodyCodec: encrypted body claims key-versioned but is shorter than the version byte requires.');
      }
      keyVersion = framed[5]!;
      offset = 6;
    }
    if (framed.length < offset + IV_LENGTH) {
      throw new Error('BodyCodec: encrypted body is shorter than the manifest IV requires.');
    }
    const iv = framed.subarray(offset, offset + IV_LENGTH);
    const ciphertext = framed.subarray(offset + IV_LENGTH);

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
    payload = await compressorFor(compression).decompress(compressedPlaintext);
  } else {
    const compressedSlice = framed.subarray(5);
    payload = await compressorFor(compression).decompress(compressedSlice);
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
