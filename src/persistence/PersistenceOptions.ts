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
 * impl directory just to declare their own settings.  Stores that
 * don't honour these options (in-memory, SQLite, Cassandra) simply
 * ignore them.
 */

/** Compression algorithm choices honoured by stores that compress at rest. */
export type CompressionAlgo = 'none' | 'gzip' | 'zstd';

/** Compression directive — what algorithm a single write should use. */
export interface CompressionConfig {
  readonly algorithm: CompressionAlgo;
}

/**
 * Encryption directive — supports server-side modes (handed to the
 * backend as a header / param) and client-side AES-256-GCM with a
 * 32-byte master key from which a per-pid subkey is derived via HKDF.
 */
export type EncryptionConfig =
  | { readonly mode: 'none' }
  | { readonly mode: 'sse-s3' }
  | { readonly mode: 'sse-kms'; readonly kmsKeyId: string }
  | { readonly mode: 'client-aes256-gcm';
      readonly masterKey: Uint8Array;       // 32 bytes
      readonly info?: string;               // HKDF "info" string
    };

/**
 * Bag of per-call options that any persistence store may accept.  All
 * fields optional — when omitted, the store falls back to its own
 * configuration (e.g. plugin defaults / per-pid resolver).
 */
export interface PersistenceOptions {
  readonly compression?: CompressionConfig;
  readonly encryption?: EncryptionConfig;
}

/**
 * @deprecated Use `PersistenceOptions` — kept as an alias so the older
 * name doesn't break downstream typings.
 */
export type PersistenceWriteOptions = PersistenceOptions;
