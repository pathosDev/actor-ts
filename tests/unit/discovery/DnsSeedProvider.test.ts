import { describe, expect, test } from 'bun:test';
import { DnsSeedProvider, DnsSeedProviderOptions } from '../../../src/discovery/DnsSeedProvider.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('DnsSeedProvider — basic lookup', () => {
  test('A-record mode pairs IPs with the configured port', async () => {
    let calls = 0;
    const provider = new DnsSeedProvider(
      DnsSeedProviderOptions.create()
        .withHostname('cluster.local').withSystemName('sys').withPort(2552)
        .withCacheTtlMs(0)
        .withResolve(async () => { calls++; return ['10.0.0.1', '10.0.0.2']; }),
    );
    const seeds = await provider.lookup();
    expect(seeds).toHaveLength(2);
    expect(seeds[0]!.host).toBe('10.0.0.1');
    expect(seeds[0]!.port).toBe(2552);
    expect(calls).toBe(1);
  });

  test('SRV mode uses the port from each record', async () => {
    const provider = new DnsSeedProvider(
      DnsSeedProviderOptions.create()
        .withHostname('cluster.local').withSystemName('sys').withPort(2552).withUseSrv(true)
        .withCacheTtlMs(0)
        .withResolveSrv(async () => [
          { name: 'pod-1', port: 2551 },
          { name: 'pod-2', port: 2553 },
        ]),
    );
    const seeds = await provider.lookup();
    expect(seeds.map((s) => s.port)).toEqual([2551, 2553]);
  });
});

describe('DnsSeedProvider — TTL cache', () => {
  test('repeated lookups within TTL hit the cache', async () => {
    let calls = 0;
    const provider = new DnsSeedProvider(
      DnsSeedProviderOptions.create()
        .withHostname('cluster.local').withSystemName('sys').withPort(2552)
        .withCacheTtlMs(60_000)
        .withResolve(async () => { calls++; return ['10.0.0.1']; }),
    );
    await provider.lookup();
    await provider.lookup();
    await provider.lookup();
    expect(calls).toBe(1);
  });

  test('after TTL elapses, DNS is hit again', async () => {
    let calls = 0;
    const provider = new DnsSeedProvider(
      DnsSeedProviderOptions.create()
        .withHostname('cluster.local').withSystemName('sys').withPort(2552)
        .withCacheTtlMs(30)
        .withResolve(async () => { calls++; return ['10.0.0.1']; }),
    );
    await provider.lookup();
    await sleep(50);
    await provider.lookup();
    expect(calls).toBe(2);
  });

  test('cacheTtlMs=0 disables caching entirely', async () => {
    let calls = 0;
    const provider = new DnsSeedProvider(
      DnsSeedProviderOptions.create()
        .withHostname('cluster.local').withSystemName('sys').withPort(2552)
        .withCacheTtlMs(0)
        .withResolve(async () => { calls++; return ['10.0.0.1']; }),
    );
    await provider.lookup();
    await provider.lookup();
    expect(calls).toBe(2);
  });

  test('a thrown lookup is NOT cached (next call retries)', async () => {
    let calls = 0;
    const provider = new DnsSeedProvider(
      DnsSeedProviderOptions.create()
        .withHostname('cluster.local').withSystemName('sys').withPort(2552)
        .withCacheTtlMs(60_000)
        .withResolve(async () => {
          calls++;
          if (calls === 1) throw new Error('NXDOMAIN');
          return ['10.0.0.1'];
        }),
    );
    await expect(provider.lookup()).rejects.toThrow();
    const second = await provider.lookup();
    expect(second).toHaveLength(1);
    expect(calls).toBe(2);
  });

  test('rejects negative cacheTtlMs', () => {
    expect(() => new DnsSeedProvider(
      DnsSeedProviderOptions.create()
        .withHostname('x').withSystemName('sys').withPort(1).withCacheTtlMs(-1),
    )).toThrow();
  });

  test('invalidateCacheForTest() forces re-lookup', async () => {
    let calls = 0;
    const provider = new DnsSeedProvider(
      DnsSeedProviderOptions.create()
        .withHostname('cluster.local').withSystemName('sys').withPort(2552)
        .withCacheTtlMs(60_000)
        .withResolve(async () => { calls++; return ['10.0.0.1']; }),
    );
    await provider.lookup();
    provider.invalidateCacheForTest();
    await provider.lookup();
    expect(calls).toBe(2);
  });
});
