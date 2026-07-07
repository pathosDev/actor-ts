import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type {
  CompressionConfig,
  CompressionResolver,
  EncryptionConfig,
  EncryptionResolver,
} from '../object-storage/PluginConfig.js';
import type { ObjectStorageBackend } from '../object-storage/ObjectStorageBackend.js';
import type { ObjectStorageSnapshotStoreSettings } from './ObjectStorageSnapshotStore.js';

/**
 * Fluent builder for {@link ObjectStorageSnapshotStoreSettings}.  The
 * `backend` is required:
 *
 *     new ObjectStorageSnapshotStore(
 *       ObjectStorageSnapshotStoreOptions.create().withBackend(backend).withKeepN(2),
 *     )
 */
export class ObjectStorageSnapshotStoreOptions extends OptionsBuilder<ObjectStorageSnapshotStoreSettings> {
  /** Start a fresh builder.  Equivalent to `new ObjectStorageSnapshotStoreOptions()`. */
  static create(): ObjectStorageSnapshotStoreOptions {
    return new ObjectStorageSnapshotStoreOptions();
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
}
