import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { AggregateSeedProvider } from './AggregateSeedProvider.js';
import { ConfigSeedProvider, ConfigSeedProviderOptions } from './ConfigSeedProvider.js';
import { DnsSeedProvider, DnsSeedProviderOptions } from './DnsSeedProvider.js';
import { KubernetesApiSeedProvider, KubernetesApiSeedProviderOptions } from './KubernetesApiSeedProvider.js';
import type { SeedProvider } from './SeedProvider.js';

function parseSeedList(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Env-driven defaults for the standard production deployment shapes.
 * Recognised environment variables (none required — every layer is
 * optional, the helper returns whatever providers the env supports):
 *
 *   - `CLUSTER_SEEDS`         — comma-separated `[system@]host:port` list.
 *                               Strongest signal; if present, the
 *                               `ConfigSeedProvider` is preferred over the
 *                               service-discovery layers.
 *   - `CLUSTER_SERVICE_NAME`  — name of the service whose members are
 *                               this cluster's peers.  Drives both the
 *                               `KubernetesApiSeedProvider` (when running
 *                               in-pod) and the `DnsSeedProvider`.
 *   - `CLUSTER_NAMESPACE`     — K8s namespace.  Default: `default`.
 *   - `KUBERNETES_SERVICE_HOST` — set automatically inside every K8s pod;
 *                                used as the detection signal for adding
 *                                the K8s-API provider to the chain.
 *
 * Chain order (first non-empty wins):
 *
 *   1. `CLUSTER_SEEDS` (ConfigSeedProvider)        — most explicit
 *   2. K8s API endpoints                            — service mesh
 *   3. DNS resolve of `CLUSTER_SERVICE_NAME`        — fallback
 *
 * If none of the env vars are set, the returned provider's `lookup()`
 * resolves to `[]` — the cluster boots as the first node in a
 * single-node topology, which is exactly what local dev wants.
 */
export interface AutoDiscoverySettings {
  /** ActorSystem name to stamp on discovered NodeAddresses. */
  readonly systemName: string;
  /** Cluster remoting port to pair each discovered IP with. */
  readonly port: number;
  /**
   * Optional pre-mapped env lookup — useful for tests that want to
   * exercise the provider chain without mutating `process.env`.
   * Defaults to `process.env` at call time.
   */
  readonly env?: Record<string, string | undefined>;
  /** Logger for individual provider failures.  Default: no-op. */
  readonly log?: (msg: string, err?: unknown) => void;
}

/**
 * Fluent builder for {@link AutoDiscoverySettings} — the input to
 * {@link autoDiscovery} and {@link singleProviderDiscovery}.
 *
 *     autoDiscovery(
 *       AutoDiscoveryOptions.create().withSystemName('my-system').withPort(2552),
 *     );
 */
export class AutoDiscoveryOptions extends OptionsBuilder<AutoDiscoverySettings> {
  /** Start a fresh builder.  Equivalent to `new AutoDiscoveryOptions()`. */
  static create(): AutoDiscoveryOptions {
    return new AutoDiscoveryOptions();
  }

  /** ActorSystem name to stamp on discovered NodeAddresses. */
  withSystemName(systemName: string): this {
    return this.set('systemName', systemName);
  }

  /** Cluster remoting port to pair each discovered IP with. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** Pre-mapped env lookup (defaults to `process.env` at call time). */
  withEnv(env: Record<string, string | undefined>): this {
    return this.set('env', env);
  }

  /** Logger for individual provider failures.  Default: no-op. */
  withLog(log: (msg: string, err?: unknown) => void): this {
    return this.set('log', log);
  }
}

/**
 * Build an {@link AggregateSeedProvider} from environment variables —
 * the default discovery wiring used by `Cluster.bootstrap()` when the
 * caller doesn't pass `seeds` or `discovery:` explicitly.
 *
 * Returns an aggregate even when the env is empty, so the call site
 * always has a `SeedProvider` to invoke — the resulting `lookup()`
 * just resolves to `[]` for single-node dev.
 */
export function autoDiscovery(options: AutoDiscoveryOptions): AggregateSeedProvider {
  const settings = options.build() as AutoDiscoverySettings;
  const env = settings.env ?? process.env;
  const log = settings.log ?? (() => {});
  const providers: SeedProvider[] = [];

  // 1. CLUSTER_SEEDS — explicit static list.
  const rawSeeds = (env.CLUSTER_SEEDS ?? '').trim();
  if (rawSeeds.length > 0) {
    providers.push(new ConfigSeedProvider(
      ConfigSeedProviderOptions.create()
        .withSystemName(settings.systemName)
        .withSeeds(parseSeedList(rawSeeds)),
    ));
  }

  // 2. Kubernetes API — only inside a pod with a matching service name.
  const serviceName = (env.CLUSTER_SERVICE_NAME ?? '').trim();
  if (env.KUBERNETES_SERVICE_HOST && serviceName.length > 0) {
    providers.push(new KubernetesApiSeedProvider(
      KubernetesApiSeedProviderOptions.create()
        .withSystemName(settings.systemName)
        .withNamespace(env.CLUSTER_NAMESPACE ?? 'default')
        .withServiceName(serviceName)
        .withPort(settings.port),
    ));
  }

  // 3. DNS — resolve the service hostname directly.
  if (serviceName.length > 0) {
    providers.push(new DnsSeedProvider(
      DnsSeedProviderOptions.create()
        .withSystemName(settings.systemName)
        .withHostname(serviceName)
        .withPort(settings.port),
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
  const settings = options.build() as AutoDiscoverySettings;
  const env = settings.env ?? process.env;
  switch (kind) {
    case 'config': {
      const rawSeeds = (env.CLUSTER_SEEDS ?? '').trim();
      return new ConfigSeedProvider(
        ConfigSeedProviderOptions.create()
          .withSystemName(settings.systemName)
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
          .withSystemName(settings.systemName)
          .withHostname(hostname)
          .withPort(settings.port),
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
          .withSystemName(settings.systemName)
          .withNamespace(env.CLUSTER_NAMESPACE ?? 'default')
          .withServiceName(serviceName)
          .withPort(settings.port),
      );
    }
  }
}
