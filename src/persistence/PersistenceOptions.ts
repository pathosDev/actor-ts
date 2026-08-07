/**
 * Per-call options for any `SnapshotStore` / `DurableStateStore`
 * operation — primarily a way for an actor to declare its **own**
 * compression / encryption preferences, overriding any plugin-level
 * defaults.  Threaded through both write and read paths because
 * client-side encryption needs the master key on both sides (the store
 * has no other way to derive the per-pid subkey).  Compression on the
 * read side is informational only — the body-codec recovers it from the
 * payload header — and stores ignore it there.
 *
 * The two backing types (`CompressionConfig`, `EncryptionConfig`) are
 * defined here, at the persistence-layer top level, rather than inside
 * `object-storage/`.  The reason: actors don't know which concrete
 * store is wired up, and we don't want them to import from a specific
 * impl directory just to declare their own options.  Stores that
 * don't honour these options (in-memory, SQLite, Cassandra) simply
 * ignore them.
 */

/** Compression algorithm choices honoured by stores that compress at rest. */
export type CompressionAlgo = 'none' | 'gzip' | 'zstd';

/** Compression directive — what algorithm a single write should use. */
export type CompressionConfig = {
  readonly algorithm: CompressionAlgo;
  /**
   * Optional compression level — higher trades CPU for a smaller body.
   * Algorithm-specific; out-of-range values are clamped, `undefined`
   * uses the implementation default:
   *   - `gzip`: 0–9 (default 6).
   *   - `zstd`: 1–22 (default 3).  Levels ≥20 ("ultra") use large
   *     windows the pure-JS `fzstd` decompress-fallback may be unable to
   *     read (it caps at a 32 MB window) — keep ≤19 if any reader might
   *     run on a runtime without native zstd (i.e. neither Bun nor
   *     Node).
   *   - `none`: ignored.
   *
   * The level is an encoder-only setting: it is NOT recorded on the wire
   * (the body manifest stores the algorithm, not the level) and
   * decompression never needs it.  Changing the level therefore needs no
   * migration — old bodies keep decoding, new bodies use the new level,
   * and the two mix freely in one bucket.
   */
  readonly level?: number;
};

/**
 * One entry in a versioned master-key ring used by client-side
 * AES-256-GCM (#8 — master-key rotation).  Versions are 0..255 — a
 * single byte of version travels in the body's manifest so decrypt
 * can pick the matching master at read time.
 *
 * **Why versions?**  Rotation is a fact of life — the operator wants
 * to retire an old key without re-encrypting every blob in the bucket
 * at once.  The keyring lets a deployment carry the new key
 * (`active`) **plus** every old key (`retired`) it might still need
 * to decrypt; new writes use `active`, reads dispatch on the
 * version byte the manifest carries.  Once every blob has been
 * re-encrypted at the new version (e.g. via a re-encryption sweep),
 * the corresponding `retired` entry can be dropped.
 */
export type MasterKeyRingEntry = {
  /** 0..255 — embedded in the body manifest by `BodyCodec`. */
  readonly version: number;
  /** 32 bytes (AES-256). */
  readonly key: Uint8Array;
};

export type MasterKeyRing = {
  /** Currently-active key — every new write encrypts under this one. */
  readonly active: MasterKeyRingEntry;
  /**
   * Older keys still used for decryption of historical blobs.  Every
   * version a manifest may reference must appear here OR as `active`.
   */
  readonly retired?: ReadonlyArray<MasterKeyRingEntry>;
};

/**
 * Encryption directive — supports server-side modes (handed to the
 * backend as a header / param) and client-side AES-256-GCM with a
 * 32-byte master key from which a per-pid subkey is derived via HKDF.
 *
 * The client-side variant accepts either a single `masterKey` (legacy,
 * implicitly version 0 — backwards compatible with bodies written
 * before rotation support landed) or a `masterKeys` ring with one
 * `active` entry plus optional `retired` entries (#8).
 *
 * ### Why `info` is mandatory (#108)
 *
 * `info` is HKDF's context-binding input (RFC 5869 §3.2): it is mixed
 * into the key-derivation alongside the salt, so two derivations that
 * differ only in `info` yield unrelated subkeys.  It used to be
 * optional, defaulting to a constant baked into the framework — which
 * meant every deployment that shared a master key (staging restored
 * from a production dump, a DR region, a per-tenant fan-out that reuses
 * one master) also shared **the exact same subkey per `persistenceId`**.
 * Cross-environment key separation silently did not exist, and nothing
 * in the config hinted at it.
 *
 * Making the field required moves that decision to the operator, where
 * it belongs.  A compile error is a far better outcome than a default
 * that quietly collapses two security domains into one.
 *
 * **Choosing a value.**  Encode *environment + purpose + version*, most
 * specific first, and treat it as immutable once data exists:
 *
 *   - `'acme/prod/snapshot/v1'`
 *   - `'acme/staging/snapshot/v1'`
 *   - `'acme/prod/durable-state/v1'`
 *
 * Different environments MUST get different strings even when they run
 * on the same master key.  Different payload kinds (snapshots vs.
 * durable state) SHOULD, so a compromise of one derivation context does
 * not extend to the other.  The trailing version is there so a future
 * derivation-context rotation has somewhere to go.
 *
 * **`info` is not recorded on the wire.**  Unlike the master-key
 * version, no manifest byte says which `info` a body was written under,
 * so changing it makes every existing body undecryptable until a
 * re-encryption sweep rewrites them — pass `newInfo` to
 * `reEncryptObjectStorage` for that.  Pick the value before the first
 * write.
 */
export type EncryptionConfig =
  | { readonly mode: 'none' }
  | { readonly mode: 'sse-s3' }
  | { readonly mode: 'sse-kms'; readonly kmsKeyId: string }
  | { readonly mode: 'client-aes256-gcm';
      readonly masterKey: Uint8Array;       // 32 bytes — single-key shorthand (version 0)
      readonly info: string;                // HKDF "info" string — deployment-specific, see above
    }
  | { readonly mode: 'client-aes256-gcm';
      readonly masterKeys: MasterKeyRing;   // multi-version (rotation)
      readonly info: string;
    };

/**
 * Body integrity directive (#116).  Protects unencrypted bodies
 * against tamper-in-place at the object-storage layer; encrypted
 * bodies are already protected by AES-GCM's auth tag.
 *
 *   - `mode: 'none'` (default) — back-compat, no integrity check.
 *   - `mode: 'hmac-sha256'`    — HMAC-SHA256 over the payload with
 *     `integrityKey`, truncated to 16 bytes (128-bit MAC strength),
 *     appended to the body and verified at decode.  Key is separate
 *     from the encryption master key — the threat here is tampering,
 *     not confidentiality.
 *
 * Bodies written before integrity landed have the integrity flag
 * unset and decode normally even when integrity is configured on the
 * reader (legacy-safe).  Use the `requireIntegrity` decode option
 * (per-call or per-store) to refuse such bodies once a deployment
 * has been fully migrated.
 */
export type IntegrityConfig =
  | { readonly mode: 'none' }
  | {
      readonly mode: 'hmac-sha256';
      /** 32 bytes — fed to HMAC-SHA256 as the signing key. */
      readonly integrityKey: Uint8Array;
    };

/**
 * Bag of per-call options that any persistence store may accept.  All
 * fields optional — when omitted, the store falls back to its own
 * configuration (e.g. plugin defaults / per-pid resolver).
 */
export type PersistenceOptions = {
  readonly compression?: CompressionConfig;
  readonly encryption?: EncryptionConfig;
  readonly integrity?: IntegrityConfig;
};

/**
 * @deprecated Use `PersistenceOptions` — kept as an alias so the older
 * name doesn't break downstream typings.
 */
export type PersistenceWriteOptions = PersistenceOptions;
