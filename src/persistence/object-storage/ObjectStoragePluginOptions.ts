import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Serializer } from '../../serialization/Serializer.js';
import type {
  CompressionConfig,
  CompressionResolver,
  EncryptionConfig,
  EncryptionResolver,
  IntegrityConfig,
  IntegrityResolver,
} from './PluginConfig.js';
import type { ObjectStorageBackendSpec } from './ObjectStoragePlugin.js';

export type ObjectStoragePluginOptionsType = {
  /** Plugin ID under which the snapshot store is registered. */
  readonly snapshotPluginId?: string;
  /** Backend definition — filesystem, S3, or custom. */
  readonly backend: ObjectStorageBackendSpec;
  /** Key prefix prepended to every object — e.g. `'env-prod/'`. */
  readonly prefix?: string;
  /** Snapshot history retention; `0` disables pruning.  Default: 3. */
  readonly keepN?: number;
  /** Compression config or per-pid resolver.  Default: gzip. */
  readonly compression?: CompressionConfig | CompressionResolver;
  /** Encryption config or per-pid resolver.  Default: none. */
  readonly encryption?: EncryptionConfig | EncryptionResolver;
  /**
   * HMAC-SHA256 body integrity (#116) for **both** stores this plugin
   * registers.  Default: none.
   *
   * It belongs here and not only on the individual store options
   * because this is the one-call wiring: without it the snapshot store
   * and the durable-state store could only be given an integrity key by
   * constructing them by hand, which is the whole reason the control
   * went unused (#613).
   */
  readonly integrity?: IntegrityConfig | IntegrityResolver;
  /**
   * Accept untagged bodies while `integrity` is configured — the
   * migration window for a bucket written before integrity was enabled
   * (#579), applied to both registered stores.  Default: false.
   */
  readonly allowUntaggedBodies?: boolean;
  /**
   * Refuse bodies that are not bound to the storage key they were read
   * from (#612), in both registered stores.  Default: false.
   *
   * Both stores bind their writes unconditionally; this is the switch
   * that stops accepting *unbound* bodies, and it belongs on the plugin
   * for the same reason `integrity` does — the one-call wiring is where
   * most deployments configure both stores at once.
   */
  readonly requireContextBinding?: boolean;
  /**
   * Refuse a durable-state revision below the highest this process has
   * already seen for the same persistenceId (#612).  Default: true.
   *
   * Durable-state only — snapshots have no revision, and their sequence
   * number is already bound by the storage key.
   */
  readonly rejectRevisionRollback?: boolean;
  /** Payload serializer applied to both stores this plugin registers. */
  readonly serializer?: Serializer;
  /**
   * Cap on the decompressed size of a stored body in bytes — the
   * decompression-bomb guard on read (security audit #3), applied to both the
   * snapshot and durable-state stores this plugin registers.  Default 512 MiB
   * (`DEFAULT_MAX_DECOMPRESSED_BYTES`); `Infinity` opts out.
   */
  readonly maxDecompressedBytes?: number;
};

/**
 * Fluent builder for {@link ObjectStoragePluginOptionsType}.  The `backend`
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
export class ObjectStoragePluginOptionsBuilder extends OptionsBuilder<ObjectStoragePluginOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ObjectStoragePluginOptionsBuilder()`. */
  static create(): ObjectStoragePluginOptionsBuilder {
    return new ObjectStoragePluginOptionsBuilder();
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

  /** HMAC-SHA256 body integrity (#116) for both registered stores — signs writes and requires a tag on reads.  Default: none. */
  withIntegrity(integrity: IntegrityConfig | IntegrityResolver): this {
    return this.set('integrity', integrity);
  }

  /** Accept untagged bodies in both registered stores while integrity is configured — the migration window (#579).  Default: false. */
  withAllowUntaggedBodies(allowUntaggedBodies = true): this {
    return this.set('allowUntaggedBodies', allowUntaggedBodies);
  }

  /** Refuse bodies not bound to their storage key in both registered stores (#612) — turn on once the corpus is rewritten.  Default: false. */
  withRequireContextBinding(requireContextBinding = true): this {
    return this.set('requireContextBinding', requireContextBinding);
  }

  /** Refuse a durable-state revision below the highest this process has seen — the in-process rollback floor (#612).  Default: true. */
  withRejectRevisionRollback(rejectRevisionRollback = true): this {
    return this.set('rejectRevisionRollback', rejectRevisionRollback);
  }

  /** Payload serializer applied to both stores this plugin registers. */
  withSerializer(serializer: Serializer): this {
    return this.set('serializer', serializer);
  }

  /**
   * Cap on the decompressed body size (bytes) for both registered stores —
   * decompression-bomb guard (#3).  Default 512 MiB; `Infinity` opts out.
   */
  withMaxDecompressedBytes(bytes: number): this {
    return this.set('maxDecompressedBytes', bytes);
  }

  /** Plugin ID under which the snapshot store is registered. */
  withSnapshotPluginId(snapshotPluginId: string): this {
    return this.set('snapshotPluginId', snapshotPluginId);
  }
}

/**
 * Accepted input for {@link registerObjectStoragePlugins}: the fluent
 * {@link ObjectStoragePluginOptionsBuilder} OR a plain
 * {@link ObjectStoragePluginOptionsType} object.
 */
export type ObjectStoragePluginOptions =
  | ObjectStoragePluginOptionsBuilder
  | Partial<ObjectStoragePluginOptionsType>;
/** Value alias so `ObjectStoragePluginOptions.create()` / `new ObjectStoragePluginOptions()` resolve to the builder. */
export const ObjectStoragePluginOptions = ObjectStoragePluginOptionsBuilder;
