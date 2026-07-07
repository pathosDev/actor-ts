import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { ObjectStorageBackend } from '../object-storage/ObjectStorageBackend.js';
import type {
  CompressionConfig,
  CompressionResolver,
  EncryptionConfig,
  EncryptionResolver,
  IntegrityConfig,
  IntegrityResolver,
} from '../object-storage/PluginConfig.js';

export interface ObjectStorageDurableStateStoreOptionsType {
  readonly backend: ObjectStorageBackend;
  readonly prefix?: string;
  readonly compression?: CompressionConfig | CompressionResolver;
  readonly encryption?: EncryptionConfig | EncryptionResolver;
  /**
   * Opt-in HMAC-SHA256 integrity protection over each body (#116).
   * Closes a tamper-in-place gap on unencrypted bodies: without this,
   * an attacker with write access to the backend bucket can flip the
   * `revision` field in the JSON and bypass CAS.  Default `{ mode: 'none' }`
   * is back-compat (no integrity tag); set `{ mode: 'hmac-sha256',
   * integrityKey }` to protect new writes and verify reads.
   *
   * Legacy bodies without the integrity flag still decode cleanly —
   * tag is opt-in.  Migrate by reading-then-writing once integrity is
   * enabled.
   */
  readonly integrity?: IntegrityConfig | IntegrityResolver;
  /**
   * When set with an `integrity` config, decode rejects bodies that
   * DON'T carry an integrity tag.  Use after a deployment has been
   * fully migrated so an attacker can't downgrade by re-writing a
   * body without the tag.
   */
  readonly requireIntegrity?: boolean;
}

/**
 * Fluent builder for {@link ObjectStorageDurableStateStoreOptionsType}.  The
 * `backend` is required:
 *
 *     new ObjectStorageDurableStateStore(
 *       ObjectStorageDurableStateStoreOptions.create().withBackend(backend).withPrefix('prod/'),
 *     )
 */
export class ObjectStorageDurableStateStoreOptionsBuilder extends OptionsBuilder<ObjectStorageDurableStateStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ObjectStorageDurableStateStoreOptionsBuilder()`. */
  static create(): ObjectStorageDurableStateStoreOptionsBuilder {
    return new ObjectStorageDurableStateStoreOptionsBuilder();
  }

  /** The underlying storage layer (S3 / Filesystem / …). */
  withBackend(backend: ObjectStorageBackend): this {
    return this.set('backend', backend);
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

  /** Opt-in HMAC-SHA256 integrity protection over each body (#116).  Default: none. */
  withIntegrity(integrity: IntegrityConfig | IntegrityResolver): this {
    return this.set('integrity', integrity);
  }

  /** Reject reads of bodies lacking an integrity tag — post-migration downgrade protection. */
  withRequireIntegrity(requireIntegrity = true): this {
    return this.set('requireIntegrity', requireIntegrity);
  }
}

/**
 * Accepted input for the object-storage durable-state-store constructor: the fluent
 * {@link ObjectStorageDurableStateStoreOptionsBuilder} OR a plain {@link ObjectStorageDurableStateStoreOptionsType} object.
 */
export type ObjectStorageDurableStateStoreOptions = ObjectStorageDurableStateStoreOptionsBuilder | Partial<ObjectStorageDurableStateStoreOptionsType>;
/** Value alias so `ObjectStorageDurableStateStoreOptions.create()` / `new ObjectStorageDurableStateStoreOptions()` resolve to the builder. */
export const ObjectStorageDurableStateStoreOptions = ObjectStorageDurableStateStoreOptionsBuilder;
