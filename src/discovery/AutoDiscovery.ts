import { AggregateSeedProvider } from './AggregateSeedProvider.js';
import { AutoDiscoveryOptionsValidator } from './AutoDiscoveryOptions.js';
import type { AutoDiscoveryOptions, AutoDiscoveryOptionsType } from './AutoDiscoveryOptions.js';
import { ConfigSeedProvider } from './ConfigSeedProvider.js';
import { ConfigSeedProviderOptions } from './ConfigSeedProviderOptions.js';
import { DnsSeedProvider } from './DnsSeedProvider.js';
import { DnsSeedProviderOptions } from './DnsSeedProviderOptions.js';
import { KubernetesApiSeedProvider } from './KubernetesApiSeedProvider.js';
import { DEFAULT_KUBERNETES_NAMESPACE, KubernetesApiSeedProviderOptions } from './KubernetesApiSeedProviderOptions.js';
import type { SeedProvider } from './SeedProvider.js';

function parseSeedList(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * The three values both entry points resolve the same way, in the order
 * #860 fixed on: an explicit option (which is where `actor-ts.discovery.*`
 * and `actor-ts.cluster.bootstrap.discovery.service-name` arrive, layered in
 * by `bootstrapCluster`), then the `CLUSTER_*` variable, then the built-in
 * default.
 *
 * The environment kept the lower slot rather than the top one the variables
 * used to hold by default: it is the only arrangement under which an
 * env-only deployment behaves exactly as it did before this function
 * existed, and it is the project's documented precedence rather than an
 * exception to it.  A deployment that wants a variable to outrank its own
 * `application.conf` lifts it there with a `${?VAR}` substitution, which is
 * a read during parsing and not a fourth layer.
 *
 * "Env-only" is a claim about `reference.conf` as much as about this code,
 * and it is the half that broke: each `??` below is reached only while the
 * option to its left is unset, so a *published* leaf feeding one of these
 * three is a configured value on every node and the variable after it is
 * dead.  All three keys therefore keep "unset" reachable, in one of the two
 * shapes the project has for it — `discovery.kubernetes.namespace` and
 * `discovery.config.seeds` ship comment-only, and
 * `cluster.bootstrap.discovery.service-name` publishes `""` and is dropped by
 * its reader.  A key added here that shadows a `CLUSTER_*` variable needs one
 * of those two shapes.
 *
 * `seeds` distinguishes an explicit empty array from unset: `[]` is a
 * deliberate "there is no static list" and must not fall through to
 * `CLUSTER_SEEDS`, or a config file could never turn the variable off.
 */
function resolveDiscoveryInputs(
  resolvedOptions: AutoDiscoveryOptionsType,
  env: Record<string, string | undefined>,
): { serviceName: string; namespace: string; seeds: readonly string[] } {
  return {
    serviceName: (resolvedOptions.serviceName ?? env.CLUSTER_SERVICE_NAME ?? '').trim(),
    namespace: resolvedOptions.kubernetesNamespace ?? env.CLUSTER_NAMESPACE ?? DEFAULT_KUBERNETES_NAMESPACE,
    seeds: resolvedOptions.seeds ?? parseSeedList(env.CLUSTER_SEEDS ?? ''),
  };
}

/**
 * Build the DNS rung's options from the shared inputs.  Every optional field
 * is set only when it was named, so an unset one reaches
 * {@link DnsSeedProviderOptionsType}'s own default rather than a second copy
 * of it — the same "absent stays absent" rule the config readers follow.
 *
 * `log` is threaded down deliberately: without it a pin list that discards
 * every answer is indistinguishable from an empty DNS response, and the
 * `discovery:` shorthands were the one path on which pinning could not be
 * reached at all (#1107).
 */
function dnsOptionsFor(
  resolvedOptions: AutoDiscoveryOptionsType,
  hostname: string,
  log: (message: string, error?: unknown) => void,
): DnsSeedProviderOptions {
  const options = DnsSeedProviderOptions.create()
    .withSystemName(resolvedOptions.systemName)
    .withHostname(hostname)
    .withPort(resolvedOptions.port)
    .withLog(log);
  if (resolvedOptions.dnsCacheTtlMs !== undefined) options.withCacheTtlMs(resolvedOptions.dnsCacheTtlMs);
  if (resolvedOptions.dnsUseSrv !== undefined) options.withUseSrv(resolvedOptions.dnsUseSrv);
  if (resolvedOptions.dnsPinnedAddresses !== undefined) {
    options.withPinnedAddresses(resolvedOptions.dnsPinnedAddresses);
  }
  return options;
}

/** The Kubernetes rung's options — see {@link dnsOptionsFor} for the shape. */
function kubernetesOptionsFor(
  resolvedOptions: AutoDiscoveryOptionsType,
  namespace: string,
  serviceName: string,
  log: (message: string, error?: unknown) => void,
): KubernetesApiSeedProviderOptions {
  const options = KubernetesApiSeedProviderOptions.create()
    .withSystemName(resolvedOptions.systemName)
    .withNamespace(namespace)
    .withServiceName(serviceName)
    .withPort(resolvedOptions.port)
    .withLog(log);
  if (resolvedOptions.kubernetesPinnedAddresses !== undefined) {
    options.withPinnedAddresses(resolvedOptions.kubernetesPinnedAddresses);
  }
  if (resolvedOptions.kubernetesRequestTimeoutMs !== undefined) {
    options.withRequestTimeoutMs(resolvedOptions.kubernetesRequestTimeoutMs);
  }
  return options;
}

/**
 * Add one rung to the ladder — or drop just that rung.
 *
 * Each provider validates its options in its own constructor, and this
 * builder assembles the whole ladder up front, so a rejected rung throws
 * before `AggregateSeedProvider.lookup()` — whose contract is that an
 * individual provider failure falls through to the next — has run at all.
 * Without this guard one malformed environment variable took the *other*
 * rungs down with it (#597): a `CLUSTER_SERVICE_NAME` outside Kubernetes'
 * DNS-1123 shape also killed the `CLUSTER_SEEDS` rung, which never reads
 * that variable and is the strongest signal on the ladder.  That name is
 * not even necessarily wrong — the same variable drives the DNS rung,
 * where a hostname may legally be an SRV name, root-anchored with a
 * trailing dot, or uppercase.
 *
 * Building a rung is part of that rung, so a rejection is scoped to it and
 * reported through `log` rather than swallowed.  The pinned
 * {@link singleProviderDiscovery} form is deliberately not covered: failing
 * loudly on one named provider is exactly what it is for.
 */
function addRung(
  providers: SeedProvider[],
  log: (message: string, error?: unknown) => void,
  rungName: string,
  build: () => SeedProvider,
): void {
  try {
    providers.push(build());
  } catch (error) {
    log(`autoDiscovery: skipping the ${rungName} rung — its options were rejected`, error);
  }
}

/**
 * Build an {@link AggregateSeedProvider} from the options, the config block
 * behind them and the environment — the default discovery wiring used by
 * `Cluster.bootstrap()` when the caller doesn't pass `seeds` or `discovery:`
 * explicitly.
 *
 * The ladder's *shape* is still the environment's: which rungs exist depends
 * on what is answerable, and `KUBERNETES_SERVICE_HOST` remains the detection
 * signal for the K8s rung because it is set by the platform and means
 * something no config file can state — that this process is in a pod.  What
 * changed with #860 is where each rung's *settings* come from: the fields on
 * {@link AutoDiscoveryOptionsType}, which `actor-ts.discovery.*` reaches
 * through {@link readAutoDiscoveryOptionsFromConfig}, with the `CLUSTER_*`
 * variables as the layer below them.
 *
 * Returns an aggregate even when the env is empty, so the call site
 * always has a `SeedProvider` to invoke — the resulting `lookup()`
 * just resolves to `[]` for single-node dev.  A rung whose options the
 * environment cannot satisfy is dropped and reported rather than thrown
 * out of here, so one bad variable never costs the rungs that don't read
 * it — see {@link addRung}.
 */
export function autoDiscovery(options: AutoDiscoveryOptions): AggregateSeedProvider {
  const resolvedOptions = options as AutoDiscoveryOptionsType;
  new AutoDiscoveryOptionsValidator().validate(resolvedOptions);
  const env = resolvedOptions.env ?? process.env;
  const log = resolvedOptions.log ?? (() => {});
  const { serviceName, namespace, seeds } = resolveDiscoveryInputs(resolvedOptions, env);
  const providers: SeedProvider[] = [];

  // 1. A static seed list — `seeds` or CLUSTER_SEEDS.
  if (seeds.length > 0) {
    addRung(providers, log, 'static seed list', () => new ConfigSeedProvider(
      ConfigSeedProviderOptions.create()
        .withSystemName(resolvedOptions.systemName)
        .withSeeds([...seeds]),
    ));
  }

  // 2. Kubernetes API — only inside a pod with a matching service name.
  if (env.KUBERNETES_SERVICE_HOST && serviceName.length > 0) {
    addRung(providers, log, 'Kubernetes API', () => new KubernetesApiSeedProvider(
      kubernetesOptionsFor(resolvedOptions, namespace, serviceName, log),
    ));
  }

  // 3. DNS — resolve the service hostname directly.
  if (serviceName.length > 0) {
    addRung(providers, log, 'DNS', () => new DnsSeedProvider(
      dnsOptionsFor(resolvedOptions, serviceName, log),
    ));
  }

  return new AggregateSeedProvider(providers, log);
}

/**
 * Named-provider shorthand used by `Cluster.bootstrap({ discovery: '...' })`
 * and by `actor-ts.cluster.bootstrap.discovery.method`.  Pins the chain to a
 * single provider type instead of running the full fallback ladder.  Useful
 * when you know you're running on K8s and want the bootstrap to fail loudly
 * if the K8s API isn't reachable, instead of silently falling through to DNS.
 *
 * The provider's settings come from the same three layers `autoDiscovery`
 * uses — the options, `actor-ts.discovery.*` beneath them, the `CLUSTER_*`
 * variables beneath that.  Unlike the ladder, a rejection here is not
 * softened: a pinned provider whose options are refused throws, which is
 * exactly what pinning one is for (#597).
 */
export function singleProviderDiscovery(
  kind: 'config' | 'dns' | 'kubernetes',
  options: AutoDiscoveryOptions,
): SeedProvider {
  const resolvedOptions = options as AutoDiscoveryOptionsType;
  new AutoDiscoveryOptionsValidator().validate(resolvedOptions);
  const env = resolvedOptions.env ?? process.env;
  const log = resolvedOptions.log ?? (() => {});
  const { serviceName, namespace, seeds } = resolveDiscoveryInputs(resolvedOptions, env);
  switch (kind) {
    case 'config': {
      const configOptions = ConfigSeedProviderOptions.create()
        .withSystemName(resolvedOptions.systemName)
        .withSeeds([...seeds]);
      return new ConfigSeedProvider(configOptions);
    }
    case 'dns': {
      if (!serviceName) {
        throw new Error(
          "Cluster.bootstrap({ discovery: 'dns' }): a service name must be set — "
          + 'actor-ts.cluster.bootstrap.discovery.service-name or CLUSTER_SERVICE_NAME',
        );
      }
      const dnsOptions = dnsOptionsFor(resolvedOptions, serviceName, log);
      return new DnsSeedProvider(dnsOptions);
    }
    case 'kubernetes': {
      if (!serviceName) {
        throw new Error(
          "Cluster.bootstrap({ discovery: 'kubernetes' }): a service name must be set — "
          + 'actor-ts.cluster.bootstrap.discovery.service-name or CLUSTER_SERVICE_NAME',
        );
      }
      const kubernetesOptions = kubernetesOptionsFor(resolvedOptions, namespace, serviceName, log);
      return new KubernetesApiSeedProvider(kubernetesOptions);
    }
  }
}
