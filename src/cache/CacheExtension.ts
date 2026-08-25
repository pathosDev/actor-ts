import type { ActorSystem } from '../ActorSystem.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { InMemoryCache } from './InMemoryCache.js';
import type { InMemoryCacheOptionsType } from './InMemoryCacheOptions.js';
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
 *
 * **Each name is a separate instance with separate settings.**  The name a
 * caller asks for reaches the factory, so an in-memory cache resolved as
 * `cache('rate-limit')` reads `actor-ts.cache.rate-limit.in-memory` on top
 * of the global `actor-ts.cache.in-memory` block.  That is what makes the
 * one-cache-per-consumer advice the middleware pages give actionable
 * (#607): sizing a named cache for its own key space used to require
 * hand-constructing an `InMemoryCache` and injecting it with
 * {@link setCache}, because the factory ignored the name and every named
 * instance shared one bound.
 */
export class CacheExtension implements Extension {
  private readonly factories = new Map<string, CacheFactory>();
  private readonly instances = new Map<string, Cache>();

  constructor(private readonly system: ActorSystem) {
    this.factories.set(ConfigKeys.cache.inMemory, (_system, name) => new InMemoryCache(this.inMemoryCacheOptions(name)));
  }

  /**
   * In-memory cache options for the instance resolved as `name`, layered in
   * the project's precedence order: the per-name block
   * `actor-ts.cache.<name>.in-memory` overrides the global
   * `actor-ts.cache.in-memory`, and an unset leaf in either falls through to
   * {@link InMemoryCache}'s built-in defaults (which is why the lowest layer
   * here is empty rather than a copy of them — the constructor owns them, and
   * duplicating them would give the same number two homes).
   *
   * The per-name path is nested rather than a flat
   * `actor-ts.cache.<name>.maxEntries` so the plugin *selector*
   * (`<name>.plugin`) and the selected plugin's *settings* stay in separate
   * blocks — the shape a Redis or Memcached instance needs too.  It carries no
   * `reference.conf` leaf for the same reason `<name>.plugin` carries none:
   * the name is the application's, so the path cannot be enumerated.
   *
   * Present values are validated in the constructor (`OptionsError` on a bad
   * one), so a typo'd override fails at the first `cache(name)` rather than
   * silently sizing the map at the default.
   */
  private inMemoryCacheOptions(name: string): InMemoryCacheOptionsType {
    return mergeOptions<InMemoryCacheOptionsType>(
      {},
      this.inMemoryCacheLeaves(ConfigKeys.cache.inMemory),
      this.inMemoryCacheLeaves(`${ConfigKeys.cache.root}.${name}.in-memory`),
    );
  }

  /**
   * The `InMemoryCacheOptionsType` leaves under `root`, omitting absent ones.
   *
   * `prefixQuotas` is read as a whole object and layered whole — a per-name
   * table **replaces** the global one rather than merging into it, which is
   * the same shallow rule {@link mergeOptions} applies to every other field.
   * Merging would be worse than inconsistent here: the quotas have to sum to
   * at most `maxEntries`, and a table half-inherited from a global block is a
   * sum nobody wrote down.  Its keys are read from the object rather than
   * addressed as config paths, because a prefix may contain a `.` and a path
   * would split it.
   */
  private inMemoryCacheLeaves(root: string): Partial<InMemoryCacheOptionsType> {
    const config = this.system.config;
    const leaves: {
      maxEntries?: number;
      cleanupMs?: number;
      prefixQuotas?: Record<string, number>;
    } = {};
    if (config.hasPath(`${root}.maxEntries`)) leaves.maxEntries = config.getInt(`${root}.maxEntries`);
    if (config.hasPath(`${root}.cleanupMs`)) leaves.cleanupMs = config.getDuration(`${root}.cleanupMs`);
    if (config.hasPath(`${root}.prefixQuotas`)) {
      const quotas: Record<string, number> = {};
      for (const [prefix, quota] of Object.entries(config.getObject(`${root}.prefixQuotas`))) {
        // A quoted HOCON number arrives as a string; anything else is passed
        // through unconverted so the validator names the value it rejected.
        quotas[prefix] = typeof quota === 'string' ? Number(quota) : (quota as number);
      }
      leaves.prefixQuotas = quotas;
    }
    return leaves;
  }

  /**
   * Register a cache factory under `pluginId`.  The factory runs lazily
   * on the first `cache(name)` call that resolves to this plugin via
   * config, and receives that name so it can read per-name settings the
   * way the built-in in-memory factory does.
   * Re-registering the same id replaces the factory and forces
   * a re-instantiation on next access.
   */
  registerCache(pluginId: string, factory: CacheFactory): void {
    this.factories.set(pluginId, factory);
    // Force re-resolution if any active instance was built from this plugin.
    for (const name of this.instances.keys()) {
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
    const instance = factory(this.system, name);
    this.instances.set(name, instance);
    return instance;
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
    const path = `${ConfigKeys.cache.root}.${name}.plugin`;
    return this.system.config.hasPath(path)
      ? this.system.config.getString(path)
      : ConfigKeys.cache.inMemory;
  }
}

/**
 * Builds one cache instance.  `name` is the name the caller resolved, so a
 * plugin can read its own per-name settings; ignoring it is fine and is what
 * a factory that needs no configuration does.
 */
export type CacheFactory = (system: ActorSystem, name: string) => Cache;

export const CacheExtensionId: ExtensionId<CacheExtension> = extensionId(
  'CacheExtension',
  (system) => new CacheExtension(system),
);

// Public plugin-id exports — kept for back-compat with downstream code.
// Source-of-truth is `ConfigKeys.cache.*`; these are aliases.
export const REDIS_CACHE_PLUGIN_ID = ConfigKeys.cache.redis;
export const MEMCACHED_CACHE_PLUGIN_ID = ConfigKeys.cache.memcached;
export const IN_MEMORY_CACHE_PLUGIN_ID = ConfigKeys.cache.inMemory;
