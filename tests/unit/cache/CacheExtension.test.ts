import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
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
      .withConfig({ 'actor-ts': { cache: { 'in-memory': { 'max-entries': 2, 'cleanup-interval': 0 } } } });
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
              'in-memory': { 'max-entries': 2, 'cleanup-interval': 0 },
              idempotency: { 'in-memory': { 'max-entries': 6 } },
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
              // Only `cleanup-interval` globally — so the per-name `max-entries`
              // is the only bound in play, and it cannot be inherited from a
              // sibling.
              'in-memory': { 'cleanup-interval': 0 },
              'rate-limit': { 'in-memory': { 'max-entries': 3 } },
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
          'actor-ts': { cache: { 'in-memory': { 'max-entries': 2, 'cleanup-interval': 0 } } },
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
              'in-memory': { 'cleanup-interval': 0 },
              sessions: { 'in-memory': { 'max-entries': 0 } },
            },
          },
        });
      const sys = ActorSystem.create('cache-per-name-invalid', sysOptions);
      const ext = sys.extension(CacheExtensionId);

      expect(() => ext.cache('sessions')).toThrow(/maxEntries/);
      await sys.terminate();
    });

    /**
     * #1405 kebab-cased these three leaves.  The per-name half is the one with
     * no guard behind it at all — `actor-ts.cache.<name>.in-memory` is never a
     * `reference.conf` leaf, so `NoDeadConfigKeys` and `DocumentedDefaults`
     * both walk past it — and it is also where an ignored old spelling costs
     * the most: the instance silently falls back to the *global* bound, which
     * is the exact failure the per-name block exists to prevent.  Both roots go
     * through one helper, so both refuse.
     */
    test.each([
      ['the global block', { 'in-memory': { maxEntries: 2 } }, 'actor-ts.cache.in-memory'],
      ['a per-name block', { sessions: { 'in-memory': { maxEntries: 2 } } }, 'actor-ts.cache.sessions.in-memory'],
    ])('a retired camelCase leaf in %s is refused, naming both spellings', async (_where, cache, root) => {
      const sysOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withConfig({ 'actor-ts': { cache } });
      const sys = ActorSystem.create('cache-retired-leaf', sysOptions);
      const ext = sys.extension(CacheExtensionId);

      expect(() => ext.cache('sessions')).toThrow(ConfigError);
      expect(() => ext.cache('sessions'))
        .toThrow(new RegExp(`${root.replace(/\./g, '\\.')}\\.maxEntries[\\s\\S]*${root.replace(/\./g, '\\.')}\\.max-entries`));
      await sys.terminate();
    });

    test('cleanup-interval is read as a duration, and cleanupMs is refused', async () => {
      // The one rename that is also a value change: `reference.conf` publishes
      // `60s` now.  `30s` building a cache at all is the assertion — the leaf
      // is read with `getDuration`, and `getInt` would have thrown a
      // ConfigError on that literal.  A bare millisecond count still works, so
      // only the key moved, not the value's grammar.
      const sysOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withConfig(Config.parseString('actor-ts.cache.in-memory { max-entries = 2, cleanup-interval = 30s }'));
      const sys = ActorSystem.create('cache-cleanup-interval', sysOptions);
      const cache = sys.extension(CacheExtensionId).cache() as InMemoryCache;
      await cache.set('a', 1);
      await cache.set('b', 2);
      await cache.set('c', 3);
      expect(cache.sizeForTest()).toBeLessThanOrEqual(2);

      const retiredOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withConfig(Config.parseString('actor-ts.cache.in-memory.cleanupMs = 30000'));
      const retiredSystem = ActorSystem.create('cache-cleanup-ms', retiredOptions);
      expect(() => retiredSystem.extension(CacheExtensionId).cache())
        .toThrow(/actor-ts\.cache\.in-memory\.cleanupMs[\s\S]*actor-ts\.cache\.in-memory\.cleanup-interval/);

      await sys.terminate();
      await retiredSystem.terminate();
    });

    /**
     * #607's other half of the same sentence.  Sizing a named cache answers
     * "how much may this consumer hold"; `prefixQuotas` answers "how much may
     * it hold *against the others sharing the instance*", and an operator who
     * cannot split a cache into named instances needs the second one to be
     * reachable from the same block as the first.
     */
    describe('prefixQuotas', () => {
      test('resolves from the per-name block, and divides that instance alone', async () => {
        const sysOptions = ActorSystemOptions.create()
          .withLogger(new NoopLogger())
          .withLogLevel(LogLevel.Off)
          .withConfig({
            'actor-ts': {
              cache: {
                'in-memory': { 'max-entries': 4, 'cleanup-interval': 0 },
                shared: { 'in-memory': { 'prefix-quotas': { 'rsp:': 2, 'idem:': 2 } } },
              },
            },
          });
        const sys = ActorSystem.create('cache-prefix-quotas', sysOptions);
        const ext = sys.extension(CacheExtensionId);

        const shared = ext.cache('shared') as InMemoryCache;
        await shared.set('idem:pay-1', 'record');
        for (let i = 0; i < 20; i++) await shared.set(`rsp:/public/${i}`, i);
        expect((await shared.get('idem:pay-1')).toNullable()).toBe('record');
        expect(shared.sizeOfPrefixForTest('rsp:')).toBe(2);

        // The instance next door inherits only the global block and stays undivided.
        const undivided = ext.cache('other') as InMemoryCache;
        await undivided.set('idem:pay-1', 'record');
        for (let i = 0; i < 20; i++) await undivided.set(`rsp:/public/${i}`, i);
        expect((await undivided.get('idem:pay-1')).isNone()).toBe(true);
        await sys.terminate();
      });

      /**
       * The prefixes carry a colon, so an operator has to quote them.  Written
       * as HOCON text rather than as an object literal precisely because that
       * is the part a plain object cannot exercise.
       */
      test('parses from HOCON text with the prefixes quoted', async () => {
        const sysOptions = ActorSystemOptions.create()
          .withLogger(new NoopLogger())
          .withLogLevel(LogLevel.Off)
          .withConfig(Config.parseString(`
            actor-ts.cache.in-memory { max-entries = 4, cleanup-interval = 0 }
            actor-ts.cache.shared.in-memory.prefix-quotas { "rsp:" = 2, "idem:" = 2 }
          `));
        const sys = ActorSystem.create('cache-prefix-quotas-hocon', sysOptions);
        const ext = sys.extension(CacheExtensionId);

        const shared = ext.cache('shared') as InMemoryCache;
        await shared.set('idem:pay-1', 'record');
        for (let i = 0; i < 20; i++) await shared.set(`rsp:/public/${i}`, i);
        expect((await shared.get('idem:pay-1')).toNullable()).toBe('record');
        await sys.terminate();
      });

      /**
       * A table is layered whole, not leaf by leaf.  The quotas have to sum to
       * at most `maxEntries`, and a half-inherited table is a sum nobody wrote
       * down — so the per-name block replaces the global one outright.
       */
      test('a per-name table replaces the global one rather than merging into it', async () => {
        const sysOptions = ActorSystemOptions.create()
          .withLogger(new NoopLogger())
          .withLogLevel(LogLevel.Off)
          .withConfig({
            'actor-ts': {
              cache: {
                'in-memory': { 'max-entries': 4, 'cleanup-interval': 0, 'prefix-quotas': { 'rsp:': 4 } },
                shared: { 'in-memory': { 'prefix-quotas': { 'idem:': 4 } } },
              },
            },
          });
        const sys = ActorSystem.create('cache-prefix-quotas-replace', sysOptions);
        const ext = sys.extension(CacheExtensionId);

        const shared = ext.cache('shared') as InMemoryCache;
        for (let i = 0; i < 20; i++) await shared.set(`rsp:/public/${i}`, i);
        // `rsp:` is unreserved here — had the global table merged in, it would
        // have been capped at 4 alongside `idem:` and over-committed the map.
        expect(shared.sizeOfPrefixForTest('rsp:')).toBe(0);
        expect(shared.sizeForTest()).toBe(4);
        await sys.terminate();
      });

      test('an over-committed table is refused at the first lookup', async () => {
        const sysOptions = ActorSystemOptions.create()
          .withLogger(new NoopLogger())
          .withLogLevel(LogLevel.Off)
          .withConfig({
            'actor-ts': {
              cache: {
                'in-memory': { 'max-entries': 4, 'cleanup-interval': 0 },
                shared: { 'in-memory': { 'prefix-quotas': { 'rsp:': 3, 'idem:': 3 } } },
              },
            },
          });
        const sys = ActorSystem.create('cache-prefix-quotas-overcommit', sysOptions);
        const ext = sys.extension(CacheExtensionId);

        expect(() => ext.cache('shared')).toThrow(/prefixQuotas/);
        await sys.terminate();
      });
    });

    test('a registered plugin receives the resolved name too', async () => {
      const sysOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withConfig({
          'actor-ts': {
            cache: {
              'in-memory': { 'cleanup-interval': 0 },
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
