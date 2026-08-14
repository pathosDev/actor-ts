import { AggregateSeedProvider } from './AggregateSeedProvider.js';
import { AutoDiscoveryOptionsValidator } from './AutoDiscoveryOptions.js';
import type { AutoDiscoveryOptions, AutoDiscoveryOptionsType } from './AutoDiscoveryOptions.js';
import { ConfigSeedProvider } from './ConfigSeedProvider.js';
import { ConfigSeedProviderOptions } from './ConfigSeedProviderOptions.js';
import { DnsSeedProvider } from './DnsSeedProvider.js';
import { DnsSeedProviderOptions } from './DnsSeedProviderOptions.js';
import { KubernetesApiSeedProvider } from './KubernetesApiSeedProvider.js';
import { KubernetesApiSeedProviderOptions } from './KubernetesApiSeedProviderOptions.js';
import type { SeedProvider } from './SeedProvider.js';

function parseSeedList(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean);
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
 * Build an {@link AggregateSeedProvider} from environment variables —
 * the default discovery wiring used by `Cluster.bootstrap()` when the
 * caller doesn't pass `seeds` or `discovery:` explicitly.
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
  const providers: SeedProvider[] = [];

  // 1. CLUSTER_SEEDS — explicit static list.
  const rawSeeds = (env.CLUSTER_SEEDS ?? '').trim();
  if (rawSeeds.length > 0) {
    addRung(providers, log, 'CLUSTER_SEEDS', () => new ConfigSeedProvider(
      ConfigSeedProviderOptions.create()
        .withSystemName(resolvedOptions.systemName)
        .withSeeds(parseSeedList(rawSeeds)),
    ));
  }

  // 2. Kubernetes API — only inside a pod with a matching service name.
  const serviceName = (env.CLUSTER_SERVICE_NAME ?? '').trim();
  if (env.KUBERNETES_SERVICE_HOST && serviceName.length > 0) {
    addRung(providers, log, 'Kubernetes API', () => new KubernetesApiSeedProvider(
      KubernetesApiSeedProviderOptions.create()
        .withSystemName(resolvedOptions.systemName)
        .withNamespace(env.CLUSTER_NAMESPACE ?? 'default')
        .withServiceName(serviceName)
        .withPort(resolvedOptions.port),
    ));
  }

  // 3. DNS — resolve the service hostname directly.
  if (serviceName.length > 0) {
    addRung(providers, log, 'DNS', () => new DnsSeedProvider(
      DnsSeedProviderOptions.create()
        .withSystemName(resolvedOptions.systemName)
        .withHostname(serviceName)
        .withPort(resolvedOptions.port),
    ));
  }

  return new AggregateSeedProvider(providers, log);
}

/**
 * Named-provider shorthand used by `Cluster.bootstrap({ discovery: '...' })`.
 * Pins the chain to a single provider type (configured from env vars)
 * instead of running the full fallback ladder.  Useful when you know
 * you're running on K8s and want the bootstrap to fail loudly if the
 * K8s API isn't reachable, instead of silently falling through to DNS.
 */
export function singleProviderDiscovery(
  kind: 'config' | 'dns' | 'kubernetes',
  options: AutoDiscoveryOptions,
): SeedProvider {
  const resolvedOptions = options as AutoDiscoveryOptionsType;
  new AutoDiscoveryOptionsValidator().validate(resolvedOptions);
  const env = resolvedOptions.env ?? process.env;
  switch (kind) {
    case 'config': {
      const rawSeeds = (env.CLUSTER_SEEDS ?? '').trim();
      return new ConfigSeedProvider(
        ConfigSeedProviderOptions.create()
          .withSystemName(resolvedOptions.systemName)
          .withSeeds(parseSeedList(rawSeeds)),
      );
    }
    case 'dns': {
      const hostname = (env.CLUSTER_SERVICE_NAME ?? '').trim();
      if (!hostname) {
        throw new Error(
          "Cluster.bootstrap({ discovery: 'dns' }): CLUSTER_SERVICE_NAME must be set",
        );
      }
      return new DnsSeedProvider(
        DnsSeedProviderOptions.create()
          .withSystemName(resolvedOptions.systemName)
          .withHostname(hostname)
          .withPort(resolvedOptions.port),
      );
    }
    case 'kubernetes': {
      const serviceName = (env.CLUSTER_SERVICE_NAME ?? '').trim();
      if (!serviceName) {
        throw new Error(
          "Cluster.bootstrap({ discovery: 'kubernetes' }): CLUSTER_SERVICE_NAME must be set",
        );
      }
      return new KubernetesApiSeedProvider(
        KubernetesApiSeedProviderOptions.create()
          .withSystemName(resolvedOptions.systemName)
          .withNamespace(env.CLUSTER_NAMESPACE ?? 'default')
          .withServiceName(serviceName)
          .withPort(resolvedOptions.port),
      );
    }
  }
}
