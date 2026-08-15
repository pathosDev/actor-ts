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
import { endpointsPath } from '../../../src/discovery/KubernetesApiSeedProvider.js';

describe('ConfigSeedProvider', () => {
  test('returns parsed NodeAddresses', async () => {
    const configSeedOptions = ConfigSeedProviderOptions.create()
      .withSeeds(['sys@h1:1000', 'h2:2000'])
      .withSystemName('sys');
    const provider = new ConfigSeedProvider(
      configSeedOptions,
    );
    const addrs = await provider.lookup();
    expect(addrs.map(a => a.toString())).toEqual(['sys@h1:1000', 'sys@h2:2000']);
  });

  test('seedsFromEnv reads a comma-separated list', async () => {
    process.env.TEST_SEEDS = 'h1:1000, h2:2000,h3:3000';
    const provider = seedsFromEnv('TEST_SEEDS', 'sys');
    const addrs = await provider.lookup();
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
    const provider = new DnsSeedProvider(
      dnsOptions,
    );
    const addrs = await provider.lookup();
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
    const provider = new DnsSeedProvider(
      dnsOptions,
    );
    const addrs = await provider.lookup();
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
    const provider = new KubernetesApiSeedProvider(
      k8sSeedOptions,
    );
    const addrs = await provider.lookup();
    expect(addrs.length).toBe(2);
    expect(addrs[0]!.toString()).toBe('sys@10.244.0.1:2552');
  });
});

// The default fetcher's path construction had no test at all: every test
// and even the k3s integration runner injects `fetchEndpoints`, which
// replaces the fetcher wholesale.  `endpointsPath` is the seam that makes
// it observable — it is what the fetcher calls.
describe('KubernetesApiSeedProvider — endpoints path (#597)', () => {
  test('builds the documented path for ordinary names', () => {
    expect(endpointsPath('actors', 'actor-ts')).toBe('/api/v1/namespaces/actors/endpoints/actor-ts');
  });

  test('percent-encodes the service name, so a traversal stays in its own segment', () => {
    // The payload from #597: without encoding this GET resolved against a
    // different namespace's Endpoints, with the pod's ServiceAccount token
    // attached, and those addresses became the node's seed list.
    const path = endpointsPath('default', 'app/../../../namespaces/attacker-ns/endpoints/decoy');
    expect(path).toBe(
      '/api/v1/namespaces/default/endpoints/'
      + 'app%2F..%2F..%2F..%2Fnamespaces%2Fattacker-ns%2Fendpoints%2Fdecoy',
    );
    // Traversal needs separators; after encoding the path has exactly the
    // six it is built from.
    expect(path.split('/').length).toBe(7);
  });

  test('percent-encodes the namespace too', () => {
    expect(endpointsPath('../../secrets', 'actor-ts'))
      .toBe('/api/v1/namespaces/..%2F..%2Fsecrets/endpoints/actor-ts');
  });

  test('a query suffix cannot escape the path — `?watch=true` never terminates', () => {
    // `?watch=true` turned the one-shot GET into a stream the body
    // accumulator in the fetcher waits on forever.
    const path = endpointsPath('default', 'actor-ts?watch=true');
    expect(path).toBe('/api/v1/namespaces/default/endpoints/actor-ts%3Fwatch%3Dtrue');
    expect(path).not.toContain('?');
  });

  test('encodes every separator a path could be split on, in both segments', () => {
    // Expectations are spelled out rather than computed with
    // encodeURIComponent, which would only restate the implementation.
    const cases: Array<readonly [raw: string, encoded: string]> = [
      ['a/b', 'a%2Fb'],
      ['a?b', 'a%3Fb'],
      ['a#b', 'a%23b'],
      ['a b', 'a%20b'],
      ['a&b=c', 'a%26b%3Dc'],
    ];
    for (const [raw, encoded] of cases) {
      expect(endpointsPath(raw, raw)).toBe(`/api/v1/namespaces/${encoded}/endpoints/${encoded}`);
    }
  });
});
