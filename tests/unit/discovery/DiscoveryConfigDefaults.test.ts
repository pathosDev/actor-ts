import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import {
  AutoDiscoveryOptions,
  DnsSeedProvider,
  KubernetesApiSeedProvider,
  readAutoDiscoveryOptionsFromConfig,
  singleProviderDiscovery,
} from '../../../src/discovery/index.js';
import type { AutoDiscoveryOptionsType } from '../../../src/discovery/index.js';
import {
  DEFAULT_DISCOVERY_METHOD,
  readClusterBootstrapDiscoveryFromConfig,
} from '../../../src/cluster/ClusterBootstrapOptions.js';
import { mergeOptions } from '../../../src/util/OptionsMerge.js';
import { Cluster, InMemoryTransport, NodeAddress } from '../../../src/cluster/index.js';
import { LogLevel, NoopLogger } from '../../../src/index.js';
import { ClusterBootstrapOptions } from '../../../src/cluster/ClusterBootstrapOptions.js';

/**
 * `actor-ts.discovery.*` and `actor-ts.cluster.bootstrap.discovery.*` — the
 * config path #860 gave seed discovery, which until then could be steered by
 * code and by environment variables and by nothing else.
 *
 * Written with `Config.parseString`, never `Config.fromObject({'a.b.c': …})`:
 * the latter keeps the dotted string as one literal top-level key, so
 * `hasPath('actor-ts.discovery.dns.cache-ttl')` would go on resolving the
 * *nested* `reference.conf` value and every assertion below would be about
 * the shipped default rather than about the test's own input.
 *
 * The provider-level assertions deliberately go through the validators rather
 * than through a live lookup.  A pin list that cannot match in the configured
 * mode is refused at construction, which makes "did the key reach the
 * provider" observable offline and without a DNS round trip — and it is the
 * question that matters, because until #860 no `discovery:` shorthand could
 * reach `pinnedAddresses` at all (#1107) while the docs presented it as the
 * DNS-hijack mitigation (#145).
 */

/** The layering `buildSeedProvider` performs, so the tests exercise the real order. */
function discoveryOptionsFrom(
  config: Config,
  explicit: Partial<AutoDiscoveryOptionsType> = {},
  env: Record<string, string | undefined> = {},
): AutoDiscoveryOptionsType {
  return mergeOptions<AutoDiscoveryOptionsType>({}, readAutoDiscoveryOptionsFromConfig(config), {
    systemName: 'app',
    port: 2552,
    env,
    ...explicit,
  });
}

describe('readAutoDiscoveryOptionsFromConfig', () => {
  test('reads every leaf of the discovery block, published and comment-only alike', () => {
    const config = Config.parseString(`
      actor-ts.discovery {
        dns {
          cache-ttl        = 15s
          use-srv          = true
          pinned-addresses = ["svc.cluster.local"]
        }
        kubernetes {
          request-timeout  = 3s
          namespace        = "actors"
          pinned-addresses = ["10.0.0.0/8"]
        }
        config {
          seeds = ["a@10.0.0.1:2552", "10.0.0.2:2552"]
        }
      }
    `);

    expect(readAutoDiscoveryOptionsFromConfig(config)).toEqual({
      dnsCacheTtlMs: 15_000,
      dnsUseSrv: true,
      dnsPinnedAddresses: ['svc.cluster.local'],
      kubernetesRequestTimeoutMs: 3_000,
      kubernetesNamespace: 'actors',
      kubernetesPinnedAddresses: ['10.0.0.0/8'],
      seeds: ['a@10.0.0.1:2552', '10.0.0.2:2552'],
    });
  });

  test('an unset key stays absent rather than landing as an explicit undefined', () => {
    // The property the whole block hangs on: `mergeOptions` treats `undefined`
    // on a higher layer as "not set", so a reader that punched holes would
    // shadow the CLUSTER_* layer underneath with a value nobody wrote — the
    // shape `resolveBindHost` still has on the bind address (see the remainder
    // note on #860).
    //
    // Asserted with `Object.keys`, NOT with `toEqual({})`: bun's `toEqual`
    // treats a present-but-undefined property as absent, so a reader that
    // assigned `undefined` for every missing key would pass a deep-equality
    // check while shadowing every layer beneath it.  Measured, not assumed —
    // the over-broad version was applied and this file stayed green until the
    // assertion was changed to this one.
    expect(Object.keys(readAutoDiscoveryOptionsFromConfig(Config.parseString('actor-ts.discovery {}'))))
      .toEqual([]);
    expect(
      Object.keys(readAutoDiscoveryOptionsFromConfig(Config.parseString('actor-ts.discovery.dns.use-srv = false'))),
    ).toEqual(['dnsUseSrv']);
  });

  test('the shipped reference values are what an unconfigured node reads', () => {
    // Not a restatement of DocumentedDefaults: that test asserts the published
    // literal equals the constant, this one asserts the reader addresses the
    // paths those literals live at.  A typo in one key path passes there and
    // fails here.
    const fromReference = readAutoDiscoveryOptionsFromConfig(Config.loadReference());
    expect(fromReference).toEqual({
      dnsCacheTtlMs: 60_000,
      dnsUseSrv: false,
      kubernetesRequestTimeoutMs: 10_000,
    });
    // The comment-only four must be absent, and `toEqual` alone cannot say so.
    expect(Object.keys(fromReference).sort()).toEqual(['dnsCacheTtlMs', 'dnsUseSrv', 'kubernetesRequestTimeoutMs']);
  });

  test('the shipped reference names no namespace, so CLUSTER_NAMESPACE stays reachable', () => {
    // The regression `5a72410c` shipped, stated at the reader: `namespace =
    // "default"` was published, so this returned a `kubernetesNamespace` on
    // every node and `bootstrapCluster` layered it above `CLUSTER_NAMESPACE`.
    // Asserted separately from the test above and with `Object.keys`, because
    // `toEqual` reads a present-but-undefined property as absent — the exact
    // hole the reader is written to avoid.
    expect(Object.keys(readAutoDiscoveryOptionsFromConfig(Config.loadReference())))
      .not.toContain('kubernetesNamespace');

    // And it is still a live key, not a deleted one: a node that names a
    // namespace is read as before.
    expect(readAutoDiscoveryOptionsFromConfig(
      Config.parseString('actor-ts.discovery.kubernetes.namespace = "actors"'),
    )).toEqual({ kubernetesNamespace: 'actors' });
  });
});

describe('readClusterBootstrapDiscoveryFromConfig', () => {
  test('reads the discovery sub-block, and only it', () => {
    const config = Config.parseString(`
      actor-ts.cluster.bootstrap {
        minimum-members = 3
        discovery {
          method       = "kubernetes"
          service-name = "my-svc"
        }
      }
    `);

    // `minimum-members` is the readiness reader's, and stays there: two
    // readers over one block because they have two consumers, which is the
    // arrangement `readStableObservationOptionsFromConfig` already makes.
    expect(readClusterBootstrapDiscoveryFromConfig(config)).toEqual({
      method: 'kubernetes',
      serviceName: 'my-svc',
    });
  });

  test('the published empty service-name is dropped, not passed on', () => {
    // "" is the shape of the key, not a service.  Passing it on would shadow
    // CLUSTER_SERVICE_NAME with a value nobody wrote, which is exactly the
    // defect the block was added to fix.
    const fromReference = readClusterBootstrapDiscoveryFromConfig(Config.loadReference());
    expect(fromReference).toEqual({ method: DEFAULT_DISCOVERY_METHOD });
    expect(Object.keys(fromReference)).toEqual(['method']);
  });

  test('a method outside the published enum is refused, not ignored', () => {
    // Silently falling back to the `auto` ladder would leave one node
    // discovering differently from its peers, which is the cold-start split
    // brain the bootstrap exists to close.
    const config = Config.parseString('actor-ts.cluster.bootstrap.discovery.method = "kubernetes-api"');
    expect(() => readClusterBootstrapDiscoveryFromConfig(config))
      .toThrow(ConfigError);
    expect(() => readClusterBootstrapDiscoveryFromConfig(config))
      .toThrow(/actor-ts\.cluster\.bootstrap\.discovery\.method/);
  });

  test('"auto" is expressible — the shipped default is nameable in config', () => {
    const config = Config.parseString('actor-ts.cluster.bootstrap.discovery.method = "auto"');
    expect(readClusterBootstrapDiscoveryFromConfig(config).method).toBe('auto');
  });
});

describe('the config block reaches the providers', () => {
  test('a DNS pin list from config is applied — and is refused when it cannot match the mode', () => {
    // Two keys proved by one construction: the CIDR-only list is legal in
    // A-record mode and illegal in SRV mode, so a provider that ignored either
    // `use-srv` or `pinned-addresses` would behave identically in both.
    const aRecordMode = Config.parseString(`
      actor-ts.discovery.dns {
        use-srv          = false
        pinned-addresses = ["10.0.0.0/8"]
      }
    `);
    const srvMode = Config.parseString(`
      actor-ts.discovery.dns {
        use-srv          = true
        pinned-addresses = ["10.0.0.0/8"]
      }
    `);

    const provider = singleProviderDiscovery('dns', discoveryOptionsFrom(aRecordMode, { serviceName: 'my-svc' }));
    expect(provider).toBeInstanceOf(DnsSeedProvider);

    expect(() => singleProviderDiscovery('dns', discoveryOptionsFrom(srvMode, { serviceName: 'my-svc' })))
      .toThrow(OptionsError);
    expect(() => singleProviderDiscovery('dns', discoveryOptionsFrom(srvMode, { serviceName: 'my-svc' })))
      .toThrow(/pinnedAddresses/);
  });

  test('a Kubernetes pin list from config is applied — suffixes are refused there', () => {
    // The K8s validator accepts CIDRs only, because Endpoints resolve to IPs.
    // A suffix reaching it therefore proves the key travelled; the CIDR case
    // below proves the rejection is about the entry and not about the list.
    const suffixPin = Config.parseString('actor-ts.discovery.kubernetes.pinned-addresses = ["svc.cluster.local"]');
    const cidrPin = Config.parseString('actor-ts.discovery.kubernetes.pinned-addresses = ["10.0.0.0/8"]');

    expect(() => singleProviderDiscovery('kubernetes', discoveryOptionsFrom(suffixPin, { serviceName: 'my-svc' })))
      .toThrow(/CIDRs only/);
    expect(singleProviderDiscovery('kubernetes', discoveryOptionsFrom(cidrPin, { serviceName: 'my-svc' })))
      .toBeInstanceOf(KubernetesApiSeedProvider);
  });

  test('a Kubernetes request timeout from config reaches the provider — a non-positive one is refused there', () => {
    // The provider's validator is the only offline observer of the field, and
    // it rejects a non-positive ceiling; a rejection from `0s` therefore proves
    // the key travelled from config to the provider (#1524).
    const zero = Config.parseString('actor-ts.discovery.kubernetes.request-timeout = 0s');
    const positive = Config.parseString('actor-ts.discovery.kubernetes.request-timeout = 3s');

    expect(() => singleProviderDiscovery('kubernetes', discoveryOptionsFrom(zero, { serviceName: 'my-svc' })))
      .toThrow(/requestTimeoutMs/);
    expect(singleProviderDiscovery('kubernetes', discoveryOptionsFrom(positive, { serviceName: 'my-svc' })))
      .toBeInstanceOf(KubernetesApiSeedProvider);
  });

  test('config.seeds feeds the config provider', async () => {
    const config = Config.parseString('actor-ts.discovery.config.seeds = ["10.0.0.1:2552"]');
    const provider = singleProviderDiscovery('config', discoveryOptionsFrom(config));

    expect((await provider.lookup()).map((address) => address.toString()))
      .toEqual(['app@10.0.0.1:2552']);
  });
});

describe('where the environment sits (#860)', () => {
  test('a config service name outranks CLUSTER_SERVICE_NAME', () => {
    // Observed through the DNS-1123 rule: a name Kubernetes would refuse is
    // rejected at construction, so whichever of the two won is named in the
    // failure — and the pair discriminates, since only one of them is bad.
    const options = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withServiceName('from-config')
      .withEnv({ CLUSTER_SERVICE_NAME: 'From_The_Environment' });

    expect(singleProviderDiscovery('kubernetes', options)).toBeInstanceOf(KubernetesApiSeedProvider);
  });

  test('CLUSTER_SERVICE_NAME still answers when nothing configured one', () => {
    const options = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withEnv({ CLUSTER_SERVICE_NAME: 'From_The_Environment' });

    expect(() => singleProviderDiscovery('kubernetes', options)).toThrow(/serviceName/);
  });

  test('a config namespace outranks CLUSTER_NAMESPACE, which outranks the built-in default', () => {
    const base = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withServiceName('my-svc');

    // Config wins: the bad environment value never reaches the validator.
    const configWins = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withServiceName('my-svc')
      .withKubernetesNamespace('actors')
      .withEnv({ CLUSTER_NAMESPACE: 'Not_A_Label' });
    expect(singleProviderDiscovery('kubernetes', configWins)).toBeInstanceOf(KubernetesApiSeedProvider);

    // Environment wins over the built-in default: the bad value now arrives.
    const environmentWins = AutoDiscoveryOptions.create()
      .withSystemName('app')
      .withPort(2552)
      .withServiceName('my-svc')
      .withEnv({ CLUSTER_NAMESPACE: 'Not_A_Label' });
    expect(() => singleProviderDiscovery('kubernetes', environmentWins)).toThrow(/namespace/);

    // Neither: the shipped default, which is a legal label.
    expect(singleProviderDiscovery('kubernetes', base)).toBeInstanceOf(KubernetesApiSeedProvider);
  });
});

/** A bootstrap that fails during seed resolution, so nothing binds a socket. */
function bootstrapOptions(port: number, configuration: string): ClusterBootstrapOptions {
  return ClusterBootstrapOptions.create(`discovery-config-${port}`)
    .withHost('127.0.0.1')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(`discovery-config-${port}`, '127.0.0.1', port)))
    .withConfig(Config.parseString(configuration))
    .withReceptionist(false)
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withShutdownOnSignals(false)
    .withAwaitReady(false);
}

describe('bootstrapCluster reads the block', () => {
  test('the configured method selects the provider — and the configured service name reaches it', async () => {
    // `method` bound: under the shipped `auto` this returns an empty aggregate
    // and the bootstrap succeeds, so a reader that ignored the key could not
    // produce this rejection at all.
    await expect(Cluster.bootstrap(bootstrapOptions(50871, `
      actor-ts.cluster.bootstrap.discovery.method = "kubernetes"
    `))).rejects.toThrow(/service name must be set/);

    // `service-name` bound: the same config plus a name gets past that refusal
    // and fails on the Kubernetes API instead, which is unreachable here.
    // Asserted on the caught error rather than through `.rejects.not.toThrow`,
    // which passes for a promise that never rejects at all.
    let caught: unknown;
    try {
      await Cluster.bootstrap(bootstrapOptions(50872, `
        actor-ts.cluster.bootstrap.discovery {
          method       = "kubernetes"
          service-name = "my-svc"
        }
      `));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toMatch(/service name must be set/);
  });
});

/**
 * The `actor-ts.discovery.*` → provider seam, exercised through the real
 * `Cluster.bootstrap` instead of through a re-implementation of the layering.
 *
 * The tests under "the config block reaches the providers" above assemble the
 * merged options themselves (`discoveryOptionsFrom`) and call
 * `singleProviderDiscovery` directly, so they prove the *providers* read their
 * options and say nothing about whether `buildSeedProvider` ever hands them the
 * block.  Measured: replacing `discoverySettings.fromConfig` with `{}` in
 * `ClusterBootstrap.buildSeedProvider` left the whole suite green.  Three of
 * the four below go red for it.
 *
 * The fourth is the one that cannot: it asserts that an *unset* key falls
 * through, which severing the seam produces by accident.  It covers the other
 * direction — a `reference.conf` leaf filling the field nobody configured — and
 * the two failures are only distinguishable by having both tests.
 *
 * Observed through the option validators for the reason the block above gives —
 * a value the rung would refuse names, in its own rejection, which layer won,
 * and each pair below is chosen so exactly one side of it is refusable.
 *
 * `CLUSTER_NAMESPACE` is set on `process.env` because that is the only place
 * this path can read it from: `env` is one of the four fields
 * `actor-ts.discovery.*` deliberately ships no leaf for, and `buildSeedProvider`
 * applies only `systemName`, `port` and `log` on top of the config block.  Saved
 * and restored per test so nothing this file sets leaks into another.
 */
describe('the discovery block reaches the providers through Cluster.bootstrap', () => {
  const DISCOVERY_VARIABLES = ['CLUSTER_NAMESPACE', 'CLUSTER_SERVICE_NAME', 'CLUSTER_SEEDS'] as const;
  const savedVariables = new Map<string, string | undefined>();

  /** How the Kubernetes rung refuses a namespace Kubernetes could not have created. */
  const NAMESPACE_REFUSAL = /namespace must be a DNS-1123 label/;

  beforeEach(() => {
    for (const name of DISCOVERY_VARIABLES) {
      savedVariables.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of savedVariables) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedVariables.clear();
  });

  /**
   * The error a bootstrap that cannot resolve seeds rejects with.  Caught
   * rather than asserted with `.rejects`, so the message can be matched twice —
   * once for the rule that refused it and once for the value it refused, which
   * is what makes the pairs below discriminate.
   */
  async function bootstrapFailure(port: number, configuration: string): Promise<Error> {
    let caught: unknown;
    try {
      await Cluster.bootstrap(bootstrapOptions(port, configuration));
    } catch (error) {
      caught = error;
    }
    expect(caught, 'the bootstrap was expected to fail during seed resolution').toBeInstanceOf(Error);
    return caught as Error;
  }

  test('an unconfigured namespace falls through to CLUSTER_NAMESPACE', async () => {
    // The regression `5a72410c` shipped: `reference.conf` published
    // `namespace = "default"`, so `readAutoDiscoveryOptionsFromConfig` returned
    // a namespace on every node and the variable underneath it was unreachable
    // on this path — a pod outside `default` read the wrong Endpoints object,
    // found no seeds and self-elected, which is the cold-start split brain the
    // bootstrap exists to close.
    //
    // The bad value is the environment's here and the config's in the next
    // test, so the refusal names which of the two arrived.
    process.env.CLUSTER_NAMESPACE = 'Not_A_Label';

    const error = await bootstrapFailure(50873, `
      actor-ts.cluster.bootstrap.discovery {
        method       = "kubernetes"
        service-name = "my-svc"
      }
    `);

    expect(error.message).toMatch(NAMESPACE_REFUSAL);
    expect(error.message).toMatch(/Not_A_Label/);
  });

  test('a configured namespace still outranks CLUSTER_NAMESPACE', async () => {
    // The other half of the same seam, and why the fix is a comment-only leaf
    // rather than the reader dropping `"default"`: a namespace someone actually
    // wrote has to keep winning, `"default"` included.
    process.env.CLUSTER_NAMESPACE = 'actors';

    const error = await bootstrapFailure(50874, `
      actor-ts.cluster.bootstrap.discovery {
        method       = "kubernetes"
        service-name = "my-svc"
      }
      actor-ts.discovery.kubernetes.namespace = "Not_A_Label"
    `);

    expect(error.message).toMatch(NAMESPACE_REFUSAL);
    expect(error.message).toMatch(/Not_A_Label/);
  });

  test('the Kubernetes pin list reaches the provider', async () => {
    // A host suffix is refused there because Endpoints resolve to IPs, so the
    // rejection is proof the list travelled rather than proof of its contents.
    const error = await bootstrapFailure(50875, `
      actor-ts.cluster.bootstrap.discovery {
        method       = "kubernetes"
        service-name = "my-svc"
      }
      actor-ts.discovery.kubernetes.pinned-addresses = ["svc.cluster.local"]
    `);

    expect(error.message).toMatch(/CIDRs only/);
  });

  test('the DNS rung reads use-srv and its pin list from the block', async () => {
    // Two keys proved by one construction, as above: a CIDR-only list is legal
    // in A-record mode and illegal in SRV mode, so a bootstrap that dropped
    // either key would build this provider without complaint.
    const error = await bootstrapFailure(50876, `
      actor-ts.cluster.bootstrap.discovery {
        method       = "dns"
        service-name = "my-svc"
      }
      actor-ts.discovery.dns {
        use-srv          = true
        pinned-addresses = ["10.0.0.0/8"]
      }
    `);

    expect(error.message).toMatch(/pinnedAddresses/);
    expect(error.message).toMatch(/SRV mode/);
  });
});
