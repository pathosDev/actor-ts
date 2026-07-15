import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type {
  CompressionConfig,
  CompressionResolver,
  EncryptionConfig,
  EncryptionResolver,
} from '../object-storage/PluginConfig.js';
import type { ObjectStorageBackend } from '../object-storage/ObjectStorageBackend.js';

export interface ObjectStorageSnapshotStoreOptionsType {
  /** The underlying storage layer (S3 / Filesystem / …). */
  readonly backend: ObjectStorageBackend;
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
}

/**
 * Fluent builder for {@link ObjectStorageSnapshotStoreOptionsType}.  The
 * `backend` is required:
 *
 *     new ObjectStorageSnapshotStore(
 *       ObjectStorageSnapshotStoreOptions.create().withBackend(backend).withKeepN(2),
 *     )
 */
export class ObjectStorageSnapshotStoreOptionsBuilder extends OptionsBuilder<ObjectStorageSnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ObjectStorageSnapshotStoreOptionsBuilder()`. */
  static create(): ObjectStorageSnapshotStoreOptionsBuilder {
    return new ObjectStorageSnapshotStoreOptionsBuilder();
  }

  /** The underlying storage layer (S3 / Filesystem / …). */
  withBackend(backend: ObjectStorageBackend): this {
    return this.set('backend', backend);
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
