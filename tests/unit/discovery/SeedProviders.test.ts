import { describe, expect, test } from 'bun:test';
import {
  AggregateSeedProvider,
  ConfigSeedProvider,
  ConfigSeedProviderOptions,
  DnsSeedProvider,
  DnsSeedProviderOptions,
  KubernetesApiSeedProvider,
  KubernetesApiSeedProviderOptions,
  seedsFromEnv,
} from '../../../src/discovery/index.js';

describe('ConfigSeedProvider', () => {
  test('returns parsed NodeAddresses', async () => {
    const configSeedOptions = ConfigSeedProviderOptions.create()
      .withSeeds(['sys@h1:1000', 'h2:2000'])
      .withSystemName('sys');
    const p = new ConfigSeedProvider(
      configSeedOptions,
    );
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
    const dnsOptions = DnsSeedProviderOptions.create()
      .withHostname('fake.local')
      .withSystemName('sys')
      .withPort(2552)
      .withResolve(async () => ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    const p = new DnsSeedProvider(
      dnsOptions,
    );
    const addrs = await p.lookup();
    expect(addrs.map(a => a.host)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    expect(addrs[0]!.port).toBe(2552);
  });

  test('SRV mode takes ports from the records', async () => {
    const dnsOptions = DnsSeedProviderOptions.create()
      .withHostname('_actor-ts._tcp.fake.local')
      .withSystemName('sys')
      .withPort(0)
      .withUseSrv(true)
      .withResolveSrv(async () => [ { name: 'h1.fake.local', port: 2552 }, { name: 'h2.fake.local', port: 3552 }, ]);
    const p = new DnsSeedProvider(
      dnsOptions,
    );
    const addrs = await p.lookup();
    expect(addrs.length).toBe(2);
    expect(addrs[0]!.port).toBe(2552);
    expect(addrs[1]!.port).toBe(3552);
  });
});

describe('AggregateSeedProvider', () => {
  test('first non-empty provider wins', async () => {
    const empty = { lookup: async () => [] };
    const configSeedOptions = ConfigSeedProviderOptions.create()
      .withSeeds(['sys@h:1000'])
      .withSystemName('sys');
    const fallback = new ConfigSeedProvider(
      configSeedOptions,
    );
    const configSeedOptions2 = ConfigSeedProviderOptions.create()
      .withSeeds(['sys@h:2000'])
      .withSystemName('sys');
    const ok = new ConfigSeedProvider(
      configSeedOptions2,
    );
    const agg = new AggregateSeedProvider([empty, ok, fallback]);
    const addrs = await agg.lookup();
    expect(addrs[0]!.port).toBe(2000);
  });

  test('errors in earlier providers are caught and logged', async () => {
    const errors: unknown[] = [];
    const thrower = { lookup: async () => { throw new Error('boom'); } };
    const configSeedOptions = ConfigSeedProviderOptions.create()
      .withSeeds(['sys@h:1000'])
      .withSystemName('sys');
    const ok = new ConfigSeedProvider(
      configSeedOptions,
    );
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
    const k8sSeedOptions = KubernetesApiSeedProviderOptions.create()
      .withNamespace('default')
      .withServiceName('cluster-app')
      .withSystemName('sys')
      .withPort(2552)
      .withFetchEndpoints(async () => ['10.244.0.1', '10.244.0.2']);
    const p = new KubernetesApiSeedProvider(
      k8sSeedOptions,
    );
    const addrs = await p.lookup();
    expect(addrs.length).toBe(2);
    expect(addrs[0]!.toString()).toBe('sys@10.244.0.1:2552');
  });
});
