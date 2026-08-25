import { describe, expect, test } from 'bun:test';
import {
  LogLevel,
  NoopLogger,
  OptionsError,
} from '../src/index.js';
import {
  Cluster,
  ClusterBootstrapOptions,
  InMemoryTransport,
  NodeAddress,
  bootstrapCluster,
} from '../src/cluster/index.js';
import {
  AggregateSeedProvider,
  AutoDiscoveryOptions,
  ConfigSeedProvider,
  DnsSeedProvider,
  KubernetesApiSeedProvider,
  KubernetesApiSeedProviderOptions,
  autoDiscovery,
  singleProviderDiscovery,
  type SeedProvider,
} from '../src/discovery/index.js';
import { awaitCondition } from './util/AwaitCondition.js';

/* -------------------------------------------------------------------------- */
/* Cluster.bootstrap — high-level entry point                                  */
/* -------------------------------------------------------------------------- */

describe('Cluster.bootstrap', () => {
  test('single-node: returns system + cluster + null receptionist when opted out', async () => {
    const transport = new InMemoryTransport(new NodeAddress('bootstrap-1', '127.0.0.1', 50100));
    const clusterBootstrapOptions = ClusterBootstrapOptions.create('bootstrap-1')
      .withHost('127.0.0.1')
      .withPort(50100)
      .withTransport(transport)
      .withReceptionist(false)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withShutdownOnSignals(false)
      .withGossipIntervalMs(50)
      .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 });
    const { system, cluster, receptionist, shutdown } = await Cluster.bootstrap(
      clusterBootstrapOptions,
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

  test('binds the wildcard and advertises the host it was given (#944)', async () => {
    // The Kubernetes shape: the pod does not know its address at start-up, so
    // it binds every interface — but what it gossips has to be the one address
    // peers can dial back, or every node advertises the same string and none
    // of them ever sees another member.
    const transport = new InMemoryTransport(new NodeAddress('bootstrap-split', '10.0.0.5', 50120));
    const clusterBootstrapOptions = ClusterBootstrapOptions.create('bootstrap-split')
      .withHost('0.0.0.0')
      .withAdvertisedHost('10.0.0.5')
      .withPort(50120)
      .withTransport(transport)
      .withReceptionist(false)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withShutdownOnSignals(false);
    const { cluster, shutdown } = await Cluster.bootstrap(clusterBootstrapOptions);
    try {
      expect(cluster.selfAddress.toString()).toBe('bootstrap-split@10.0.0.5:50120');
    } finally {
      await shutdown();
    }
  });

  test('a bare wildcard bind host resolves to a dialable address, never a wildcard', async () => {
    // What this used to do was carry `0.0.0.0` straight into `selfAddress`.
    // Loopback is the last resort now: reachable from this machine only, which
    // is honest about an unconfigured node instead of colliding with every
    // other one.
    const saved = ['CLUSTER_HOST', 'POD_IP', 'HOSTNAME']
      .map((name) => [name, process.env[name]] as const);
    for (const [name] of saved) delete process.env[name];
    const transport = new InMemoryTransport(new NodeAddress('bootstrap-wild', '127.0.0.1', 50121));
    const clusterBootstrapOptions = ClusterBootstrapOptions.create('bootstrap-wild')
      .withHost('0.0.0.0')
      .withPort(50121)
      .withTransport(transport)
      .withReceptionist(false)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withShutdownOnSignals(false);
    try {
      const { cluster, shutdown } = await Cluster.bootstrap(clusterBootstrapOptions);
      try {
        expect(cluster.selfAddress.toString()).toBe('bootstrap-wild@127.0.0.1:50121');
      } finally {
        await shutdown();
      }
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('starts the receptionist by default', async () => {
    const transport = new InMemoryTransport(new NodeAddress('bootstrap-2', '127.0.0.1', 50101));
    const clusterBootstrapOptions = ClusterBootstrapOptions.create('bootstrap-2')
      .withHost('127.0.0.1')
      .withPort(50101)
      .withTransport(transport)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withShutdownOnSignals(false);
    const { receptionist, shutdown } = await Cluster.bootstrap(
      clusterBootstrapOptions,
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

    const clusterBootstrapOptions = ClusterBootstrapOptions.create('bootstrap-3')
      .withHost('127.0.0.1')
      .withPort(50102)
      .withTransport(aTransport)
      .withReceptionist(false)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withShutdownOnSignals(false)
      .withGossipIntervalMs(50)
      .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 });
    const nodeA = await Cluster.bootstrap(
      clusterBootstrapOptions,
    );
    const clusterBootstrapOptions2 = ClusterBootstrapOptions.create('bootstrap-3')
      .withHost('127.0.0.1')
      .withPort(50103)
      .withTransport(bTransport)
      .withSeeds(['127.0.0.1:50102'])
      .withReceptionist(false)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withShutdownOnSignals(false)
      .withGossipIntervalMs(50)
      .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 });
    const nodeB = await Cluster.bootstrap(
      clusterBootstrapOptions2,
    );
    try {
      // Both nodes should converge — each sees two up members.  The
      // hand-rolled deadline loop this replaces fell through silently, so a
      // convergence that merely took longer than the budget failed as
      // "expected 2, got 1" — indistinguishable from never converging at all.
      await awaitCondition(
        () => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
        { timeoutMs: 4_000, label: 'both bootstrapped nodes see a 2-member cluster' },
      );
      expect(nodeA.cluster.upMembers().length).toBe(2);
      expect(nodeB.cluster.upMembers().length).toBe(2);
    } finally {
      await nodeA.shutdown();
      await nodeB.shutdown();
    }
    // The 4 s budget fits bun's 5 s default with exactly 1 s to spare, and two
    // `Cluster.bootstrap` calls run before the wait even starts.  That is not a
    // failure budget, it is a coin toss over which message a stalled
    // convergence reports.  15 s leaves the budget as the thing that fires.
  }, 15_000);

  test('awaitReady=false returns before SelfUp', async () => {
    const transport = new InMemoryTransport(new NodeAddress('bootstrap-4', '127.0.0.1', 50104));
    // With no seeds, self-elects to up fast — but with awaitReady: false
    // the bootstrap should not actively wait.  The cluster might still
    // be up by the time we check (joining is synchronous-ish), so we
    // just assert the call resolves without throwing.
    const clusterBootstrapOptions = ClusterBootstrapOptions.create('bootstrap-4')
      .withHost('127.0.0.1')
      .withPort(50104)
      .withTransport(transport)
      .withReceptionist(false)
      .withAwaitReady(false)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withShutdownOnSignals(false);
    const { shutdown } = await Cluster.bootstrap(
      clusterBootstrapOptions,
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

    const clusterBootstrapOptions = ClusterBootstrapOptions.create('bootstrap-5')
      .withHost('127.0.0.1')
      .withPort(50105)
      .withTransport(aTransport)
      .withReceptionist(false)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withShutdownOnSignals(false)
      .withGossipIntervalMs(50)
      .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 });
    const nodeA = await Cluster.bootstrap(
      clusterBootstrapOptions,
    );
    const clusterBootstrapOptions2 = ClusterBootstrapOptions.create('bootstrap-5')
      .withHost('127.0.0.1')
      .withPort(50106)
      .withTransport(bTransport)
      .withDiscovery(customProvider)
      .withReceptionist(false)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withShutdownOnSignals(false)
      .withGossipIntervalMs(50)
      .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 });
    const nodeB = await Cluster.bootstrap(
      clusterBootstrapOptions2,
    );
    try {
      // The hand-rolled deadline loop this replaces fell through silently, so a
      // convergence that never happened arrived at the assertion below as a bare
      // `2 !== 1` with no hint that the wait had expired (#418).
      await awaitCondition(
        () => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
        { timeoutMs: 4_000, intervalMs: 25, label: 'both nodes saw a two-member cluster' },
      );
      expect(nodeA.cluster.upMembers().length).toBe(2);
      expect(nodeB.cluster.upMembers().length).toBe(2);
    } finally {
      await nodeA.shutdown();
      await nodeB.shutdown();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* autoDiscovery — env-driven seed-provider builder                            */
/* -------------------------------------------------------------------------- */

describe('autoDiscovery', () => {
  test('empty env produces an empty aggregate (single-node mode)', async () => {
    const autoDiscoveryOptions = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withEnv({});
    const provider = autoDiscovery(
      autoDiscoveryOptions,
    );
    const seeds = await provider.lookup();
    expect(seeds).toEqual([]);
  });

  test('CLUSTER_SEEDS produces a Config provider', async () => {
    const autoDiscoveryOptions = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withEnv({ CLUSTER_SEEDS: '10.0.0.1:2552,10.0.0.2:2552' });
    const provider = autoDiscovery(
      autoDiscoveryOptions,
    );
    const seeds = await provider.lookup();
    expect(seeds.map(s => s.toString()))
      .toEqual(['app@10.0.0.1:2552', 'app@10.0.0.2:2552']);
  });

  test('K8s + DNS chain order — K8s wins when both apply', async () => {
    const autoDiscoveryOptions = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withEnv({ KUBERNETES_SERVICE_HOST: '10.0.0.1', CLUSTER_SERVICE_NAME: 'definitely-not-a-real-host.invalid', });
    // K8s provider's default fetchEndpoints would touch the network; the
    // aggregate wraps each lookup() in try/catch and falls through.  So
    // K8s fails (no token in test env) and DNS picks up next.  We can
    // verify the aggregate is wired by checking that an unparsable DNS
    // host throws on lookup, proving DNS was reached.
    const provider = autoDiscovery(
      autoDiscoveryOptions,
    );
    // K8s throws (no ServiceAccount token) → DNS resolves an
    // invalid host → throws too → aggregate returns [].
    const seeds = await provider.lookup();
    expect(Array.isArray(seeds)).toBe(true);
  });

  test('CLUSTER_NAMESPACE defaults to "default"', () => {
    const autoDiscoveryOptions = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withEnv({ CLUSTER_SERVICE_NAME: 'my-svc', KUBERNETES_SERVICE_HOST: '10.0.0.1' });
    const provider = singleProviderDiscovery('kubernetes',
      autoDiscoveryOptions,
    );
    expect(provider).toBeDefined();
  });

  test('singleProviderDiscovery throws when DNS env vars missing', () => {
    expect(() => {
      const autoDiscoveryOptions = AutoDiscoveryOptions.create()
        .withSystemName('app')
        .withPort(2552)
        .withEnv({});
      return singleProviderDiscovery('dns',
      autoDiscoveryOptions,
    );
    }).toThrow(/CLUSTER_SERVICE_NAME/);
  });

  test('singleProviderDiscovery throws when K8s env vars missing', () => {
    expect(() => {
      const autoDiscoveryOptions = AutoDiscoveryOptions.create()
        .withSystemName('app')
        .withPort(2552)
        .withEnv({});
      return singleProviderDiscovery('kubernetes',
      autoDiscoveryOptions,
    );
    }).toThrow(/CLUSTER_SERVICE_NAME/);
  });
});

/* -------------------------------------------------------------------------- */
/* autoDiscovery — one rejected rung must not take the ladder down (#597)      */
/* -------------------------------------------------------------------------- */

/** The ladder `autoDiscovery` assembled, read back for a composition assertion. */
type AssembledLadder = { readonly providers: readonly SeedProvider[] };

function ladderOf(provider: AggregateSeedProvider): readonly SeedProvider[] {
  return (provider as unknown as AssembledLadder).providers;
}

describe('autoDiscovery — a rejected rung degrades that rung only (#597)', () => {
  // `CLUSTER_SERVICE_NAME` drives the DNS rung as well as the Kubernetes
  // one, and a DNS hostname is a strict superset of a DNS-1123 subdomain:
  // an SRV name, a root-anchored FQDN and uppercase are all legal there and
  // all rejected by the Kubernetes name-shape rule.
  const namesKubernetesRejects = [
    '_actor-ts._tcp.example.com',
    'actor-ts.default.svc.cluster.local.',
    'Actor-TS.example.com',
  ] as const;

  for (const serviceName of namesKubernetesRejects) {
    test(`CLUSTER_SEEDS still wins when CLUSTER_SERVICE_NAME is "${serviceName}"`, async () => {
      const rejections: unknown[] = [];
      const autoDiscoveryOptions = AutoDiscoveryOptions.create()
        .withSystemName('app')
        .withPort(2552)
        .withLog((_message, error) => rejections.push(error))
        .withEnv({
          KUBERNETES_SERVICE_HOST: '10.0.0.1',
          CLUSTER_SERVICE_NAME: serviceName,
          CLUSTER_SEEDS: '10.0.0.1:2552,10.0.0.2:2552',
        });
      const provider = autoDiscovery(autoDiscoveryOptions);
      // The strongest signal is an explicit seed list that does not read
      // CLUSTER_SERVICE_NAME at all — it must survive the K8s rejection.
      const seeds = await provider.lookup();
      expect(seeds.map(s => s.toString())).toEqual(['app@10.0.0.1:2552', 'app@10.0.0.2:2552']);
      // Skipping a rung is reported, not silent.
      expect(rejections.length).toBe(1);
      expect(rejections[0]).toBeInstanceOf(OptionsError);
    });
  }

  test('the DNS rung outlives the Kubernetes rung it shares a name with', () => {
    const autoDiscoveryOptions = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withEnv({
        KUBERNETES_SERVICE_HOST: '10.0.0.1',
        CLUSTER_SERVICE_NAME: '_actor-ts._tcp.example.com',
      });
    const provider = autoDiscovery(autoDiscoveryOptions);
    // Composition only — resolving this name would touch the network.
    const ladder = ladderOf(provider);
    expect(ladder.length).toBe(1);
    expect(ladder[0]).toBeInstanceOf(DnsSeedProvider);
  });

  test('a CLUSTER_SEEDS list that parses to nothing drops only its own rung', async () => {
    const autoDiscoveryOptions = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withEnv({ CLUSTER_SEEDS: ' , , ' });
    const provider = autoDiscovery(autoDiscoveryOptions);
    expect(ladderOf(provider).length).toBe(0);
    expect(await provider.lookup()).toEqual([]);
  });

  test('a well-formed env still assembles all three rungs in order', () => {
    const autoDiscoveryOptions = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withEnv({
        KUBERNETES_SERVICE_HOST: '10.0.0.1',
        CLUSTER_SERVICE_NAME: 'actor-ts',
        CLUSTER_SEEDS: '10.0.0.1:2552',
      });
    const ladder = ladderOf(autoDiscovery(autoDiscoveryOptions));
    expect(ladder.map(rung => rung.constructor.name))
      .toEqual(['ConfigSeedProvider', 'KubernetesApiSeedProvider', 'DnsSeedProvider']);
  });

  test('a traversal CLUSTER_SERVICE_NAME never becomes a Kubernetes rung (#597)', () => {
    // The payload #597 is about, arriving the way #597 says it arrives:
    // straight out of the pod's environment.  Degrading the rung must not
    // turn into building it — no rung, no request, no API path.
    const autoDiscoveryOptions = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withEnv({
        KUBERNETES_SERVICE_HOST: '10.0.0.1',
        CLUSTER_SERVICE_NAME: 'app/../../../namespaces/attacker-ns/endpoints/decoy',
      });
    const ladder = ladderOf(autoDiscovery(autoDiscoveryOptions));
    expect(ladder.some(rung => rung instanceof KubernetesApiSeedProvider)).toBe(false);
  });

  // The ladder's tolerance must not reach the pinned single-provider form,
  // whose documented job is to fail loudly, nor the shape rule itself.
  test("singleProviderDiscovery('kubernetes') still rejects the same name", () => {
    const autoDiscoveryOptions = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withEnv({ CLUSTER_SERVICE_NAME: 'app/../../../namespaces/attacker-ns/endpoints/decoy' });
    expect(() => singleProviderDiscovery('kubernetes', autoDiscoveryOptions))
      .toThrow(OptionsError);
  });

  test('the provider constructor still rejects a traversal service name', () => {
    const kubernetesOptions = KubernetesApiSeedProviderOptions.create()
      .withSystemName('app')
      .withNamespace('default')
      .withServiceName('app/../../../namespaces/attacker-ns/endpoints/decoy')
      .withPort(2552);
    expect(() => new KubernetesApiSeedProvider(kubernetesOptions)).toThrow(OptionsError);
  });
});

/* -------------------------------------------------------------------------- */
/* bootstrapCluster — free-function form (same code path as Cluster.bootstrap) */
/* -------------------------------------------------------------------------- */

describe('bootstrapCluster (free function)', () => {
  test('reachable as a top-level export', async () => {
    const transport = new InMemoryTransport(new NodeAddress('bootstrap-fn', '127.0.0.1', 50110));
    const clusterBootstrapOptions = ClusterBootstrapOptions.create('bootstrap-fn')
      .withHost('127.0.0.1')
      .withPort(50110)
      .withTransport(transport)
      .withReceptionist(false)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withShutdownOnSignals(false);
    const { shutdown, cluster } = await bootstrapCluster(
      clusterBootstrapOptions,
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
