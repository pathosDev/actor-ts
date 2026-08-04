import { OptionsValidator } from '../../util/OptionsValidator.js';
import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import type {
  CompressionConfig,
  CompressionResolver,
  EncryptionConfig,
  EncryptionResolver,
} from '../object-storage/PluginConfig.js';
import type { ObjectStorageBackend } from '../object-storage/ObjectStorageBackend.js';

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
