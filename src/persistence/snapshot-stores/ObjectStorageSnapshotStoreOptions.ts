import { OptionsValidator } from '../../util/OptionsValidator.js';
import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import type {
  CompressionConfig,
  CompressionResolver,
  EncryptionConfig,
  EncryptionResolver,
  IntegrityConfig,
  IntegrityResolver,
} from '../object-storage/PluginConfig.js';
import type { ObjectStorageBackend } from '../object-storage/ObjectStorageBackend.js';

/**
 * Built-in default for {@link ObjectStorageSnapshotStoreOptionsType.keepN} —
 * how many snapshots survive per `persistenceId`.
 *
 * Object-storage-specific and therefore *not* in `src/persistence/Constants.ts`:
 * the durable-state store has no history to retain, so this is one options
 * type's field default rather than a value two of them share.  It is named
 * because `reference.conf` publishes it (`…object-storage.keep-n`, #873) and
 * `DocumentedDefaults` compares the published literal against a constant.
 */
export const DEFAULT_SNAPSHOT_KEEP_N = 3;

export type ObjectStorageSnapshotStoreOptionsType = StoreSerializerOptionsBase & {
  /** The underlying storage layer (S3 / Filesystem / …). */
  readonly backend: ObjectStorageBackend;
  /**
   * Whether `close()` should also close the injected `backend`.  Default
   * true — a standalone store owns the backend it was given.  Set false
   * when the same backend is shared with another store (as
   * `registerObjectStoragePlugins` does across the snapshot + durable-state
   * stores) so one store's `close()` can't tear the backend out from under
   * the other; the owner closes it once.
   */
  readonly ownsBackend?: boolean;
  /** Prepended to every key before the persistenceId.  Default: ''. */
  readonly prefix?: string;
  /** Keep this many snapshots per persistenceId; older ones are deleted on save.  Default: 3. */
  readonly keepN?: number;
  /** Compression — flat config or per-pid resolver.  Default: `{ algorithm: 'gzip' }`. */
  readonly compression?: CompressionConfig | CompressionResolver;
  /** Encryption — flat config or per-pid resolver.  Default: `{ mode: 'none' }`. */
  readonly encryption?: EncryptionConfig | EncryptionResolver;
  /**
   * Opt-in HMAC-SHA256 integrity protection over each snapshot body
   * (#116).  Default `{ mode: 'none' }` — nothing is signed and nothing
   * is checked.
   *
   * A snapshot is not an ordinary record: recovery folds events **on
   * top of** it, so whoever can rewrite one dictates the state an actor
   * comes back as.  `Replay` bounds the `sequenceNr` a snapshot may
   * claim, but nothing else authenticates the `state` payload — that is
   * what this closes (#613).
   *
   * Setting `{ mode: 'hmac-sha256', integrityKey }` signs new writes
   * **and makes verification mandatory on read**: a body arriving
   * without a tag is refused, because the manifest bit that claims "no
   * tag here" is one of the bytes an attacker with write access
   * controls (#579).  A bucket that still holds pre-integrity snapshots
   * needs {@link ObjectStorageSnapshotStoreOptionsType.allowUntaggedBodies}
   * for the length of its migration.
   */
  readonly integrity?: IntegrityConfig | IntegrityResolver;
  /**
   * Re-admit snapshot bodies that carry no integrity tag while an
   * `integrity` config is in effect — the migration window of a bucket
   * written before integrity was enabled.  Default `false`.
   *
   * Snapshots migrate by themselves: `keepN` prunes the untagged ones
   * as new tagged snapshots are taken, so the window can usually be
   * closed after `keepN` saves per persistenceId rather than after an
   * explicit rewrite sweep.
   */
  readonly allowUntaggedBodies?: boolean;
  /**
   * Refuse a snapshot body that is not bound to the storage key it was
   * read from (#612).  Default `false`.
   *
   * Writes bind unconditionally; this is about refusing unbound reads.
   * The snapshot key carries both the `persistenceId` and the sequence
   * number, so an unbound snapshot is one that could have been lifted
   * from another pid — or another point in this pid's history — and
   * dropped here.  Opt in once the bucket holds only bound snapshots,
   * which for a pruning store is `keepN` saves per persistenceId.
   *
   * Inert without an `encryption` or `integrity` config.
   */
  readonly requireContextBinding?: boolean;
  /**
   * Cap on the decompressed size of a stored body in bytes — the
   * decompression-bomb guard on read (security audit #3).  Default 512 MiB
   * (`DEFAULT_MAX_DECOMPRESSED_BYTES`); `Infinity` opts out.  Raise it to
   * restore a legitimately large snapshot, or lower it for a tighter bound.
   */
  readonly maxDecompressedBytes?: number;
};

/**
 * Fluent builder for {@link ObjectStorageSnapshotStoreOptionsType}.  The
 * `backend` is required:
 *
 *     new ObjectStorageSnapshotStore(
 *       ObjectStorageSnapshotStoreOptions.create().withBackend(backend).withKeepN(2),
 *     )
 */
export class ObjectStorageSnapshotStoreOptionsBuilder extends StoreSerializerOptionsBuilder<ObjectStorageSnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ObjectStorageSnapshotStoreOptionsBuilder()`. */
  static create(): ObjectStorageSnapshotStoreOptionsBuilder {
    return new ObjectStorageSnapshotStoreOptionsBuilder();
  }

  /** The underlying storage layer (S3 / Filesystem / …). */
  withBackend(backend: ObjectStorageBackend): this {
    return this.set('backend', backend);
  }

  /** Whether `close()` also closes the injected backend.  Default true; set false when the backend is shared/owned elsewhere. */
  withOwnsBackend(ownsBackend: boolean): this {
    return this.set('ownsBackend', ownsBackend);
  }

  /** Key prefix prepended before the persistenceId.  Default: ''. */
  withPrefix(prefix: string): this {
    return this.set('prefix', prefix);
  }

  /** Keep this many snapshots per persistenceId; older ones are pruned on save.  Default: 3. */
  withKeepN(keepN: number): this {
    return this.set('keepN', keepN);
  }

  /** Compression — flat config or per-pid resolver.  Default: gzip. */
  withCompression(compression: CompressionConfig | CompressionResolver): this {
    return this.set('compression', compression);
  }

  /** Encryption — flat config or per-pid resolver.  Default: none. */
  withEncryption(encryption: EncryptionConfig | EncryptionResolver): this {
    return this.set('encryption', encryption);
  }

  /** Opt-in HMAC-SHA256 integrity protection over each snapshot body (#116) — signs writes and requires a tag on reads.  Default: none. */
  withIntegrity(integrity: IntegrityConfig | IntegrityResolver): this {
    return this.set('integrity', integrity);
  }

  /** Accept untagged snapshot bodies while integrity is configured — the legacy-corpus migration window (#579).  Default: false. */
  withAllowUntaggedBodies(allowUntaggedBodies = true): this {
    return this.set('allowUntaggedBodies', allowUntaggedBodies);
  }

  /** Refuse snapshot bodies not bound to the storage key they were read from (#612) — turn on once the bucket is rewritten.  Default: false. */
  withRequireContextBinding(requireContextBinding = true): this {
    return this.set('requireContextBinding', requireContextBinding);
  }

  /**
   * Cap on the decompressed body size (bytes) — decompression-bomb guard
   * (#3).  Default 512 MiB; `Infinity` opts out.
   */
  withMaxDecompressedBytes(bytes: number): this {
    return this.set('maxDecompressedBytes', bytes);
  }
}

/**
 * Validates {@link ObjectStorageSnapshotStoreOptionsType} — currently the
 * decompression cap, which admits `Infinity` (opt-out) that the generic
 * `positiveInt` helper rejects, so the rule is bespoke.
 */
export class ObjectStorageSnapshotStoreOptionsValidator extends OptionsValidator<ObjectStorageSnapshotStoreOptionsType> {
  constructor() {
    super('ObjectStorageSnapshotStoreOptions');
  }
  protected rules(s: Partial<ObjectStorageSnapshotStoreOptionsType>): void {
    const { maxDecompressedBytes } = s;
    if (
      maxDecompressedBytes !== undefined && maxDecompressedBytes !== Infinity &&
      (typeof maxDecompressedBytes !== 'number' || !Number.isInteger(maxDecompressedBytes) || maxDecompressedBytes < 1)
    ) {
      this.fail('maxDecompressedBytes', 'must be a positive integer or Infinity', maxDecompressedBytes);
    }
  }
}

/**
 * Accepted input for the object-storage snapshot-store constructor: the fluent
 * {@link ObjectStorageSnapshotStoreOptionsBuilder} OR a plain {@link ObjectStorageSnapshotStoreOptionsType} object.
 */
export type ObjectStorageSnapshotStoreOptions = ObjectStorageSnapshotStoreOptionsBuilder | Partial<ObjectStorageSnapshotStoreOptionsType>;
/** Value alias so `ObjectStorageSnapshotStoreOptions.create()` / `new ObjectStorageSnapshotStoreOptions()` resolve to the builder. */
export const ObjectStorageSnapshotStoreOptions = ObjectStorageSnapshotStoreOptionsBuilder;
