export { CacheError } from './Cache.js';
export type { Cache } from './Cache.js';
export { InMemoryCache } from './InMemoryCache.js';
export { RedisCache } from './RedisCache.js';
export type { RedisCacheOptions, RedisClientLike } from './RedisCache.js';
export { MemcachedCache } from './MemcachedCache.js';
export type { MemcachedCacheOptions, MemcachedClientLike } from './MemcachedCache.js';
export {
  CacheExtension,
  CacheExtensionId,
  IN_MEMORY_CACHE_PLUGIN_ID,
  REDIS_CACHE_PLUGIN_ID,
  MEMCACHED_CACHE_PLUGIN_ID,
} from './CacheExtension.js';
