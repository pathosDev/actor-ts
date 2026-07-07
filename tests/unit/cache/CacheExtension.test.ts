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
