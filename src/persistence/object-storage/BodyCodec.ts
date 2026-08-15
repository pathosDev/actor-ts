import { match } from 'ts-pattern';
import { compressorFor, type CompressionAlgo } from './Compression.js';
import { aesGcmDecrypt, aesGcmEncryptSafe, IV_LENGTH, MAX_KEY_VERSION } from './Encryption.js';
import { constantTimeEqual, HMAC_TAG_LENGTH, hmacSha256 } from './Integrity.js';

/**
 * Wire-format for snapshot / durable-state bodies stored in object storage.
 *
 *   Bytes 0..3   : MAGIC          "ATS1"  (actor-ts persistence v1)
 *   Byte  4      : flags          bit0..1 = compression: 0=none, 1=gzip, 2=zstd
 *                                  bit2     = encrypted
 *                                  bit3     = key-versioned (#8 — master-key rotation)
 *                                  bit4     = integrity HMAC tag appended (#116)
 *                                  bit5     = context-bound (#612 — the storage
 *                                             key is authenticated alongside
 *                                             the body)
 *                                  bit6..7  = unallocated
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
 * Integrity (#116) deliberately does NOT get the same treatment.  Bit4
 * is attacker-controlled like every other manifest byte, so reading an
 * absent tag as "this body simply predates integrity" hands anyone with
 * write access a downgrade: clear bit4, drop the 16 tag bytes, and the
 * verification the operator configured never runs (#579).  A decode
 * given an `integrityKey` therefore REQUIRES a tag.  A corpus that
 * still holds pre-integrity bodies re-admits them for the duration of
 * its read-then-write migration with `allowUntaggedBodies: true`.
 *
 * **Context binding (#612)** takes the middle road between those two.
 * Neither authenticator said anything about *where* a body lives:
 * AES-GCM's tag and the HMAC both cover the bytes and nothing else, so
 * an authentic body moved to another storage key still verified.  Bit5
 * marks a body whose storage key went into the AES-GCM AAD and into the
 * HMAC input, and it decodes backwards-compatibly — an older body has
 * the bit clear and is verified exactly as before.  That leaves a
 * downgrade for as long as such bodies may exist, since bit5 is a
 * manifest byte like any other: `requireContextBinding` is what closes
 * it once the corpus has been rewritten.
 */

export const ATS1_MAGIC = new Uint8Array([0x41, 0x54, 0x53, 0x31]); // "ATS1"

export const COMPRESSION_NONE = 0b00;
export const COMPRESSION_GZIP = 0b01;
export const COMPRESSION_ZSTD = 0b10;
export const FLAG_ENCRYPTED = 0b100;
/**
 * When set with FLAG_ENCRYPTED, the byte after `flags` is a 0..255 key version.
 *
 * One byte is the whole version space, and it stays that way (#111).  It
 * is not a cap on how often a deployment may rotate — it caps how many
 * versions may be *live in one corpus at once*, and a completed
 * `reEncryptObjectStorage` sweep collapses the corpus onto the active
 * version and frees every other number for reuse.  A ring that would
 * make the space ambiguous is refused up front by
 * `validateMasterKeyRing`.
 *
 * A wide-version flag was considered and dropped.  Only three bits of
 * this byte are left, spending one on a case that a sweep already
 * resolves is a poor trade, and if the format ever genuinely outgrows
 * one byte the honest move is a new magic (`ATS2`) rather than a fourth
 * conditional field in a header whose length already depends on two
 * other bits.
 */
export const FLAG_KEY_VERSIONED = 0b1000;
/** When set, the last {@link HMAC_TAG_LENGTH} bytes are an HMAC-SHA256 over the rest. */
export const FLAG_INTEGRITY_HMAC = 0b10000;
/**
 * When set, the body's storage key was authenticated along with its
 * bytes (#612) — as AES-GCM additional-authenticated-data on an
 * encrypted body, as a length-prefixed context on the HMAC input, or
 * both when both are configured.
 *
 * The bit is only ever set where there is an authenticator to carry it.
 * A body with neither encryption nor an integrity tag has nothing that
 * could bind a key, so a plain body claiming this flag is a forgery and
 * `decodeBody` rejects it rather than letting the claim stand
 * unverified.
 */
export const FLAG_CONTEXT_BOUND = 0b100000;

/**
 * Default cap on the decompressed size of a stored body (512 MiB).  Bounds a
 * decompression bomb on read (security audit #3) — a real snapshot /
 * durable-state blob is far smaller.  Override per-decode via
 * {@link DecodeOptions.maxOutputBytes} (`Infinity` options out).
 */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

export type EncodeOptions = {
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
  /**
   * The storage key this body is being written to, bound into whichever
   * authenticators are configured (#612) and marked with
   * {@link FLAG_CONTEXT_BOUND}.
   *
   * Without it a tag says "these bytes are authentic" and stops there,
   * so an attacker with bucket write access can move an authentic body
   * to a different key and have it verify — most sharply in the
   * unencrypted-plus-HMAC configuration, where the integrity key is one
   * flat deployment-wide secret and one `persistenceId`'s body replayed
   * onto another's key comes back as that other pid's state.
   *
   * Ignored when the body carries neither encryption nor integrity:
   * there is nothing to bind it to, and setting the flag on a body no
   * one authenticates would be a claim the decoder cannot check.
   */
  readonly context?: string;
};

/**
 * Subkey resolver — given the version byte the manifest carries, return
 * the subkey to decrypt with.  For a single-key config the resolver
 * ignores the version and always returns the same subkey; for a
 * keyring it dispatches.  Returning `null` means "I don't have a key
 * for that version" — the codec then throws a clear error.
 */
export type SubKeyResolver = (keyVersion: number) => Promise<Uint8Array | null>;

export type DecodeOptions = {
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
   * Verification key for the appended HMAC tag.  Supplying it is the
   * assertion *"this corpus is integrity-protected"*, and the codec
   * holds the body to it both ways: a body carrying
   * `FLAG_INTEGRITY_HMAC` is verified against the key, and a body
   * carrying no tag is REJECTED — the flag that claims there is no tag
   * sits in the same bytes the tamperer just wrote (#579).
   *
   * `allowUntaggedBodies: true` re-admits untagged bodies for the
   * migration window of a corpus written before integrity was enabled.
   * That is the only route back to unverified reads, and it has to be
   * spelled out: no combination of *unset* options can silently turn
   * verification off.
   */
  readonly integrity?: {
    readonly integrityKey: Uint8Array;
    readonly allowUntaggedBodies?: boolean;
  };
  /**
   * The storage key this body was fetched from — the verify-side
   * counterpart of {@link EncodeOptions.context} (#612).
   *
   * Used only when the body carries {@link FLAG_CONTEXT_BOUND}, so
   * supplying it never breaks a body written before the binding
   * existed.  Required when the body does carry the flag: the decoder
   * refuses rather than silently verifying a bound body as if it were
   * unbound, which would throw away exactly the property the flag
   * announces.
   */
  readonly context?: string;
  /**
   * Refuse a body that is not context-bound (#612).
   *
   * The bit that says "this body is bound" is a manifest byte, and the
   * manifest is written by whoever wrote the body.  So while unbound
   * bodies are still accepted, an attacker holding one authentic
   * pre-binding body can replay it wherever they like and the binding
   * protects nothing — the same downgrade #579 closed for the integrity
   * tag.  Flip this on once every object in the corpus has been
   * rewritten with a binding.
   *
   * Requires {@link context}: demanding a guarantee there is no way to
   * check is a configuration error, not a stricter setting, and is
   * rejected as one.
   */
  readonly requireContextBinding?: boolean;
  /**
   * Cap on the decompressed payload size in bytes.  Defaults to
   * {@link DEFAULT_MAX_DECOMPRESSED_BYTES}; pass `Infinity` to disable.
   * Guards against a decompression bomb in a tampered / hostile stored body
   * (security audit #3).
   */
  readonly maxOutputBytes?: number;
};

export type DecodedBody = {
  readonly compression: CompressionAlgo;
  readonly encrypted: boolean;
  /** 0..255 when the body carried a key-version manifest, else `undefined`. */
  readonly keyVersion?: number;
  /** Whether the body's storage key was authenticated with it (#612). */
  readonly contextBound: boolean;
  readonly payload: Uint8Array;     // plaintext, decompressed
};

const utf8 = new TextEncoder();

/**
 * Encode a JSON-stringified payload with the framing above.  Returns a
 * fresh `Uint8Array` ready to ship to the backend.
 */
export async function encodeBody(jsonBytes: Uint8Array, options: EncodeOptions = {}): Promise<Uint8Array> {
  const algo = options.compression ?? 'none';
  const subKey = options.encryption?.subKey;
  const keyVersion = options.encryption?.keyVersion;
  const integrityKey = options.integrity?.integrityKey;
  // A context can only be bound to something that authenticates it.  On a
  // body with neither encryption nor a tag it is dropped rather than
  // flagged — the flag would announce a property nothing can verify.
  const context = (subKey || integrityKey) && suppliedContext(options.context) !== undefined
    ? utf8.encode(options.context!)
    : undefined;

  // Step 1: compress (if requested).  Encryption-after-compression
  // because compression-after-encryption would defeat compression
  // (ciphertext is high-entropy) AND it's the order that protects
  // against CRIME-style side channels.
  const compressed = await compressorFor(algo).compress(jsonBytes, options.compressionLevel);

  // Step 2: encrypt (if requested).  IV goes into the manifest.
  let bodyBeforeIntegrity: Uint8Array;
  if (subKey) {
    if (keyVersion !== undefined) {
      if (!Number.isInteger(keyVersion) || keyVersion < 0 || keyVersion > MAX_KEY_VERSION) {
        throw new Error(
          `BodyCodec: keyVersion must be an integer in [0, ${MAX_KEY_VERSION}], got ${keyVersion}`,
        );
      }
    }
    // The IV is generated inside `aesGcmEncryptSafe`, not here, so this
    // path has no IV of its own to accidentally hoist out of the call
    // and reuse across bodies (#110).
    const { iv, ciphertext } = await aesGcmEncryptSafe(subKey, compressed, context);
    const versioned = keyVersion !== undefined;
    let flags = encodeCompression(algo) | FLAG_ENCRYPTED;
    if (versioned) flags |= FLAG_KEY_VERSIONED;
    if (integrityKey) flags |= FLAG_INTEGRITY_HMAC;
    if (context) flags |= FLAG_CONTEXT_BOUND;
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
    if (context) flags |= FLAG_CONTEXT_BOUND;
    bodyBeforeIntegrity = new Uint8Array(ATS1_MAGIC.length + 1 + compressed.length);
    bodyBeforeIntegrity.set(ATS1_MAGIC, 0);
    bodyBeforeIntegrity[4] = flags;
    bodyBeforeIntegrity.set(compressed, 5);
  }

  // Step 4 (optional): append the HMAC-SHA256 integrity tag (#116).
  // Covers the manifest header + payload — any tampering of either
  // invalidates the tag — plus the storage key when one was supplied,
  // so the tag does not travel with the bytes to another key (#612).
  if (integrityKey) {
    const tag = await hmacSha256(integrityKey, bodyBeforeIntegrity, context);
    const out = new Uint8Array(bodyBeforeIntegrity.length + tag.length);
    out.set(bodyBeforeIntegrity, 0);
    out.set(tag, bodyBeforeIntegrity.length);
    return out;
  }
  return bodyBeforeIntegrity;
}

/** Decode a body produced by `encodeBody` back into the plaintext payload. */
export async function decodeBody(framed: Uint8Array, options: DecodeOptions = {}): Promise<DecodedBody> {
  if (framed.length < 5 || !magicMatches(framed)) {
    throw new Error('BodyCodec: unrecognised body — expected ATS1 magic bytes.');
  }
  const flags = framed[4]!;
  const compression = decodeCompression(flags);
  const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
  const versioned = (flags & FLAG_KEY_VERSIONED) !== 0;
  const hasIntegrity = (flags & FLAG_INTEGRITY_HMAC) !== 0;
  const contextBound = (flags & FLAG_CONTEXT_BOUND) !== 0;

  // Context binding (#612), resolved before any crypto runs so a
  // configuration mistake reads as one instead of as a tag failure.
  if (contextBound && !encrypted && !hasIntegrity) {
    throw new Error(
      'BodyCodec: body claims FLAG_CONTEXT_BOUND but carries neither encryption nor an '
      + 'integrity tag, so nothing binds its storage key.  The flag was set by whoever '
      + 'wrote the body and cannot be verified.',
    );
  }
  const givenContext = suppliedContext(options.context);
  if (options.requireContextBinding === true && givenContext === undefined) {
    throw new Error(
      'BodyCodec: requireContextBinding was set but no context was supplied — there is '
      + 'nothing to verify the binding against.',
    );
  }
  if (options.requireContextBinding === true && !contextBound) {
    throw new Error(
      'BodyCodec: body is not context-bound but requireContextBinding was set for '
      + 'decoding.  It was either written before context binding was enabled — clear '
      + 'requireContextBinding for the read-then-write migration window — or it is an '
      + 'authentic body replayed onto a storage key it was never written to.',
    );
  }
  if (contextBound && givenContext === undefined) {
    throw new Error(
      'BodyCodec: body carries FLAG_CONTEXT_BOUND but no context was supplied for '
      + 'decoding.',
    );
  }
  const context = contextBound ? utf8.encode(givenContext!) : undefined;

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
    if (!options.integrity?.integrityKey) {
      throw new Error(
        'BodyCodec: body carries FLAG_INTEGRITY_HMAC but no integrityKey was supplied for decoding.',
      );
    }
    const sigOffset = framed.length - HMAC_TAG_LENGTH;
    const expected = framed.subarray(sigOffset);
    const signed = framed.subarray(0, sigOffset);
    const actual = await hmacSha256(options.integrity.integrityKey, signed, context);
    if (!constantTimeEqual(actual, expected)) {
      throw new Error('BodyCodec: integrity check failed — body tampered or wrong integrity key.');
    }
    bodyForRest = signed;
  } else if (options.integrity?.integrityKey !== undefined && options.integrity.allowUntaggedBodies !== true) {
    // An integrityKey was supplied, so this corpus is protected — and a
    // body without a tag is either older than the protection or an
    // attacker's downgrade.  The two are indistinguishable from here,
    // which is exactly why the safe reading is the default one (#579).
    throw new Error(
      'BodyCodec: body carries no integrity tag but an integrityKey was supplied for '
      + 'decoding.  It was either written before integrity was enabled — set '
      + 'allowUntaggedBodies: true for the read-then-write migration window — or its '
      + 'tag was stripped as part of a downgrade attack.',
    );
  }

  const maxOut = options.maxOutputBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
  let payload: Uint8Array;
  let keyVersion: number | undefined;
  if (encrypted) {
    if (!options.encryption) {
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
    const enc = options.encryption as
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

    const compressedPlaintext = await aesGcmDecrypt(subKey, iv, ciphertext, context);
    payload = await compressorFor(compression).decompress(compressedPlaintext, maxOut);
  } else {
    const compressedSlice = bodyForRest.subarray(5);
    payload = await compressorFor(compression).decompress(compressedSlice, maxOut);
  }

  return {
    compression,
    encrypted,
    ...(keyVersion !== undefined ? { keyVersion } : {}),
    contextBound,
    payload,
  };
}

/* ----------------------------- internals -------------------------------- */

/**
 * Normalise a caller-supplied context, treating the empty string as no
 * context at all.
 *
 * A zero-length context would otherwise reach the wire as a
 * zero-length AES-GCM AAD, and that is not portably the same thing as
 * omitting the AAD — the tag a runtime computes for one need not match
 * the other.  A body written that way on Bun might fail to decrypt on
 * Deno.  Since no storage key is ever empty, nothing is lost by ruling
 * the case out here instead.
 */
function suppliedContext(context: string | undefined): string | undefined {
  return context !== undefined && context.length > 0 ? context : undefined;
}

function magicMatches(buffer: Uint8Array): boolean {
  return buffer[0] === ATS1_MAGIC[0]
    && buffer[1] === ATS1_MAGIC[1]
    && buffer[2] === ATS1_MAGIC[2]
    && buffer[3] === ATS1_MAGIC[3];
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
