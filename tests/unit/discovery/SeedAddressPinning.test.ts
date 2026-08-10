import { describe, expect, test } from 'bun:test';
import { DnsSeedProvider } from '../../../src/discovery/DnsSeedProvider.js';
import { DnsSeedProviderOptions } from '../../../src/discovery/DnsSeedProviderOptions.js';
import { KubernetesApiSeedProvider } from '../../../src/discovery/KubernetesApiSeedProvider.js';
import { KubernetesApiSeedProviderOptions } from '../../../src/discovery/KubernetesApiSeedProviderOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

describe('DnsSeedProvider — pinning in A-record mode', () => {
  test('keeps addresses inside the pinned CIDRs and drops the rest', async () => {
    const dropped: string[] = [];
    const dnsOptions = DnsSeedProviderOptions.create()
      .withHostname('cluster.local')
      .withSystemName('sys')
      .withPort(2552)
      .withCacheTtlMs(0)
      .withPinnedAddresses(['10.0.0.0/8'])
      .withLog((message) => { dropped.push(message); })
      .withResolve(async () => ['10.0.0.1', '203.0.113.5', '10.0.0.2']);
    const provider = new DnsSeedProvider(dnsOptions);

    const seeds = await provider.lookup();
    expect(seeds.map((s) => s.host)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!).toContain('203.0.113.5');
    expect(dropped[0]!).toContain('pinnedAddresses');
  });

  test('an unset pin list accepts whatever DNS returned', async () => {
    const dnsOptions = DnsSeedProviderOptions.create()
      .withHostname('cluster.local')
      .withSystemName('sys')
      .withPort(2552)
      .withCacheTtlMs(0)
      .withResolve(async () => ['10.0.0.1', '203.0.113.5']);
    const provider = new DnsSeedProvider(dnsOptions);

    expect((await provider.lookup()).map((s) => s.host)).toEqual(['10.0.0.1', '203.0.113.5']);
  });

  test('a dual-stack answer normalises against an IPv4 CIDR', async () => {
    const dnsOptions = DnsSeedProviderOptions.create()
      .withHostname('cluster.local')
      .withSystemName('sys')
      .withPort(2552)
      .withCacheTtlMs(0)
      .withPinnedAddresses(['10.0.0.0/8'])
      .withResolve(async () => ['::ffff:10.0.0.1', '::ffff:203.0.113.5']);
    const provider = new DnsSeedProvider(dnsOptions);

    expect((await provider.lookup()).map((s) => s.host)).toEqual(['::ffff:10.0.0.1']);
  });

  test('a poisoned answer with nothing pinned yields no seeds at all', async () => {
    const dnsOptions = DnsSeedProviderOptions.create()
      .withHostname('cluster.local')
      .withSystemName('sys')
      .withPort(2552)
      .withCacheTtlMs(0)
      .withPinnedAddresses(['10.0.0.0/8'])
      .withResolve(async () => ['203.0.113.5', '198.51.100.9']);
    const provider = new DnsSeedProvider(dnsOptions);

    expect(await provider.lookup()).toEqual([]);
  });

  test('the filtered list is what gets cached', async () => {
    let calls = 0;
    const dnsOptions = DnsSeedProviderOptions.create()
      .withHostname('cluster.local')
      .withSystemName('sys')
      .withPort(2552)
      .withCacheTtlMs(60_000)
      .withPinnedAddresses(['10.0.0.0/8'])
      .withResolve(async () => { calls++; return ['10.0.0.1', '203.0.113.5']; });
    const provider = new DnsSeedProvider(dnsOptions);

    expect((await provider.lookup()).map((s) => s.host)).toEqual(['10.0.0.1']);
    expect((await provider.lookup()).map((s) => s.host)).toEqual(['10.0.0.1']);
    expect(calls).toBe(1);
  });
});

describe('DnsSeedProvider — pinning in SRV mode', () => {
  test('host suffixes match the SRV target names', async () => {
    const dropped: string[] = [];
    const dnsOptions = DnsSeedProviderOptions.create()
      .withHostname('_actor-ts._tcp.cluster.local')
      .withSystemName('sys')
      .withPort(0)
      .withUseSrv()
      .withCacheTtlMs(0)
      .withPinnedAddresses(['svc.cluster.local'])
      .withLog((message) => { dropped.push(message); })
      .withResolveSrv(async () => [
        { name: 'pod-1.svc.cluster.local', port: 2551 },
        { name: 'attacker.example.com', port: 2552 },
      ]);
    const provider = new DnsSeedProvider(dnsOptions);

    const seeds = await provider.lookup();
    expect(seeds.map((s) => s.host)).toEqual(['pod-1.svc.cluster.local']);
    expect(dropped[0]!).toContain('attacker.example.com');
  });

  test('a look-alike name outside the zone is dropped', async () => {
    const dnsOptions = DnsSeedProviderOptions.create()
      .withHostname('_actor-ts._tcp.cluster.local')
      .withSystemName('sys')
      .withPort(0)
      .withUseSrv()
      .withCacheTtlMs(0)
      .withPinnedAddresses(['svc.cluster.local'])
      .withResolveSrv(async () => [
        { name: 'evilsvc.cluster.local', port: 2552 },
        { name: 'svc.cluster.local.attacker.example', port: 2552 },
      ]);
    const provider = new DnsSeedProvider(dnsOptions);

    expect(await provider.lookup()).toEqual([]);
  });

  test('a CIDR-only pin list is rejected instead of discarding every record', () => {
    // SRV targets are hostnames, never IPs — an IP-only pin list would
    // match nothing, and an empty seed list reads as "first node up".
    const dnsOptions = DnsSeedProviderOptions.create()
      .withHostname('_actor-ts._tcp.cluster.local')
      .withSystemName('sys')
      .withPort(0)
      .withUseSrv()
      .withPinnedAddresses(['10.0.0.0/8']);
    expect(() => new DnsSeedProvider(dnsOptions)).toThrow(/at least one host-suffix entry in SRV mode/);
    expect(() => new DnsSeedProvider(dnsOptions)).toThrow(OptionsError);
  });

  test('a mixed list satisfies both modes', async () => {
    const dnsOptions = DnsSeedProviderOptions.create()
      .withHostname('_actor-ts._tcp.cluster.local')
      .withSystemName('sys')
      .withPort(0)
      .withUseSrv()
      .withCacheTtlMs(0)
      .withPinnedAddresses(['10.0.0.0/8', 'svc.cluster.local'])
      .withResolveSrv(async () => [{ name: 'pod-1.svc.cluster.local', port: 2551 }]);
    const provider = new DnsSeedProvider(dnsOptions);

    expect((await provider.lookup()).map((s) => s.host)).toEqual(['pod-1.svc.cluster.local']);
  });
});

describe('DnsSeedProviderOptionsValidator — pin list', () => {
  const base = () => DnsSeedProviderOptions.create()
    .withHostname('cluster.local')
    .withSystemName('sys')
    .withPort(2552);

  test('a suffix-only list is rejected in A-record mode', () => {
    const dnsOptions = base().withPinnedAddresses(['svc.cluster.local']);
    expect(() => new DnsSeedProvider(dnsOptions)).toThrow(/at least one CIDR entry in A-record mode/);
  });

  test('an empty list is rejected rather than read as "pinning off"', () => {
    const dnsOptions = base().withPinnedAddresses([]);
    expect(() => new DnsSeedProvider(dnsOptions)).toThrow(/at least one entry/);
  });

  test('a bare IP is rejected with the CIDR spelling to use', () => {
    const dnsOptions = base().withPinnedAddresses(['10.0.0.1']);
    expect(() => new DnsSeedProvider(dnsOptions)).toThrow(/bare IP address/);
  });

  test('a malformed CIDR is rejected', () => {
    const dnsOptions = base().withPinnedAddresses(['10.0.0.0/33']);
    expect(() => new DnsSeedProvider(dnsOptions)).toThrow(/valid CIDRs/);
  });

  test('a plain options object is validated the same way as a builder', () => {
    expect(() => new DnsSeedProvider({
      hostname: 'cluster.local',
      systemName: 'sys',
      port: 2552,
      pinnedAddresses: ['svc.cluster.local'],
    })).toThrow(OptionsError);
  });
});

describe('KubernetesApiSeedProvider — pinning', () => {
  const base = () => KubernetesApiSeedProviderOptions.create()
    .withNamespace('actors')
    .withServiceName('actor-ts')
    .withSystemName('sys')
    .withPort(2552);

  test('keeps pod IPs inside the pod CIDR and drops the rest', async () => {
    const dropped: string[] = [];
    const kubernetesOptions = base()
      .withPinnedAddresses(['10.244.0.0/16'])
      .withLog((message) => { dropped.push(message); })
      .withFetchEndpoints(async () => ['10.244.1.7', '203.0.113.5']);
    const provider = new KubernetesApiSeedProvider(kubernetesOptions);

    expect((await provider.lookup()).map((s) => s.host)).toEqual(['10.244.1.7']);
    expect(dropped[0]!).toContain('Endpoints/actor-ts');
  });

  test('an unset pin list accepts every endpoint', async () => {
    const kubernetesOptions = base()
      .withFetchEndpoints(async () => ['10.244.1.7', '203.0.113.5']);
    const provider = new KubernetesApiSeedProvider(kubernetesOptions);

    expect((await provider.lookup()).map((s) => s.host)).toEqual(['10.244.1.7', '203.0.113.5']);
  });

  test('a host suffix is rejected — Endpoints are always IPs', () => {
    const kubernetesOptions = base().withPinnedAddresses(['svc.cluster.local']);
    expect(() => new KubernetesApiSeedProvider(kubernetesOptions)).toThrow(/CIDRs only/);
    expect(() => new KubernetesApiSeedProvider(kubernetesOptions)).toThrow(OptionsError);
  });

  test('an empty list is rejected', () => {
    const kubernetesOptions = base().withPinnedAddresses([]);
    expect(() => new KubernetesApiSeedProvider(kubernetesOptions)).toThrow(/at least one entry/);
  });
});
