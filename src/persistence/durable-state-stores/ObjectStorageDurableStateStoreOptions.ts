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
import type { ObjectStorageDurableStateStoreSettings } from './ObjectStorageDurableStateStore.js';

/**
 * Fluent builder for {@link ObjectStorageDurableStateStoreSettings}.  The
 * `backend` is required:
 *
 *     new ObjectStorageDurableStateStore(
 *       ObjectStorageDurableStateStoreOptions.create().withBackend(backend).withPrefix('prod/'),
 *     )
 */
export class ObjectStorageDurableStateStoreOptions extends OptionsBuilder<ObjectStorageDurableStateStoreSettings> {
  /** Start a fresh builder.  Equivalent to `new ObjectStorageDurableStateStoreOptions()`. */
  static create(): ObjectStorageDurableStateStoreOptions {
    return new ObjectStorageDurableStateStoreOptions();
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
