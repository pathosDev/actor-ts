import { compressorFor, type CompressionAlgo } from './Compression.js';
import { aesGcmDecrypt, aesGcmEncrypt, IV_LENGTH, randomIv } from './Encryption.js';

/**
 * Wire-format for snapshot / durable-state bodies stored in object storage.
 *
 *   Bytes 0..3   : MAGIC          "ATS1"  (actor-ts persistence v1)
 *   Byte  4      : flags          bit0..1 = compression: 0=none, 1=gzip, 2=zstd
 *                                  bit2     = encrypted   (Phase 5)
 *   Bytes 5..16  : AES-GCM IV     (12 bytes — only present when bit2 is set)
 *   Bytes 17..   : payload        (compressed/encrypted JSON)
 *
 * A size-conservative header (5 bytes for unencrypted, 17 for encrypted)
 * keeps small snapshots cheap in S3 storage; compressing the JSON before
 * encryption is intentional (encryption defeats compression, so the
 * order matters and is fixed by the format).
 *
 * Phase 1 ships with the compression path live and the encryption path
 * stubbed — the flags byte already reserves the bit so Phase 5 can flip
 * it on without a format change.
 */

export const ATS1_MAGIC = new Uint8Array([0x41, 0x54, 0x53, 0x31]); // "ATS1"

export const COMPRESSION_NONE = 0b00;
export const COMPRESSION_GZIP = 0b01;
export const COMPRESSION_ZSTD = 0b10;
export const FLAG_ENCRYPTED = 0b100;

export interface EncodeOptions {
  readonly compression?: CompressionAlgo;
  /**
   * When set, the body is encrypted with AES-256-GCM using the supplied
   * 32-byte subkey (typically derived per-pid via HKDF — see
   * `Encryption.deriveSubkey`).  Compression runs first so encryption
   * doesn't fight with compression's information theory; the IV is
   * generated fresh per call and embedded in the manifest header.
   */
  readonly encryption?: { readonly subKey: Uint8Array };
}

export interface DecodeOptions {
  /**
   * Required when the body is encrypted — caller must supply the same
   * subkey used at encode time.  If absent on an encrypted body,
   * `decodeBody` rejects.
   */
  readonly encryption?: { readonly subKey: Uint8Array };
}

export interface DecodedBody {
  readonly compression: CompressionAlgo;
  readonly encrypted: boolean;
  readonly payload: Uint8Array;     // plaintext, decompressed
}

/**
 * Encode a JSON-stringified payload with the framing above.  Returns a
 * fresh `Uint8Array` ready to ship to the backend.
 */
export async function encodeBody(jsonBytes: Uint8Array, opts: EncodeOptions = {}): Promise<Uint8Array> {
  const algo = opts.compression ?? 'none';
  const subKey = opts.encryption?.subKey;

  // Step 1: compress (if requested).  Encryption-after-compression
  // because compression-after-encryption would defeat compression
  // (ciphertext is high-entropy) AND it's the order that protects
  // against CRIME-style side channels.
  const compressed = await compressorFor(algo).compress(jsonBytes);

  // Step 2: encrypt (if requested).  IV goes into the manifest.
  if (subKey) {
    const iv = randomIv();
    const ciphertext = await aesGcmEncrypt(subKey, iv, compressed);
    const flags = encodeCompression(algo) | FLAG_ENCRYPTED;
    const out = new Uint8Array(ATS1_MAGIC.length + 1 + IV_LENGTH + ciphertext.length);
    out.set(ATS1_MAGIC, 0);
    out[4] = flags;
    out.set(iv, 5);
    out.set(ciphertext, 5 + IV_LENGTH);
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

  let payload: Uint8Array;
  if (encrypted) {
    if (!opts.encryption?.subKey) {
      throw new Error('BodyCodec: body is encrypted but no subKey was supplied for decoding.');
    }
    if (framed.length < 5 + IV_LENGTH) {
      throw new Error('BodyCodec: encrypted body is shorter than the manifest IV requires.');
    }
    const iv = framed.subarray(5, 5 + IV_LENGTH);
    const ciphertext = framed.subarray(5 + IV_LENGTH);
    const compressedPlaintext = await aesGcmDecrypt(opts.encryption.subKey, iv, ciphertext);
    payload = await compressorFor(compression).decompress(compressedPlaintext);
  } else {
    const compressedSlice = framed.subarray(5);
    payload = await compressorFor(compression).decompress(compressedSlice);
  }

  return { compression, encrypted, payload };
}

/* ----------------------------- internals -------------------------------- */

function magicMatches(buf: Uint8Array): boolean {
  return buf[0] === ATS1_MAGIC[0]
    && buf[1] === ATS1_MAGIC[1]
    && buf[2] === ATS1_MAGIC[2]
    && buf[3] === ATS1_MAGIC[3];
}

function encodeCompression(algo: CompressionAlgo): number {
  switch (algo) {
    case 'none': return COMPRESSION_NONE;
    case 'gzip': return COMPRESSION_GZIP;
    case 'zstd': return COMPRESSION_ZSTD;
  }
}

function decodeCompression(flags: number): CompressionAlgo {
  switch (flags & 0b11) {
    case COMPRESSION_NONE: return 'none';
    case COMPRESSION_GZIP: return 'gzip';
    case COMPRESSION_ZSTD: return 'zstd';
    default:
      throw new Error(`BodyCodec: unknown compression flags ${(flags & 0b11).toString(2)}`);
  }
}
