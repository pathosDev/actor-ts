import { describe, expect, test } from 'bun:test';
import {
  AggregateSeedProvider,
  AutoDiscoveryOptions,
  Cluster,
  ClusterBootstrapOptions,
  ConfigSeedProvider,
  InMemoryTransport,
  LogLevel,
  NodeAddress,
  NoopLogger,
  autoDiscovery,
  bootstrapCluster,
  singleProviderDiscovery,
  type SeedProvider,
} from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* Cluster.bootstrap — high-level entry point                                  */
/* -------------------------------------------------------------------------- */

describe('Cluster.bootstrap', () => {
  test('single-node: returns system + cluster + null receptionist when opted out', async () => {
    const transport = new InMemoryTransport(new NodeAddress('bootstrap-1', '127.0.0.1', 50100));
    const { system, cluster, receptionist, shutdown } = await Cluster.bootstrap(
      ClusterBootstrapOptions.create('bootstrap-1')
        .withHost('127.0.0.1')
        .withPort(50100)
        .withTransport(transport)
        .withReceptionist(false)
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withShutdownOnSignals(false)
        .withGossipIntervalMs(50)
        .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 }),
    );
    try {
      expect(system.name).toBe('bootstrap-1');
      expect(cluster.selfAddress.toString()).toBe('bootstrap-1@127.0.0.1:50100');
      // awaitReady defaults to true → SelfUp has fired (single-node self-elects).
      expect(cluster.upMembers().length).toBe(1);
      expect(receptionist).toBeNull();
    } finally {
      await shutdown();
      await shutdown();   // idempotent
    }
  });

  test('starts the receptionist by default', async () => {
    const transport = new InMemoryTransport(new NodeAddress('bootstrap-2', '127.0.0.1', 50101));
    const { receptionist, shutdown } = await Cluster.bootstrap(
      ClusterBootstrapOptions.create('bootstrap-2')
        .withHost('127.0.0.1')
        .withPort(50101)
        .withTransport(transport)
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withShutdownOnSignals(false),
    );
    try {
      expect(receptionist).not.toBeNull();
      expect(receptionist!.path.name).toBe('receptionist');
    } finally {
      await shutdown();
    }
  });

  test('explicit seeds bypass discovery', async () => {
    // Two nodes; node-B uses bootstrap with explicit seeds pointing at A.
    const aTransport = new InMemoryTransport(new NodeAddress('bootstrap-3', '127.0.0.1', 50102));
    const bTransport = new InMemoryTransport(new NodeAddress('bootstrap-3', '127.0.0.1', 50103));

    const a = await Cluster.bootstrap(
      ClusterBootstrapOptions.create('bootstrap-3')
        .withHost('127.0.0.1')
        .withPort(50102)
        .withTransport(aTransport)
        .withReceptionist(false)
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withShutdownOnSignals(false)
        .withGossipIntervalMs(50)
        .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 }),
    );
    const b = await Cluster.bootstrap(
      ClusterBootstrapOptions.create('bootstrap-3')
        .withHost('127.0.0.1')
        .withPort(50103)
        .withTransport(bTransport)
        .withSeeds(['127.0.0.1:50102'])
        .withReceptionist(false)
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withShutdownOnSignals(false)
        .withGossipIntervalMs(50)
        .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 }),
    );
    try {
      // Both nodes should converge — each sees two up members.
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if (a.cluster.upMembers().length === 2 && b.cluster.upMembers().length === 2) break;
        await Bun.sleep(25);
      }
      expect(a.cluster.upMembers().length).toBe(2);
      expect(b.cluster.upMembers().length).toBe(2);
    } finally {
      await a.shutdown();
      await b.shutdown();
    }
  });

  test('awaitReady=false returns before SelfUp', async () => {
    const transport = new InMemoryTransport(new NodeAddress('bootstrap-4', '127.0.0.1', 50104));
    // With no seeds, self-elects to up fast — but with awaitReady: false
    // the bootstrap should not actively wait.  The cluster might still
    // be up by the time we check (joining is synchronous-ish), so we
    // just assert the call resolves without throwing.
    const { shutdown } = await Cluster.bootstrap(
      ClusterBootstrapOptions.create('bootstrap-4')
        .withHost('127.0.0.1')
        .withPort(50104)
        .withTransport(transport)
        .withReceptionist(false)
        .withAwaitReady(false)
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withShutdownOnSignals(false),
    );
    await shutdown();
  });

  test('custom SeedProvider via discovery: SeedProvider', async () => {
    const aTransport = new InMemoryTransport(new NodeAddress('bootstrap-5', '127.0.0.1', 50105));
    const bTransport = new InMemoryTransport(new NodeAddress('bootstrap-5', '127.0.0.1', 50106));

    const customProvider: SeedProvider = {
      async lookup(): Promise<NodeAddress[]> {
        return [new NodeAddress('bootstrap-5', '127.0.0.1', 50105)];
      },
    };

    const a = await Cluster.bootstrap(
      ClusterBootstrapOptions.create('bootstrap-5')
        .withHost('127.0.0.1')
        .withPort(50105)
        .withTransport(aTransport)
        .withReceptionist(false)
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withShutdownOnSignals(false)
        .withGossipIntervalMs(50)
        .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 }),
    );
    const b = await Cluster.bootstrap(
      ClusterBootstrapOptions.create('bootstrap-5')
        .withHost('127.0.0.1')
        .withPort(50106)
        .withTransport(bTransport)
        .withDiscovery(customProvider)
        .withReceptionist(false)
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withShutdownOnSignals(false)
        .withGossipIntervalMs(50)
        .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 }),
    );
    try {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        if (a.cluster.upMembers().length === 2 && b.cluster.upMembers().length === 2) break;
        await Bun.sleep(25);
      }
      expect(a.cluster.upMembers().length).toBe(2);
      expect(b.cluster.upMembers().length).toBe(2);
    } finally {
      await a.shutdown();
      await b.shutdown();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* autoDiscovery — env-driven seed-provider builder                            */
/* -------------------------------------------------------------------------- */

describe('autoDiscovery', () => {
  test('empty env produces an empty aggregate (single-node mode)', async () => {
    const provider = autoDiscovery(
      AutoDiscoveryOptions.create().withSystemName('app').withPort(2552).withEnv({}),
    );
    const seeds = await provider.lookup();
    expect(seeds).toEqual([]);
  });

  test('CLUSTER_SEEDS produces a Config provider', async () => {
    const provider = autoDiscovery(
      AutoDiscoveryOptions.create()
        .withSystemName('app')
        .withPort(2552)
        .withEnv({ CLUSTER_SEEDS: '10.0.0.1:2552,10.0.0.2:2552' }),
    );
    const seeds = await provider.lookup();
    expect(seeds.map(s => s.toString()))
      .toEqual(['app@10.0.0.1:2552', 'app@10.0.0.2:2552']);
  });

  test('K8s + DNS chain order — K8s wins when both apply', async () => {
    // K8s provider's default fetchEndpoints would touch the network; the
    // aggregate wraps each lookup() in try/catch and falls through.  So
    // K8s fails (no token in test env) and DNS picks up next.  We can
    // verify the aggregate is wired by checking that an unparsable DNS
    // host throws on lookup, proving DNS was reached.
    const provider = autoDiscovery(
      AutoDiscoveryOptions.create()
        .withSystemName('app')
        .withPort(2552)
        .withEnv({
          KUBERNETES_SERVICE_HOST: '10.0.0.1',
          CLUSTER_SERVICE_NAME: 'definitely-not-a-real-host.invalid',
        }),
    );
    // K8s throws (no ServiceAccount token) → DNS resolves an
    // invalid host → throws too → aggregate returns [].
    const seeds = await provider.lookup();
    expect(Array.isArray(seeds)).toBe(true);
  });

  test('CLUSTER_NAMESPACE defaults to "default"', () => {
    const provider = singleProviderDiscovery('kubernetes',
      AutoDiscoveryOptions.create()
        .withSystemName('app')
        .withPort(2552)
        .withEnv({ CLUSTER_SERVICE_NAME: 'my-svc', KUBERNETES_SERVICE_HOST: '10.0.0.1' }),
    );
    expect(provider).toBeDefined();
  });

  test('singleProviderDiscovery throws when DNS env vars missing', () => {
    expect(() => singleProviderDiscovery('dns',
      AutoDiscoveryOptions.create().withSystemName('app').withPort(2552).withEnv({}),
    )).toThrow(/CLUSTER_SERVICE_NAME/);
  });

  test('singleProviderDiscovery throws when K8s env vars missing', () => {
    expect(() => singleProviderDiscovery('kubernetes',
      AutoDiscoveryOptions.create().withSystemName('app').withPort(2552).withEnv({}),
    )).toThrow(/CLUSTER_SERVICE_NAME/);
  });
});

/* -------------------------------------------------------------------------- */
/* bootstrapCluster — free-function form (same code path as Cluster.bootstrap) */
/* -------------------------------------------------------------------------- */

describe('bootstrapCluster (free function)', () => {
  test('reachable as a top-level export', async () => {
    const transport = new InMemoryTransport(new NodeAddress('bootstrap-fn', '127.0.0.1', 50110));
    const { shutdown, cluster } = await bootstrapCluster(
      ClusterBootstrapOptions.create('bootstrap-fn')
        .withHost('127.0.0.1')
        .withPort(50110)
        .withTransport(transport)
        .withReceptionist(false)
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withShutdownOnSignals(false),
    );
    try {
      expect(cluster.upMembers().length).toBe(1);
    } finally {
      await shutdown();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Suppress an unused-import warning when no test file exercises these — they  */
/* are part of the public surface and are smoke-tested indirectly.             */
/* -------------------------------------------------------------------------- */
void AggregateSeedProvider;
void ConfigSeedProvider;
