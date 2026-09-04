import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsError, OptionsValidator } from '../../util/OptionsValidator.js';
import type { Serializer } from '../../serialization/Serializer.js';
import type {
  CompressionAlgo,
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
 * Validates the **merged** {@link ObjectStoragePluginOptionsType} — the layer
 * where an operator's HOCON and the caller's explicit options have already
 * been folded together, which is the only place a cross-field rule can see
 * the values that will actually be used (#873).
 *
 * Most of it is cross-field by nature, so the generic helpers cannot express
 * it: `bucket` is required *when the backend is S3*, `kmsKeyId` *when the
 * encryption mode is sse-kms*.  Those are checked here rather than left to
 * the backend constructors so a mistyped config fails at registration, with
 * the offending field named, instead of at the first snapshot.
 *
 * `maxDecompressedBytes` gets a bespoke rule for the same reason
 * `ObjectStorageSnapshotStoreOptionsValidator` has one: `Infinity` is the
 * documented opt-out and the generic `positiveInt` helper rejects it.
 */
export class ObjectStoragePluginOptionsValidator extends OptionsValidator<ObjectStoragePluginOptionsType> {
  constructor() {
    super('ObjectStoragePluginOptions');
  }

  protected rules(s: Partial<ObjectStoragePluginOptionsType>): void {
    // 0 is meaningful — it is how pruning is switched off — so the floor is
    // non-negative rather than positive.
    this.nonNegativeInt('keepN');
    this.maxDecompressedBytesRule(s);
    this.backendRules(s);
    this.encryptionRules(s);
  }

  private maxDecompressedBytesRule(s: Partial<ObjectStoragePluginOptionsType>): void {
    const { maxDecompressedBytes } = s;
    if (maxDecompressedBytes === undefined || maxDecompressedBytes === Infinity) return;
    if (
      typeof maxDecompressedBytes !== 'number' || !Number.isInteger(maxDecompressedBytes)
      || maxDecompressedBytes < 1
    ) {
      this.fail('maxDecompressedBytes', 'must be a positive integer or Infinity', maxDecompressedBytes);
    }
  }

  private backendRules(s: Partial<ObjectStoragePluginOptionsType>): void {
    const { backend } = s;
    if (backend === undefined) return;
    if (backend.kind === 's3') {
      if (!isNonEmptyString(backend.bucket)) {
        this.fail('backend.bucket', 'is required when backend is s3', backend.bucket);
      }
      if (!isNonEmptyString(backend.region)) {
        this.fail('backend.region', "is required when backend is s3 (use 'auto' for Cloudflare R2)", backend.region);
      }
    }
    if (backend.kind === 'filesystem') {
      if (!isNonEmptyString(backend.dir)) {
        this.fail('backend.dir', 'is required when backend is filesystem', backend.dir);
      }
      this.positiveDuration('backend.lockTimeoutMs', backend.lockTimeoutMs);
      this.positiveDuration('backend.staleLockMs', backend.staleLockMs);
    }
  }

  private positiveDuration(field: string, value: number | undefined): void {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      this.fail(field, 'must be a positive finite number of milliseconds', value);
    }
  }

  private encryptionRules(s: Partial<ObjectStoragePluginOptionsType>): void {
    const { encryption } = s;
    // A resolver is opaque — its per-pid answers are checked where they are
    // used, exactly as the peer-dep probes treat them.
    if (encryption === undefined || typeof encryption === 'function') return;
    if (encryption.mode !== 'sse-kms') return;
    if (!isNonEmptyString(encryption.kmsKeyId)) {
      this.fail('encryption.kmsKeyId', "is required when encryption.mode is 'sse-kms'", encryption.kmsKeyId);
    }
  }
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

/** The `actor-ts.persistence.snapshot-store.object-storage` block's key set. */
type ObjectStorageConfigKeys = typeof ConfigKeys.persistence.snapshotStore.objectStorage;

/**
 * Read `actor-ts.persistence.snapshot-store.object-storage.*` into the shape
 * {@link registerObjectStoragePlugins} layers under the caller's explicit
 * options — the persistence subsystem's first HOCON reader (#873).
 *
 * Before this, every field of the object-storage plugin was constructor-only:
 * a bucket, a region, a prefix and a retention count could not be moved
 * without a code change and a redeploy, which is the wrong shape for values
 * that differ per environment and are usually owned by whoever runs the
 * fleet rather than by whoever writes the actors.
 *
 * Only keys actually present are returned, so an absent one falls through to
 * the built-in default instead of landing as an explicit `undefined` — the
 * rule `mergeOptions` encodes.  `backend = ""` is likewise *not* a value: it
 * is the published shape of the key, and it leaves the backend to code.
 *
 * **What has no path here, on purpose.**  Every field that carries key
 * material is absent from the block rather than validated inside it:
 * `s3.credentials` (omitting it uses the SDK's default chain — env vars, an
 * instance profile, IRSA), the client-side `masterKey` / `masterKeys`, and
 * `integrity.integrityKey`.  A secret in `application.conf` is a secret in
 * the image, in the config map and in every log that dumps the resolved
 * config, so the mitigation is that the path does not exist — not a warning
 * about using it.  `encryption.mode = client-aes256-gcm` is therefore
 * **refused** with an {@link OptionsError} naming `withEncryption(...)`,
 * rather than silently ignored: a deployment that asked for client-side
 * encryption and got plaintext is the failure mode #960 exists to stop.
 *
 * `kms-key-id` is fine — a KMS key ARN is a *name*, and the key itself never
 * leaves the KMS service.
 *
 * Both stores `registerObjectStoragePlugins` returns are configured from this
 * one block, because the two share a single backend; giving
 * `durable-state.object-storage` leaves of its own would declare one backend
 * twice and let the two halves disagree.
 */
export function readObjectStoragePluginOptionsFromConfig(
  config: Config,
): Partial<ObjectStoragePluginOptionsType> {
  const keys = ConfigKeys.persistence.snapshotStore.objectStorage;
  if (!config.hasPath(keys.root)) return {};
  const out: {
    -readonly [K in keyof ObjectStoragePluginOptionsType]?: ObjectStoragePluginOptionsType[K]
  } = {};
  const backend = readBackendSpec(config, keys);
  if (backend !== undefined) out.backend = backend;
  if (config.hasPath(keys.prefix)) out.prefix = config.getString(keys.prefix);
  if (config.hasPath(keys.keepN)) out.keepN = config.getInt(keys.keepN);
  if (config.hasPath(keys.maxDecompressedBytes)) {
    out.maxDecompressedBytes = config.getBytes(keys.maxDecompressedBytes);
  }
  const compression = readCompressionConfig(config, keys);
  if (compression !== undefined) out.compression = compression;
  const encryption = readEncryptionConfig(config, keys);
  if (encryption !== undefined) out.encryption = encryption;
  return out;
}

/**
 * Collapse `backend` plus its matching sub-block into one
 * {@link ObjectStorageBackendSpec}.  `""` means "left to code" and yields no
 * key at all; a required leaf that is missing or empty is left to
 * {@link ObjectStoragePluginOptionsValidator}, which names the field.
 */
function readBackendSpec(
  config: Config,
  keys: ObjectStorageConfigKeys,
): ObjectStorageBackendSpec | undefined {
  if (!config.hasPath(keys.backend)) return undefined;
  const kind = config.getString(keys.backend);
  if (kind === '') return undefined;
  if (kind === 'filesystem') {
    return {
      kind: 'filesystem',
      dir: readString(config, keys.filesystemDir),
      ...(config.hasPath(keys.filesystemLockTimeout)
        ? { lockTimeoutMs: config.getDuration(keys.filesystemLockTimeout) } : {}),
      ...(config.hasPath(keys.filesystemStaleLock)
        ? { staleLockMs: config.getDuration(keys.filesystemStaleLock) } : {}),
    };
  }
  if (kind === 's3') {
    const endpoint = readString(config, keys.s3Endpoint);
    return {
      kind: 's3',
      bucket: readString(config, keys.s3Bucket),
      region: readString(config, keys.s3Region),
      // An empty endpoint is the published placeholder for "plain AWS S3",
      // not an endpoint — passing it through would fail the backend's own
      // URL rule on a block the operator never filled in.
      ...(endpoint === '' ? {} : { endpoint }),
      ...(config.hasPath(keys.s3ForcePathStyle)
        ? { forcePathStyle: config.getBoolean(keys.s3ForcePathStyle) } : {}),
    };
  }
  throw new OptionsError(
    `ObjectStoragePluginOptions: backend must be "filesystem", "s3" or "" (got ${JSON.stringify(kind)}). `
    + "A pre-built backend instance ({ kind: 'custom' }) is code-only — a config file cannot express one.",
    'ObjectStoragePluginOptions',
    'backend',
    kind,
  );
}

function readCompressionConfig(
  config: Config,
  keys: ObjectStorageConfigKeys,
): CompressionConfig | undefined {
  if (!config.hasPath(keys.compressionAlgorithm)) return undefined;
  const algorithm = config.getString(keys.compressionAlgorithm);
  if (algorithm !== 'none' && algorithm !== 'gzip' && algorithm !== 'zstd') {
    throw new OptionsError(
      `ObjectStoragePluginOptions: compression.algorithm must be "none", "gzip" or "zstd" (got ${JSON.stringify(algorithm)}).`,
      'ObjectStoragePluginOptions',
      'compression.algorithm',
      algorithm,
    );
  }
  // `level` is comment-only in reference.conf: absence is what selects the
  // encoder's algorithm-specific default (gzip 6, zstd 3), so publishing a
  // number would pin one algorithm's default onto the other.
  return {
    algorithm: algorithm satisfies CompressionAlgo,
    ...(config.hasPath(keys.compressionLevel) ? { level: config.getInt(keys.compressionLevel) } : {}),
  };
}

function readEncryptionConfig(
  config: Config,
  keys: ObjectStorageConfigKeys,
): EncryptionConfig | undefined {
  if (!config.hasPath(keys.encryptionMode)) return undefined;
  const mode = config.getString(keys.encryptionMode);
  if (mode === 'none') return { mode: 'none' };
  if (mode === 'sse-s3') return { mode: 'sse-s3' };
  if (mode === 'sse-kms') return { mode: 'sse-kms', kmsKeyId: readString(config, keys.encryptionKmsKeyId) };
  if (mode === 'client-aes256-gcm') {
    throw new OptionsError(
      "ObjectStoragePluginOptions: encryption.mode 'client-aes256-gcm' cannot be configured from HOCON. "
      + 'It needs a 32-byte master key and an HKDF info string, and key material must never live in a '
      + 'config file — configure it in code with '
      + "ObjectStoragePluginOptions.create().withEncryption({ mode: 'client-aes256-gcm', masterKey, info }). "
      + "From config, only the server-side modes 'sse-s3' and 'sse-kms' are expressible.",
      'ObjectStoragePluginOptions',
      'encryption.mode',
      mode,
    );
  }
  throw new OptionsError(
    `ObjectStoragePluginOptions: encryption.mode must be "none", "sse-s3" or "sse-kms" (got ${JSON.stringify(mode)}).`,
    'ObjectStoragePluginOptions',
    'encryption.mode',
    mode,
  );
}

/** A placeholder leaf reads as `''`, which the validator turns into a named failure. */
function readString(config: Config, path: string): string {
  return config.hasPath(path) ? config.getString(path) : '';
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
