import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type {
  CompressionConfig,
  CompressionResolver,
  EncryptionConfig,
  EncryptionResolver,
} from './PluginConfig.js';
import type {
  ObjectStorageBackendSpec,
  ObjectStoragePluginSettings,
} from './ObjectStoragePlugin.js';

/**
 * Fluent builder for {@link ObjectStoragePluginSettings}.  The `backend`
 * spec is required:
 *
 *     registerObjectStoragePlugins(ext,
 *       ObjectStoragePluginOptions.create()
 *         .withBackend({ kind: 's3', bucket: 'my-app', region: 'eu-central-1' })
 *         .withCompression({ algorithm: 'zstd' }))
 *
 * The `backend` spec ({@link ObjectStorageBackendSpec}) and the
 * compression / encryption config-or-resolver unions are passed WHOLE
 * into their respective `withX(...)` — they are polymorphic sub-configs,
 * not further nested builders.
 */
export class ObjectStoragePluginOptions extends OptionsBuilder<ObjectStoragePluginSettings> {
  /** Start a fresh builder.  Equivalent to `new ObjectStoragePluginOptions()`. */
  static create(): ObjectStoragePluginOptions {
    return new ObjectStoragePluginOptions();
  }

  /** Backend definition — filesystem, S3, or custom.  Required. */
  withBackend(backend: ObjectStorageBackendSpec): this {
    return this.set('backend', backend);
  }

  /** Key prefix prepended to every object — e.g. `'env-prod/'`. */
  withPrefix(prefix: string): this {
    return this.set('prefix', prefix);
  }

  /** Snapshot history retention; `0` disables pruning.  Default: 3. */
  withKeepN(keepN: number): this {
    return this.set('keepN', keepN);
  }

  /** Compression config or per-pid resolver (passed whole).  Default: gzip. */
  withCompression(compression: CompressionConfig | CompressionResolver): this {
    return this.set('compression', compression);
  }

  /** Encryption config or per-pid resolver (passed whole).  Default: none. */
  withEncryption(encryption: EncryptionConfig | EncryptionResolver): this {
    return this.set('encryption', encryption);
  }

  /** Plugin ID under which the snapshot store is registered. */
  withSnapshotPluginId(snapshotPluginId: string): this {
    return this.set('snapshotPluginId', snapshotPluginId);
  }

  /** Plugin ID for the durable-state store. */
  withDurableStatePluginId(durableStatePluginId: string): this {
    return this.set('durableStatePluginId', durableStatePluginId);
  }
}
