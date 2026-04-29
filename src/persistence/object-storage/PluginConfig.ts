import type {
  CompressionConfig,
  EncryptionConfig,
} from '../PersistenceOptions.js';

/**
 * Programmatic configuration for compression and encryption — used by
 * `ObjectStorageSnapshotStore` and `ObjectStorageDurableStateStore` as
 * **plugin-level defaults**.
 *
 * Per-actor preferences live on the actor itself (see
 * `PersistentActor.compression()` / `.encryption()`); the resolvers
 * here are the fallback for actors that don't set their own.  Both
 * fields accept either a flat config (applied uniformly) or a resolver
 * function (called per-save with the `persistenceId`).  Returning
 * `undefined` from a resolver means "fall back to the store's default".
 *
 * The `CompressionConfig` / `EncryptionConfig` types themselves are
 * re-exported from the neutral `../PersistenceWriteOptions.js` so
 * actors can import them without depending on the object-storage layer.
 *
 * Convenience helpers (`compressionByPrefix`, `encryptionByPrefix`)
 * build common resolvers for the longest-prefix-match pattern.
 */

export type {
  CompressionAlgo,
  CompressionConfig,
  EncryptionConfig,
} from '../PersistenceOptions.js';

export type CompressionResolver = (persistenceId: string) => CompressionConfig | undefined;

export type EncryptionResolver = (persistenceId: string) => EncryptionConfig | undefined;

/**
 * Internal: a resolver function with optional introspection metadata.
 * `compressionByPrefix` / `encryptionByPrefix` attach `__knownConfigs`
 * so that eager peer-dep validation (#18, #59) can probe every config
 * the resolver could possibly return.  Custom user-written resolvers
 * are opaque — their peer-dep checks fall back to first-use.
 */
const KNOWN_CONFIGS = Symbol.for('actor-ts.persistence.resolverKnownConfigs');

export interface ResolverWithKnownConfigs<T> {
  readonly [KNOWN_CONFIGS]?: ReadonlyArray<T>;
}

export const RESOLVER_KNOWN_CONFIGS_SYMBOL = KNOWN_CONFIGS;

function attachKnownConfigs<T, F extends (pid: string) => T | undefined>(
  fn: F, configs: ReadonlyArray<T>,
): F {
  Object.defineProperty(fn, KNOWN_CONFIGS, {
    value: Object.freeze(configs.slice()),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return fn;
}

/**
 * Read the optional `__knownConfigs` metadata from a resolver.  Returns
 * `undefined` for opaque user-written resolvers.
 */
export function knownConfigsOf<T>(
  resolver: ((pid: string) => T | undefined),
): ReadonlyArray<T> | undefined {
  return (resolver as ResolverWithKnownConfigs<T>)[KNOWN_CONFIGS];
}

/**
 * Resolve `compression` to a `CompressionConfig` for a given pid, taking
 * the resolver-vs-flat distinction into account and falling back to the
 * supplied default when the resolver returns `undefined` or when no
 * compression is configured at all.
 */
export function resolveCompression(
  config: CompressionConfig | CompressionResolver | undefined,
  pid: string,
  fallback: CompressionConfig,
): CompressionConfig {
  if (config === undefined) return fallback;
  if (typeof config === 'function') return config(pid) ?? fallback;
  return config;
}

/** Same shape as `resolveCompression` but for encryption configs. */
export function resolveEncryption(
  config: EncryptionConfig | EncryptionResolver | undefined,
  pid: string,
  fallback: EncryptionConfig,
): EncryptionConfig {
  if (config === undefined) return fallback;
  if (typeof config === 'function') return config(pid) ?? fallback;
  return config;
}

/* ------------------------- Convenience builders ------------------------- */

/**
 * Build a `CompressionResolver` from a longest-prefix-match map.  The
 * `default` entry is used when no other prefix matches.
 *
 *   compressionByPrefix({
 *     default:        { algorithm: 'gzip' },
 *     'events/big/':  { algorithm: 'zstd' },
 *     'events/tiny/': { algorithm: 'none' },
 *   })
 */
export function compressionByPrefix(
  spec: { readonly default?: CompressionConfig } & Record<string, CompressionConfig>,
): CompressionResolver {
  const sorted = Object.entries(spec)
    .filter(([k]) => k !== 'default')
    .sort(([a], [b]) => b.length - a.length);
  const fallback = spec.default;
  const resolver: CompressionResolver = (pid) => {
    for (const [prefix, cfg] of sorted) if (pid.startsWith(prefix)) return cfg;
    return fallback;
  };
  // Tag with every config the resolver could return, so eager peer-dep
  // validation (#18, #59) can probe each algorithm exactly once.
  const all: CompressionConfig[] = sorted.map(([, c]) => c);
  if (fallback) all.push(fallback);
  return attachKnownConfigs(resolver, all);
}

/** Mirror of `compressionByPrefix` for encryption configs. */
export function encryptionByPrefix(
  spec: { readonly default?: EncryptionConfig } & Record<string, EncryptionConfig>,
): EncryptionResolver {
  const sorted = Object.entries(spec)
    .filter(([k]) => k !== 'default')
    .sort(([a], [b]) => b.length - a.length);
  const fallback = spec.default;
  const resolver: EncryptionResolver = (pid) => {
    for (const [prefix, cfg] of sorted) if (pid.startsWith(prefix)) return cfg;
    return fallback;
  };
  const all: EncryptionConfig[] = sorted.map(([, c]) => c);
  if (fallback) all.push(fallback);
  return attachKnownConfigs(resolver, all);
}
