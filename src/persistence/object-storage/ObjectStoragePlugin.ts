import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { ObjectStorageDurableStateStore } from '../durable-state-stores/ObjectStorageDurableStateStore.js';
import { ObjectStorageSnapshotStore } from '../snapshot-stores/ObjectStorageSnapshotStore.js';
import { FilesystemObjectStorageBackend } from './FilesystemObjectStorageBackend.js';
import {
  S3ObjectStorageBackend,
  type S3Credentials,
} from './S3ObjectStorageBackend.js';
import type { ObjectStorageBackend } from './ObjectStorageBackend.js';
import type {
  CompressionConfig,
  CompressionResolver,
  EncryptionConfig,
  EncryptionResolver,
} from './PluginConfig.js';

/** Canonical plugin IDs registered by `registerObjectStoragePlugins`. */
export const OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.object-storage';
export const OBJECT_STORAGE_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.object-storage';

/**
 * Backend selection — discriminated union so the plugin can build either
 * the filesystem-backed or the S3-backed object store from a single
 * config blob.  An already-constructed `ObjectStorageBackend` is also
 * accepted for advanced cases (mock backend in tests, custom subclass).
 */
export type ObjectStorageBackendSpec =
  | { readonly kind: 'filesystem'; readonly dir: string }
  | {
      readonly kind: 's3';
      readonly bucket: string;
      readonly region: string;
      readonly endpoint?: string;
      readonly forcePathStyle?: boolean;
      readonly credentials?: S3Credentials;
    }
  | { readonly kind: 'custom'; readonly backend: ObjectStorageBackend };

export interface ObjectStoragePluginOptions {
  /** Plugin ID under which the snapshot store is registered. */
  readonly snapshotPluginId?: string;
  /** Plugin ID for the durable-state store. */
  readonly durableStatePluginId?: string;
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
}

export interface ObjectStoragePluginHandles {
  /** The shared backend — both stores write through this. */
  readonly backend: ObjectStorageBackend;
  /**
   * The DurableState store instance.  `PersistenceExtension` doesn't
   * carry a DurableState registry today, so callers that want
   * DurableState pass this directly into `DurableStateActor`'s
   * settings.
   */
  readonly durableStateStore: ObjectStorageDurableStateStore;
}

/**
 * Register the object-storage SnapshotStore against `PersistenceExtension`
 * and return a ready-to-use DurableStateStore instance.  Mirrors the
 * Cassandra plugin's one-call wiring while accepting that DurableState
 * isn't extension-managed today — callers who want DurableState read
 * `handles.durableStateStore` from the return value and pass it into
 * their `DurableStateActor` settings.
 *
 * Example:
 *
 *   const ext = system.extension(PersistenceExtensionId);
 *   const { durableStateStore } = registerObjectStoragePlugins(ext, {
 *     backend: { kind: 's3', bucket: 'my-app', region: 'eu-central-1' },
 *     compression: { algorithm: 'zstd' },
 *     encryption:  encryptionByPrefix({ default: { mode: 'sse-s3' } }),
 *   });
 *   // ... and to make the snapshot plugin active:
 *   //   actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.object-storage"
 */
export function registerObjectStoragePlugins(
  ext: PersistenceExtension,
  options: ObjectStoragePluginOptions,
): ObjectStoragePluginHandles {
  const backend = buildBackend(options.backend);
  const snapshotId = options.snapshotPluginId ?? OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID;

  ext.registerSnapshotStore(snapshotId, (_system: ActorSystem) =>
    new ObjectStorageSnapshotStore({
      backend,
      prefix: options.prefix,
      keepN: options.keepN,
      compression: options.compression,
      encryption: options.encryption,
    }),
  );

  const durableStateStore = new ObjectStorageDurableStateStore({
    backend,
    prefix: options.prefix,
    compression: options.compression,
    encryption: options.encryption,
  });

  return { backend, durableStateStore };
}

function buildBackend(spec: ObjectStorageBackendSpec): ObjectStorageBackend {
  switch (spec.kind) {
    case 'filesystem': return new FilesystemObjectStorageBackend({ dir: spec.dir });
    case 's3': return new S3ObjectStorageBackend({
      bucket: spec.bucket,
      region: spec.region,
      endpoint: spec.endpoint,
      forcePathStyle: spec.forcePathStyle,
      credentials: spec.credentials,
    });
    case 'custom': return spec.backend;
  }
}
