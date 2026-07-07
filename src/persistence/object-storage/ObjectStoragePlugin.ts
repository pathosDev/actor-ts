import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { ObjectStorageDurableStateStore } from '../durable-state-stores/ObjectStorageDurableStateStore.js';
import { ObjectStorageSnapshotStore } from '../snapshot-stores/ObjectStorageSnapshotStore.js';
import { probeCompressionAvailability } from './Compression.js';
import { probeEncryptionAvailability } from './Encryption.js';
import { FilesystemObjectStorageBackend } from './FilesystemObjectStorageBackend.js';
import {
  S3ObjectStorageBackend,
  type S3Credentials,
} from './S3ObjectStorageBackend.js';
import type { ObjectStorageBackend } from './ObjectStorageBackend.js';
import type { ObjectStoragePluginOptions } from './ObjectStoragePluginOptions.js';
import {
  knownConfigsOf,
  type CompressionConfig,
  type CompressionResolver,
  type EncryptionConfig,
  type EncryptionResolver,
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

export interface ObjectStoragePluginSettings {
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
 * **Eager peer-dep validation (#18, #59).**  Before returning, this
 * function probes any optional peer-dependency the configured codecs
 * need — `fzstd` for `compression: 'zstd'` (when neither Bun nor
 * Node 22.15+ provides a native impl), `SubtleCrypto` when any
 * encryption config is supplied.  A failing probe surfaces the
 * "install X" message **here**, at registration time, instead of
 * silently surviving until the first persist call.  For resolvers
 * built via `compressionByPrefix` / `encryptionByPrefix` every config
 * the resolver could return is probed; opaque user-written resolvers
 * fall back to first-use checks.
 *
 * Example:
 *
 *   const ext = system.extension(PersistenceExtensionId);
 *   const { durableStateStore } = await registerObjectStoragePlugins(ext,
 *     ObjectStoragePluginOptions.create()
 *       .withBackend({ kind: 's3', bucket: 'my-app', region: 'eu-central-1' })
 *       .withCompression({ algorithm: 'zstd' })
 *       .withEncryption(encryptionByPrefix({ default: { mode: 'sse-s3' } })));
 *   // ... and to make the snapshot plugin active:
 *   //   actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.object-storage"
 */
export async function registerObjectStoragePlugins(
  ext: PersistenceExtension,
  options: ObjectStoragePluginOptions | Partial<ObjectStoragePluginSettings>,
): Promise<ObjectStoragePluginHandles> {
  const s = (options as Partial<ObjectStoragePluginSettings>);
  if (s.backend === undefined) throw new Error('registerObjectStoragePlugins: backend is required (call withBackend()).');
  await validateObjectStoragePeerDeps(s);

  const backend = buildBackend(s.backend);
  const snapshotId = s.snapshotPluginId ?? OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID;

  ext.registerSnapshotStore(snapshotId, (_system: ActorSystem) => {
    return new ObjectStorageSnapshotStore({
      backend,
      ...(s.prefix !== undefined ? { prefix: s.prefix } : {}),
      ...(s.keepN !== undefined ? { keepN: s.keepN } : {}),
      ...(s.compression !== undefined ? { compression: s.compression } : {}),
      ...(s.encryption !== undefined ? { encryption: s.encryption } : {}),
    });
  });

  const durableStateStore = new ObjectStorageDurableStateStore({
    backend,
    ...(s.prefix !== undefined ? { prefix: s.prefix } : {}),
    ...(s.compression !== undefined ? { compression: s.compression } : {}),
    ...(s.encryption !== undefined ? { encryption: s.encryption } : {}),
  });

  return { backend, durableStateStore };
}

/**
 * Probe every codec peer-dep the configured options may need.  Public
 * so callers can pre-validate (e.g. at app bootstrap) independently of
 * actually registering the plugin.
 */
export async function validateObjectStoragePeerDeps(
  options: ObjectStoragePluginOptions | Partial<ObjectStoragePluginSettings>,
): Promise<void> {
  const s = (options as Partial<ObjectStoragePluginSettings>);
  // Compression: probe each algorithm at most once.
  const algos = new Set<CompressionConfig['algorithm']>();
  for (const cfg of collectCompressionConfigs(s.compression)) {
    algos.add(cfg.algorithm);
  }
  for (const algo of algos) {
    await probeCompressionAvailability(algo);
  }

  // Encryption: WebCrypto is needed for the client-aes256-gcm mode
  // (HKDF + AES-GCM go through SubtleCrypto).  The server-side modes
  // — sse-s3, sse-kms — are header pass-throughs and need nothing.
  const encConfigs = collectEncryptionConfigs(s.encryption);
  if (encConfigs.some((c) => c.mode === 'client-aes256-gcm')) {
    await probeEncryptionAvailability();
  }
}

function collectCompressionConfigs(
  c: CompressionConfig | CompressionResolver | undefined,
): ReadonlyArray<CompressionConfig> {
  if (c === undefined) return [];
  if (typeof c === 'function') {
    // Resolver: check for the introspection metadata that
    // `compressionByPrefix` attaches.  Opaque user resolvers return
    // `undefined` here — we skip them rather than guess.
    return knownConfigsOf<CompressionConfig>(c) ?? [];
  }
  return [c];
}

function collectEncryptionConfigs(
  e: EncryptionConfig | EncryptionResolver | undefined,
): ReadonlyArray<EncryptionConfig> {
  if (e === undefined) return [];
  if (typeof e === 'function') return knownConfigsOf<EncryptionConfig>(e) ?? [];
  return [e];
}

function buildBackend(spec: ObjectStorageBackendSpec): ObjectStorageBackend {
  switch (spec.kind) {
    case 'filesystem':
      return new FilesystemObjectStorageBackend({ dir: spec.dir });
    case 's3':
      return new S3ObjectStorageBackend({
        bucket: spec.bucket,
        region: spec.region,
        ...(spec.endpoint !== undefined ? { endpoint: spec.endpoint } : {}),
        ...(spec.forcePathStyle !== undefined ? { forcePathStyle: spec.forcePathStyle } : {}),
        ...(spec.credentials !== undefined ? { credentials: spec.credentials } : {}),
      });
    case 'custom': return spec.backend;
  }
}
