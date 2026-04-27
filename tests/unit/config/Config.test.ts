import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../src/config/Config.js';

describe('Config.empty', () => {
  test('has no paths', () => {
    const c = Config.empty();
    expect(c.hasPath('anything')).toBe(false);
    expect(c.toJSON()).toEqual({});
  });
});

describe('Config.fromObject', () => {
  test('builds a Config from a nested JS object', () => {
    const c = Config.fromObject({ a: { b: 1 }, x: 'hi' });
    expect(c.getInt('a.b')).toBe(1);
    expect(c.getString('x')).toBe('hi');
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
    const c = Config.parseString(`
      cluster {
        gossip-interval = 500ms
        seeds = ["10.0.0.1:2552", "10.0.0.2:2552"]
      }
    `);
    expect(c.getDuration('cluster.gossip-interval')).toBe(500);
    expect(c.getStringList('cluster.seeds')).toEqual(['10.0.0.1:2552', '10.0.0.2:2552']);
  });

  test('resolves substitutions inline', () => {
    const c = Config.parseString(`
      host = example.com
      addr = \${host}
    `);
    expect(c.getString('addr')).toBe('example.com');
  });
});

describe('Config accessors — type coercion & errors', () => {
  const c = Config.parseString(`
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
    expect(c.getString('s')).toBe('text');
    expect(c.getString('n')).toBe('42');     // number coerces
    expect(c.getString('b')).toBe('true');   // boolean coerces
  });

  test('getInt / getNumber', () => {
    expect(c.getInt('n')).toBe(42);
    expect(c.getNumber('f')).toBeCloseTo(3.14);
    expect(() => c.getInt('f')).toThrow(/integer/);
  });

  test('getBoolean accepts common synonyms', () => {
    expect(c.getBoolean('b')).toBe(true);
    const c2 = Config.parseString('x = "yes"\ny = "off"');
    expect(c2.getBoolean('x')).toBe(true);
    expect(c2.getBoolean('y')).toBe(false);
  });

  test('getDuration returns milliseconds', () => {
    expect(c.getDuration('d')).toBe(2_000);
  });

  test('getBytes returns byte count', () => {
    expect(c.getBytes('sz')).toBe(1024);
  });

  test('getStringList coerces scalars', () => {
    expect(c.getStringList('xs')).toEqual(['a', 'b', 'c']);
  });

  test('getList returns raw values', () => {
    expect(c.getList('xs').length).toBe(3);
  });

  test('getObject + getConfig pull subtrees', () => {
    expect(c.getObject('obj')).toEqual({ key: 'value' });
    expect(c.getConfig('obj').getString('key')).toBe('value');
  });

  test('hasPath returns true / false correctly', () => {
    expect(c.hasPath('s')).toBe(true);
    expect(c.hasPath('obj.key')).toBe(true);
    expect(c.hasPath('missing')).toBe(false);
  });

  test('missing path raises ConfigError', () => {
    expect(() => c.getString('missing')).toThrow(ConfigError);
    expect(() => c.getConfig('missing')).toThrow(ConfigError);
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
    const overlay = Config.fromObject({ b: 20, c: 30 });
    expect(base.merge(overlay).toJSON()).toEqual({ a: 1, b: 20, c: 30 });
  });

  test('atPath wraps the tree under the given path', () => {
    const c = Config.fromObject({ x: 1 }).atPath('foo.bar');
    expect(c.toJSON()).toEqual({ foo: { bar: { x: 1 } } });
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
    const c = Config.load({ overrides });
    expect(c.getDuration('actor-ts.cluster.gossip-interval')).toBe(100);
    // Not overridden — still reference value.
    expect(c.getInt('actor-ts.sharding.number-of-shards')).toBe(64);
  });

  test('ignores missing application.conf silently', () => {
    const c = Config.load({ appConfPath: '/no/such/file.conf' });
    expect(c.getInt('actor-ts.sharding.number-of-shards')).toBe(64);
  });
});
