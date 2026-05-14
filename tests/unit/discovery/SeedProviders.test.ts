import { describe, expect, test } from 'bun:test';
import {
  AggregateSeedProvider,
  ConfigSeedProvider,
  DnsSeedProvider,
  KubernetesApiSeedProvider,
  seedsFromEnv,
} from '../../../src/discovery/index.js';

describe('ConfigSeedProvider', () => {
  test('returns parsed NodeAddresses', async () => {
    const p = new ConfigSeedProvider({
      seeds: ['sys@h1:1000', 'h2:2000'], systemName: 'sys',
    });
    const addrs = await p.lookup();
    expect(addrs.map(a => a.toString())).toEqual(['sys@h1:1000', 'sys@h2:2000']);
  });

  test('seedsFromEnv reads a comma-separated list', async () => {
    process.env.TEST_SEEDS = 'h1:1000, h2:2000,h3:3000';
    const p = seedsFromEnv('TEST_SEEDS', 'sys');
    const addrs = await p.lookup();
    expect(addrs.length).toBe(3);
    expect(addrs[0]!.host).toBe('h1');
    delete process.env.TEST_SEEDS;
  });
});

describe('DnsSeedProvider', () => {
  test('resolves A records via injected function', async () => {
    const p = new DnsSeedProvider({
      hostname: 'fake.local', systemName: 'sys', port: 2552,
      resolve: async () => ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
    });
    const addrs = await p.lookup();
    expect(addrs.map(a => a.host)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    expect(addrs[0]!.port).toBe(2552);
  });

  test('SRV mode takes ports from the records', async () => {
    const p = new DnsSeedProvider({
      hostname: '_actor-ts._tcp.fake.local', systemName: 'sys', port: 0,
      useSrv: true,
      resolveSrv: async () => [
        { name: 'h1.fake.local', port: 2552 },
        { name: 'h2.fake.local', port: 3552 },
      ],
    });
    const addrs = await p.lookup();
    expect(addrs.length).toBe(2);
    expect(addrs[0]!.port).toBe(2552);
    expect(addrs[1]!.port).toBe(3552);
  });
});

describe('AggregateSeedProvider', () => {
  test('first non-empty provider wins', async () => {
    const empty = { lookup: async () => [] };
    const fallback = new ConfigSeedProvider({ seeds: ['sys@h:1000'], systemName: 'sys' });
    const ok = new ConfigSeedProvider({ seeds: ['sys@h:2000'], systemName: 'sys' });
    const agg = new AggregateSeedProvider([empty, ok, fallback]);
    const addrs = await agg.lookup();
    expect(addrs[0]!.port).toBe(2000);
  });

  test('errors in earlier providers are caught and logged', async () => {
    const errors: unknown[] = [];
    const thrower = { lookup: async () => { throw new Error('boom'); } };
    const ok = new ConfigSeedProvider({ seeds: ['sys@h:1000'], systemName: 'sys' });
    const agg = new AggregateSeedProvider([thrower, ok], (_m, e) => errors.push(e));
    const addrs = await agg.lookup();
    expect(addrs[0]!.port).toBe(1000);
    expect(errors.length).toBe(1);
  });

  test('returns empty when every provider yields nothing', async () => {
    const empty1 = { lookup: async () => [] };
    const empty2 = { lookup: async () => [] };
    const addrs = await new AggregateSeedProvider([empty1, empty2]).lookup();
    expect(addrs).toEqual([]);
  });
});

describe('KubernetesApiSeedProvider', () => {
  test('maps returned pod IPs into NodeAddresses', async () => {
    const p = new KubernetesApiSeedProvider({
      namespace: 'default', serviceName: 'cluster-app', systemName: 'sys', port: 2552,
      fetchEndpoints: async () => ['10.244.0.1', '10.244.0.2'],
    });
    const addrs = await p.lookup();
    expect(addrs.length).toBe(2);
    expect(addrs[0]!.toString()).toBe('sys@10.244.0.1:2552');
  });
});
