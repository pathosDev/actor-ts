import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../src/config/Config.js';

describe('Config.empty', () => {
  test('has no paths', () => {
    const config = Config.empty();
    expect(config.hasPath('anything')).toBe(false);
    expect(config.toJSON()).toEqual({});
  });
});

describe('Config.fromObject', () => {
  test('builds a Config from a nested JS object', () => {
    const config = Config.fromObject({ a: { b: 1 }, x: 'hi' });
    expect(config.getInt('a.b')).toBe(1);
    expect(config.getString('x')).toBe('hi');
  });

  test('null / undefined → empty', () => {
    expect(Config.fromObject(undefined).toJSON()).toEqual({});
    expect(Config.fromObject(null).toJSON()).toEqual({});
  });

  test('rejects non-object input', () => {
    expect(() => Config.fromObject(42)).toThrow(ConfigError);
    expect(() => Config.fromObject('foo')).toThrow(ConfigError);
  });
});

describe('Config.parseString', () => {
  test('parses HOCON', () => {
    const config = Config.parseString(`
      cluster {
        gossip-interval = 500ms
        seeds = ["10.0.0.1:2552", "10.0.0.2:2552"]
      }
    `);
    expect(config.getDuration('cluster.gossip-interval')).toBe(500);
    expect(config.getStringList('cluster.seeds')).toEqual(['10.0.0.1:2552', '10.0.0.2:2552']);
  });

  test('resolves substitutions inline', () => {
    const config = Config.parseString(`
      host = example.com
      addr = \${host}
    `);
    expect(config.getString('addr')).toBe('example.com');
  });
});

describe('Config accessors — type coercion & errors', () => {
  const config = Config.parseString(`
    s = "text"
    n = 42
    f = 3.14
    b = true
    d = 2 seconds
    sz = 1 KiB
    xs = [a, b, c]
    obj { key = "value" }
  `);

  test('getString', () => {
    expect(config.getString('s')).toBe('text');
    expect(config.getString('n')).toBe('42');     // number coerces
    expect(config.getString('b')).toBe('true');   // boolean coerces
  });

  test('getInt / getNumber', () => {
    expect(config.getInt('n')).toBe(42);
    expect(config.getNumber('f')).toBeCloseTo(3.14);
    expect(() => config.getInt('f')).toThrow(/integer/);
  });

  test('getBoolean accepts common synonyms', () => {
    expect(config.getBoolean('b')).toBe(true);
    const c2 = Config.parseString('x = "yes"\ny = "off"');
    expect(c2.getBoolean('x')).toBe(true);
    expect(c2.getBoolean('y')).toBe(false);
  });

  test('getDuration returns milliseconds', () => {
    expect(config.getDuration('d')).toBe(2_000);
  });

  test('getBytes returns byte count', () => {
    expect(config.getBytes('sz')).toBe(1024);
  });

  test('getStringList coerces scalars', () => {
    expect(config.getStringList('xs')).toEqual(['a', 'b', 'c']);
  });

  test('getList returns raw values', () => {
    expect(config.getList('xs').length).toBe(3);
  });

  test('getObject + getConfig pull subtrees', () => {
    expect(config.getObject('obj')).toEqual({ key: 'value' });
    expect(config.getConfig('obj').getString('key')).toBe('value');
  });

  test('hasPath returns true / false correctly', () => {
    expect(config.hasPath('s')).toBe(true);
    expect(config.hasPath('obj.key')).toBe(true);
    expect(config.hasPath('missing')).toBe(false);
  });

  test('missing path raises ConfigError', () => {
    expect(() => config.getString('missing')).toThrow(ConfigError);
    expect(() => config.getConfig('missing')).toThrow(ConfigError);
  });
});

describe('Config — layering', () => {
  test('withFallback: current config wins, fallback fills gaps', () => {
    const primary = Config.fromObject({ a: 1, nested: { x: 1 } });
    const fallback = Config.fromObject({ a: 99, b: 2, nested: { y: 2 } });
    const merged = primary.withFallback(fallback);
    expect(merged.toJSON()).toEqual({ a: 1, b: 2, nested: { x: 1, y: 2 } });
  });

  test('merge: overlay wins', () => {
    const base = Config.fromObject({ a: 1, b: 2 });
    const overlay = Config.fromObject({ b: 20, config: 30 });
    expect(base.merge(overlay).toJSON()).toEqual({ a: 1, b: 20, config: 30 });
  });

  test('atPath wraps the tree under the given path', () => {
    const config = Config.fromObject({ x: 1 }).atPath('foo.bar');
    expect(config.toJSON()).toEqual({ foo: { bar: { x: 1 } } });
  });
});

describe('Config.loadReference', () => {
  test('contains the bundled defaults', () => {
    const ref = Config.loadReference();
    expect(ref.getString('actor-ts.system.name')).toBe('default');
    expect(ref.getDuration('actor-ts.cluster.gossip-interval')).toBe(1_000);
    expect(ref.getDuration('actor-ts.cluster.failure-detector.heartbeat-interval')).toBe(500);
    expect(ref.getInt('actor-ts.sharding.number-of-shards')).toBe(64);
    expect(ref.getString('actor-ts.http.backend')).toBe('fastify');
  });
});

describe('Config.load', () => {
  test('combines reference + code overrides with code winning', () => {
    const overrides = Config.fromObject({
      'actor-ts': { cluster: { 'gossip-interval': '100ms' } },
    });
    const config = Config.load({ overrides });
    expect(config.getDuration('actor-ts.cluster.gossip-interval')).toBe(100);
    // Not overridden — still reference value.
    expect(config.getInt('actor-ts.sharding.number-of-shards')).toBe(64);
  });

  test('ignores missing application.conf silently', () => {
    const config = Config.load({ appConfPath: '/no/such/file.conf' });
    expect(config.getInt('actor-ts.sharding.number-of-shards')).toBe(64);
  });
});
