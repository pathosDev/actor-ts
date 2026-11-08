import {
  decodeBody,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  encodeBody,
  FLAG_ENCRYPTED,
  FLAG_INTEGRITY_HMAC,
  type DecodedBody,
  type DecodeOptions,
} from '../object-storage/BodyCodec.js';
import { activeEncryptKey, isVersionedKeyShape, resolveDecryptSubkey } from '../object-storage/Encryption.js';
import type { EncryptionConfig, PersistenceOptions } from '../PersistenceOptions.js';
import { fromBase64, toBase64 } from '../../serialization/JsonTree.js';

/**
 * Per-actor `compression()` / `encryption()` / `integrity()` for stores whose
 * payload is a text column — the SQL snapshot and durable-state stores (#1802).
 *
 * The bytes are the object-storage `BodyCodec` frame, unchanged: one wire
 * format, one HKDF derivation per persistence id, one master-key ring with its
 * version byte, so rotation and the codec's own refusals mean the same thing
 * on every backend.  Only the carrier differs: the frame is base64 behind
 * {@link SEALED_PAYLOAD_PREFIX}, in the column that already holds the JSON.
 * A binary column would be a quarter smaller and cost a schema migration on
 * every existing deployment plus a binary-binding path per driver; base64
 * touches no DDL and costs a third on sealed rows only.
 *
 * **The prefix is how the two row shapes are told apart.**  `ats1:` cannot
 * begin a JSON text — JSON starts with `{ [ " - t f n` or a digit — so a row
 * written by `encodePayload` before the hooks were turned on can never be
 * mistaken for a frame, and no second column is needed to say which it is.
 *
 * **Reading is fail-closed against what the caller asked for**, which is the
 * lesson of #965: the object-storage reader takes the frame's own flags as the
 * truth, so whoever can write a body also picks whether it is decrypted.  Here
 * an actor that asks for encryption gets a refusal for a row that is not
 * encrypted, and one that asks for integrity gets one for a row without a tag
 * — plaintext JSON included — unless the store opened its migration window
 * (`allowPlaintextRows`).
 */
export const SEALED_PAYLOAD_PREFIX = 'ats1:';

/** Store-level read policy. */
export type SealedPayloadReadPolicy = {
  /**
   * Re-admit a row that lacks the protection the caller asked for — legacy
   * plaintext JSON, or a frame written without encryption or without a tag —
   * for the read-then-write migration of an entity that turns its hooks on
   * over existing data.  Off by default: the bytes that say "not encrypted"
   * are bytes anyone with write access to the table controls.
   */
  readonly allowPlaintextRows?: boolean;
};

/**
 * Raised for a row the caller's options do not admit, and for a frame that
 * fails to decode.  The stores wrap it in their `JournalError` with the
 * location; the class is exported so a test or a caller can discriminate.
 */
export class SealedPayloadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SealedPayloadError';
  }
}

/** Whether `options` asks for anything a frame has to carry. */
export function requestsSealing(options: PersistenceOptions | undefined): boolean {
  if (options === undefined) return false;
  return (options.compression !== undefined && options.compression.algorithm !== 'none')
    || demandsEncryption(options.encryption)
    || (options.integrity !== undefined && options.integrity.mode === 'hmac-sha256');
}

/**
 * Frame `json` under `options`, or hand it back untouched when nothing is
 * asked for — so a store whose actors set no hook keeps writing exactly the
 * rows it always wrote.
 *
 * `context` is authenticated alongside the body (#612): the store passes the
 * row's address, so an authentic frame copied under another persistence id,
 * sequence number or revision fails instead of being read as that row.
 */
export async function sealPayload(
  json: string,
  persistenceId: string,
  context: string,
  options: PersistenceOptions | undefined,
): Promise<string> {
  if (!requestsSealing(options)) return json;
  const encryption = options!.encryption;
  refuseServerSideMode(encryption);
  const active = encryption ? await activeEncryptKey(encryption, persistenceId) : undefined;
  const compression = options!.compression;
  const integrity = options!.integrity;
  const frame = await encodeBody(utf8Encoder.encode(json), {
    ...(compression !== undefined
      ? { compression: compression.algorithm, compressionLevel: compression.level }
      : {}),
    ...(active !== undefined
      ? {
          encryption: {
            subKey: active.subKey,
            // Same rule as the object-storage writers: only a keyring stamps
            // its version, so a single-key frame stays the legacy shape.
            ...(isVersionedKeyShape(encryption!) ? { keyVersion: active.keyVersion } : {}),
          },
        }
      : {}),
    ...(integrity !== undefined && integrity.mode === 'hmac-sha256'
      ? { integrity: { integrityKey: integrity.integrityKey } }
      : {}),
    context,
  });
  return SEALED_PAYLOAD_PREFIX + toBase64(frame);
}

/**
 * The JSON text a stored payload carries, checked against what `options`
 * demands.  A frame is opened whatever the options say — compression alone
 * needs no key — and the codec refuses an encrypted or tagged frame it is
 * given no key for.
 *
 * @throws SealedPayloadError for a row the options do not admit, or a frame
 *   that does not decode (wrong key, tampered, moved, truncated).
 */
export async function openPayload(
  stored: string,
  persistenceId: string,
  context: string,
  options: PersistenceOptions | undefined,
  policy: SealedPayloadReadPolicy = {},
): Promise<string> {
  const encryption = options?.encryption;
  const integrity = options?.integrity;
  const wantsEncryption = demandsEncryption(encryption);
  const wantsIntegrity = integrity !== undefined && integrity.mode === 'hmac-sha256';
  const allowPlaintext = policy.allowPlaintextRows === true;
  refuseServerSideMode(encryption);

  if (!stored.startsWith(SEALED_PAYLOAD_PREFIX)) {
    if ((wantsEncryption || wantsIntegrity) && !allowPlaintext) {
      throw new SealedPayloadError(
        `the row is plaintext JSON but this actor sets ${wantsEncryption ? 'encryption()' : 'integrity()'}. `
        + 'It was either written before the hook was turned on — set allowPlaintextRows on the store '
        + 'for the read-then-write migration window — or it was written in the clear by someone with '
        + 'write access to the table.',
      );
    }
    return stored;
  }

  let frame: Uint8Array;
  try {
    frame = fromBase64(stored.slice(SEALED_PAYLOAD_PREFIX.length));
  } catch (cause) {
    throw new SealedPayloadError(`the sealed row is not valid base64: ${(cause as Error).message}`, cause);
  }
  // Checked on the flags before decoding, so the refusal names the missing
  // control rather than whichever codec check happens to trip first — an
  // unencrypted, untagged frame is also unbound, and "not context-bound" says
  // nothing about why.  The flags are attacker-controlled; reading them here
  // only ever adds a refusal, the codec still verifies everything it admits.
  if (!allowPlaintext && frame.length > 4) {
    const flags = frame[4]!;
    if (wantsEncryption && (flags & FLAG_ENCRYPTED) === 0) {
      throw new SealedPayloadError(
        'the row is a frame without encryption but this actor sets encryption(). It was either written '
        + 'before the hook was turned on — set allowPlaintextRows on the store for the migration window '
        + '— or it was replaced by someone with write access to the table (#965).',
      );
    }
    if (wantsIntegrity && (flags & FLAG_INTEGRITY_HMAC) === 0) {
      throw new SealedPayloadError(
        'the row is a frame without an integrity tag but this actor sets integrity(). It was either '
        + 'written before the hook was turned on — set allowPlaintextRows on the store for the migration '
        + 'window — or its tag was stripped by someone with write access to the table (#579).',
      );
    }
  }
  const subKeyFor = encryption ? resolveDecryptSubkey(encryption, persistenceId) : undefined;
  const decodeOptions: DecodeOptions = {
    ...(subKeyFor !== undefined ? { encryption: { subKeyFor } } : {}),
    ...(wantsIntegrity
      ? { integrity: { integrityKey: integrity.integrityKey, allowUntaggedBodies: allowPlaintext } }
      : {}),
    context,
    // Every frame these stores write is bound, so the binding is demanded
    // wherever something authenticates it.  An unbound frame was not written
    // here; under the migration window it is admitted like any other row
    // that predates the hooks.
    ...((wantsEncryption || wantsIntegrity) && !allowPlaintext ? { requireContextBinding: true } : {}),
    maxOutputBytes: DEFAULT_MAX_DECOMPRESSED_BYTES,
  };
  let decoded: DecodedBody;
  try {
    decoded = await decodeBody(frame, decodeOptions);
  } catch (cause) {
    // The codec's wording names WHICH key or tag failed — keep it in the
    // message, not only in the cause.
    throw new SealedPayloadError((cause as Error).message, cause);
  }
  return utf8Decoder.decode(decoded.payload);
}

/**
 * The address a snapshot frame is bound to (#612).  Shared by every SQL
 * snapshot store, so a frame means the same row on SQLite as on libSQL.  The
 * sequence number is an integer, so the last colon separates it even from a
 * persistence id that contains colons.
 */
export function snapshotPayloadContext(persistenceId: string, sequenceNr: number): string {
  return `snapshot:${persistenceId}:${sequenceNr}`;
}

/**
 * The address a durable-state frame is bound to (#612): the persistence id and
 * the revision the row carries.  Binding the revision stops an authentic
 * payload from being paired with another revision column.
 */
export function durableStatePayloadContext(persistenceId: string, revision: number): string {
  return `durable-state:${persistenceId}:${revision}`;
}

function demandsEncryption(encryption: EncryptionConfig | undefined): boolean {
  return encryption !== undefined && encryption.mode !== 'none';
}

/**
 * `sse-s3` / `sse-kms` ask an object store to encrypt on its side; a SQL
 * database has no such request to forward.  Writing the row in the clear
 * would be exactly the silent no-op #960 removed, so the mode is refused.
 */
function refuseServerSideMode(encryption: EncryptionConfig | undefined): void {
  if (encryption === undefined) return;
  if (encryption.mode === 'sse-s3' || encryption.mode === 'sse-kms') {
    throw new SealedPayloadError(
      `encryption mode '${encryption.mode}' is an object-storage server-side mode and has no `
      + "meaning for a SQL store; use { mode: 'client-aes256-gcm', … } or the database's own "
      + 'transparent data encryption.',
    );
  }
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
