import { OptionsValidator } from '../../util/OptionsValidator.js';
import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import type { ObjectStorageBackend } from '../object-storage/ObjectStorageBackend.js';
import type {
  CompressionConfig,
  CompressionResolver,
  EncryptionConfig,
  EncryptionResolver,
  IntegrityConfig,
  IntegrityResolver,
} from '../object-storage/PluginConfig.js';

export type ObjectStorageDurableStateStoreOptionsType = StoreSerializerOptionsBase & {
  readonly backend: ObjectStorageBackend;
  /**
   * Whether `close()` should also close the injected `backend`.  Default
   * true — a standalone store owns the backend it was given.  Set false
   * when the backend is shared with another store (as
   * `registerObjectStoragePlugins` does) so the owner closes it once.
   */
  readonly ownsBackend?: boolean;
  readonly prefix?: string;
  readonly compression?: CompressionConfig | CompressionResolver;
  readonly encryption?: EncryptionConfig | EncryptionResolver;
  /**
   * Opt-in HMAC-SHA256 integrity protection over each body (#116).
   * Closes a tamper-in-place gap on unencrypted bodies: without this,
   * an attacker with write access to the backend bucket can flip the
   * `revision` field in the JSON and bypass CAS.  Default
   * `{ mode: 'none' }` — nothing is signed and nothing is checked.
   *
   * Setting `{ mode: 'hmac-sha256', integrityKey }` signs new writes
   * **and makes verification mandatory on read**: a body arriving
   * without a tag is refused, because the manifest bit that claims
   * "no tag here" is one of the bytes an attacker with write access
   * has just proved they control (#579).  A corpus that still holds
   * pre-integrity bodies needs {@link ObjectStorageDurableStateStoreOptionsType.allowUntaggedBodies}
   * for the length of its migration.
   */
  readonly integrity?: IntegrityConfig | IntegrityResolver;
  /**
   * Re-admit bodies that carry no integrity tag while an `integrity`
   * config is in effect — the read-then-write migration window of a
   * bucket written before integrity was enabled.  Default `false`.
   *
   * Spelled out rather than implied, because it is the single setting
   * that turns the check back off and an attacker can always produce an
   * untagged body.  Drop it once every object has been rewritten.
   */
  readonly allowUntaggedBodies?: boolean;
  /**
   * Cap on the decompressed size of a stored body in bytes — the
   * decompression-bomb guard on read (security audit #3).  Default 512 MiB
   * (`DEFAULT_MAX_DECOMPRESSED_BYTES`); `Infinity` opts out.  Raise it to
   * restore a legitimately large state blob, or lower it for a tighter bound.
   */
  readonly maxDecompressedBytes?: number;
};

/**
 * Fluent builder for {@link ObjectStorageDurableStateStoreOptionsType}.  The
 * `backend` is required:
 *
 *     new ObjectStorageDurableStateStore(
 *       ObjectStorageDurableStateStoreOptions.create().withBackend(backend).withPrefix('prod/'),
 *     )
 */
export class ObjectStorageDurableStateStoreOptionsBuilder extends StoreSerializerOptionsBuilder<ObjectStorageDurableStateStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ObjectStorageDurableStateStoreOptionsBuilder()`. */
  static create(): ObjectStorageDurableStateStoreOptionsBuilder {
    return new ObjectStorageDurableStateStoreOptionsBuilder();
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

  /** Compression — flat config or per-pid resolver.  Default: gzip. */
  withCompression(compression: CompressionConfig | CompressionResolver): this {
    return this.set('compression', compression);
  }

  /** Encryption — flat config or per-pid resolver.  Default: none. */
  withEncryption(encryption: EncryptionConfig | EncryptionResolver): this {
    return this.set('encryption', encryption);
  }

  /** Opt-in HMAC-SHA256 integrity protection over each body (#116) — signs writes and requires a tag on reads.  Default: none. */
  withIntegrity(integrity: IntegrityConfig | IntegrityResolver): this {
    return this.set('integrity', integrity);
  }

  /** Accept untagged bodies while integrity is configured — the legacy-corpus migration window (#579).  Default: false. */
  withAllowUntaggedBodies(allowUntaggedBodies = true): this {
    return this.set('allowUntaggedBodies', allowUntaggedBodies);
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
 * Validates {@link ObjectStorageDurableStateStoreOptionsType} — currently the
 * decompression cap, which admits `Infinity` (opt-out) that the generic
 * `positiveInt` helper rejects, so the rule is bespoke.
 */
export class ObjectStorageDurableStateStoreOptionsValidator extends OptionsValidator<ObjectStorageDurableStateStoreOptionsType> {
  constructor() {
    super('ObjectStorageDurableStateStoreOptions');
  }
  protected rules(s: Partial<ObjectStorageDurableStateStoreOptionsType>): void {
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
 * Accepted input for the object-storage durable-state-store constructor: the fluent
 * {@link ObjectStorageDurableStateStoreOptionsBuilder} OR a plain {@link ObjectStorageDurableStateStoreOptionsType} object.
 */
export type ObjectStorageDurableStateStoreOptions = ObjectStorageDurableStateStoreOptionsBuilder | Partial<ObjectStorageDurableStateStoreOptionsType>;
/** Value alias so `ObjectStorageDurableStateStoreOptions.create()` / `new ObjectStorageDurableStateStoreOptions()` resolve to the builder. */
export const ObjectStorageDurableStateStoreOptions = ObjectStorageDurableStateStoreOptionsBuilder;
