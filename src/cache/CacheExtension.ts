import type { ActorSystem } from '../ActorSystem.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import { InMemoryCache } from './InMemoryCache.js';
import type { Cache } from './Cache.js';

/**
 * System-wide registry for named caches.  Apps that need more than one
 * cache (e.g. a Redis-backed response cache and a separate Memcached
 * idempotency-store) register each one under a stable name and look it
 * up via `system.extension(CacheExtensionId).cache(name)`.
 *
 * The `default` cache is always available and starts as an
 * `InMemoryCache` — handy for tests and dev.  Registering a different
 * factory under `'default'` (or selecting via the HOCON path
 * `actor-ts.cache.default.plugin`) replaces it.
 */
export class CacheExtension implements Extension {
  private readonly factories = new Map<string, (system: ActorSystem) => Cache>();
  private readonly instances = new Map<string, Cache>();

  constructor(private readonly system: ActorSystem) {
    this.factories.set(ConfigKeys.cache.inMemory, () => new InMemoryCache());
  }

  /**
   * Register a cache factory under `pluginId`.  The factory runs lazily
   * on the first `cache(name)` call that resolves to this plugin via
   * config.  Re-registering the same id replaces the factory and forces
   * a re-instantiation on next access.
   */
  registerCache(pluginId: string, factory: (system: ActorSystem) => Cache): void {
    this.factories.set(pluginId, factory);
    // Force re-resolution if any active instance was built from this plugin.
    for (const [name, _inst] of this.instances) {
      if (this.pluginIdFor(name) === pluginId) this.instances.delete(name);
    }
  }

  /**
   * Resolve a cache by name.  Names map to plugin ids via the HOCON
   * path `actor-ts.cache.<name>.plugin`.  Unknown names fall back to
   * the in-memory plugin so callers always get *something* — handy for
   * tests where config wiring would be busywork.
   */
  cache(name: string = 'default'): Cache {
    const existing = this.instances.get(name);
    if (existing) return existing;
    const pluginId = this.pluginIdFor(name);
    const factory = this.factories.get(pluginId)
      ?? this.factories.get(ConfigKeys.cache.inMemory)!;
    const inst = factory(this.system);
    this.instances.set(name, inst);
    return inst;
  }

  /** Replace the cache instance for `name` directly — useful for tests. */
  setCache(name: string, cache: Cache): void {
    this.instances.set(name, cache);
  }

  /** Best-effort close of every instantiated cache. */
  async close(): Promise<void> {
    const all = Array.from(this.instances.values());
    this.instances.clear();
    await Promise.all(all.map((c) => c.close?.().catch(() => undefined)));
  }

  private pluginIdFor(name: string): string {
    const path = `actor-ts.cache.${name}.plugin`;
    return this.system.config.hasPath(path)
      ? this.system.config.getString(path)
      : ConfigKeys.cache.inMemory;
  }
}

export const CacheExtensionId: ExtensionId<CacheExtension> = extensionId(
  'CacheExtension',
  (system) => new CacheExtension(system),
);

// Public plugin-id exports — kept for back-compat with downstream code.
// Source-of-truth is `ConfigKeys.cache.*`; these are aliases.
export const REDIS_CACHE_PLUGIN_ID = ConfigKeys.cache.redis;
export const MEMCACHED_CACHE_PLUGIN_ID = ConfigKeys.cache.memcached;
export const IN_MEMORY_CACHE_PLUGIN_ID = ConfigKeys.cache.inMemory;
