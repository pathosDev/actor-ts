import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  CacheExtensionId,
  IN_MEMORY_CACHE_PLUGIN_ID,
  InMemoryCache,
  REDIS_CACHE_PLUGIN_ID,
} from '../../../src/cache/index.js';

describe('CacheExtension', () => {
  test('default cache is in-memory and works without configuration', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('cache-default', sysOptions);
    const ext = sys.extension(CacheExtensionId);
    const cache = ext.cache();
    await cache.set('k', 'v');
    expect((await cache.get('k')).toNullable()).toBe('v');
    await sys.terminate();
  });

  test('repeat lookups return the same instance per name', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('cache-same', sysOptions);
    const ext = sys.extension(CacheExtensionId);
    expect(ext.cache('foo')).toBe(ext.cache('foo'));
    expect(ext.cache('foo')).not.toBe(ext.cache('bar'));
    await sys.terminate();
  });

  test('config selects a registered plugin by name', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { cache: { custom: { plugin: 'my-plugin' } } } });
    const sys = ActorSystem.create('cache-cfg', sysOptions);
    const ext = sys.extension(CacheExtensionId);
    let factoryCalls = 0;
    ext.registerCache('my-plugin', () => { factoryCalls++; return new InMemoryCache(); });
    const cache = ext.cache('custom');
    await cache.set('k', 1);
    expect(factoryCalls).toBe(1);
    // Repeat access does NOT re-instantiate.
    ext.cache('custom');
    expect(factoryCalls).toBe(1);
    await sys.terminate();
  });

  test('unknown plugin id falls back to in-memory plugin', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { cache: { weird: { plugin: 'no-such-plugin' } } } });
    const sys = ActorSystem.create('cache-fallback', sysOptions);
    const ext = sys.extension(CacheExtensionId);
    const cache = ext.cache('weird');
    await cache.set('k', 'v');
    expect((await cache.get('k')).toNullable()).toBe('v');  // works via in-memory fallback
    await sys.terminate();
  });

  test('reads the in-memory cache options from HOCON (actor-ts.cache.in-memory)', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { cache: { 'in-memory': { maxEntries: 2, cleanupMs: 0 } } } });
    const sys = ActorSystem.create('cache-hocon', sysOptions);
    const ext = sys.extension(CacheExtensionId);
    const cache = ext.cache() as InMemoryCache;
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('c', 3);   // over the configured cap of 2 → LRU eviction kicks in
    expect(cache.sizeForTest()).toBeLessThanOrEqual(2);
    await sys.terminate();
  });

  /**
   * The half of #607's one-cache-per-consumer advice that used to be
   * unreachable.  Three JSDoc headers and six doc pages tell the reader to
   * give `rateLimit` / `idempotent` / `cached` a named cache each and size
   * each one's `maxEntries` for its own key space — and the in-memory factory
   * ignored the name, so every named instance shared the one global bound and
   * the second half of that sentence was not implementable through the API
   * the first half recommends.
   *
   * `actor-ts.cache.<name>.in-memory` is that missing layer.  The nesting is
   * deliberate: `<name>.plugin` selects the backend and `<name>.in-memory`
   * configures it, so a Redis instance can be sized per name later without a
   * second convention.
   */
  describe('per-name in-memory options (actor-ts.cache.<name>.in-memory)', () => {
    /** Fill `cache` past `beyond` distinct keys and report what stuck. */
    async function sizeAfterFilling(cache: InMemoryCache, beyond: number): Promise<number> {
      for (let i = 0; i < beyond; i++) await cache.set(`k${i}`, i);
      return cache.sizeForTest();
    }

    test('a per-name block sizes that instance alone, and the others keep the global bound', async () => {
      const sysOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withConfig({
          'actor-ts': {
            cache: {
              'in-memory': { maxEntries: 2, cleanupMs: 0 },
              idempotency: { 'in-memory': { maxEntries: 6 } },
            },
          },
        });
      const sys = ActorSystem.create('cache-per-name', sysOptions);
      const ext = sys.extension(CacheExtensionId);

      const idempotency = ext.cache('idempotency') as InMemoryCache;
      const responses = ext.cache('response-cache') as InMemoryCache;

      expect(await sizeAfterFilling(idempotency, 20)).toBe(6);   // its own bound
      expect(await sizeAfterFilling(responses, 20)).toBe(2);     // the global one
      await sys.terminate();
    });

    test('an override sets one leaf and the other still comes from the global block', async () => {
      const sysOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withConfig({
          'actor-ts': {
            cache: {
              // Only `cleanupMs` globally — so the per-name `maxEntries` is the
              // only bound in play, and it cannot be inherited from a sibling.
              'in-memory': { cleanupMs: 0 },
              'rate-limit': { 'in-memory': { maxEntries: 3 } },
            },
          },
        });
      const sys = ActorSystem.create('cache-per-name-partial', sysOptions);
      const ext = sys.extension(CacheExtensionId);

      const limiter = ext.cache('rate-limit') as InMemoryCache;
      expect(await sizeAfterFilling(limiter, 20)).toBe(3);
      await sys.terminate();
    });

    test('a name with no block of its own falls through to the global one', async () => {
      const sysOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withConfig({
          'actor-ts': { cache: { 'in-memory': { maxEntries: 2, cleanupMs: 0 } } },
        });
      const sys = ActorSystem.create('cache-per-name-fallthrough', sysOptions);
      const ext = sys.extension(CacheExtensionId);

      const unnamed = ext.cache('anything') as InMemoryCache;
      expect(await sizeAfterFilling(unnamed, 20)).toBe(2);
      await sys.terminate();
    });

    test('a bad per-name value is refused at the first lookup, not silently defaulted', async () => {
      const sysOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withConfig({
          'actor-ts': {
            cache: {
              'in-memory': { cleanupMs: 0 },
              sessions: { 'in-memory': { maxEntries: 0 } },
            },
          },
        });
      const sys = ActorSystem.create('cache-per-name-invalid', sysOptions);
      const ext = sys.extension(CacheExtensionId);

      expect(() => ext.cache('sessions')).toThrow(/maxEntries/);
      await sys.terminate();
    });

    test('a registered plugin receives the resolved name too', async () => {
      const sysOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withConfig({
          'actor-ts': {
            cache: {
              'in-memory': { cleanupMs: 0 },
              audit: { plugin: 'name-aware' },
            },
          },
        });
      const sys = ActorSystem.create('cache-name-aware-plugin', sysOptions);
      const ext = sys.extension(CacheExtensionId);
      const seen: string[] = [];
      ext.registerCache('name-aware', (_system, name) => {
        seen.push(name);
        return new InMemoryCache({ cleanupMs: 0 });
      });

      ext.cache('audit');
      expect(seen).toEqual(['audit']);
      await sys.terminate();
    });
  });

  test('setCache replaces the instance for a name (test hook)', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('cache-set', sysOptions);
    const ext = sys.extension(CacheExtensionId);
    const probe = new InMemoryCache();
    ext.setCache('default', probe);
    expect(ext.cache('default')).toBe(probe);
    await sys.terminate();
  });

  test('plugin id constants are exported', () => {
    expect(IN_MEMORY_CACHE_PLUGIN_ID).toBe('actor-ts.cache.in-memory');
    expect(REDIS_CACHE_PLUGIN_ID).toBe('actor-ts.cache.redis');
  });
});
