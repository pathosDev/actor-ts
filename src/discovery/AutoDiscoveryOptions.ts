import { OptionsBuilder } from '../util/OptionsBuilder.js';

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
export interface AutoDiscoveryOptionsType {
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
 * Fluent builder for {@link AutoDiscoveryOptionsType} — the input to
 * {@link autoDiscovery} and {@link singleProviderDiscovery}.
 *
 *     autoDiscovery(
 *       AutoDiscoveryOptions.create().withSystemName('my-system').withPort(2552),
 *     );
 */
export class AutoDiscoveryOptionsBuilder extends OptionsBuilder<AutoDiscoveryOptionsType> {
  /** Start a fresh builder.  Equivalent to `new AutoDiscoveryOptionsBuilder()`. */
  static create(): AutoDiscoveryOptionsBuilder {
    return new AutoDiscoveryOptionsBuilder();
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
 * Accepted input for {@link autoDiscovery} / {@link singleProviderDiscovery}:
 * the fluent {@link AutoDiscoveryOptionsBuilder} OR a plain
 * {@link AutoDiscoveryOptionsType} object.
 */
export type AutoDiscoveryOptions = AutoDiscoveryOptionsBuilder | Partial<AutoDiscoveryOptionsType>;
/** Value alias so `AutoDiscoveryOptions.create()` / `new AutoDiscoveryOptions()` resolve to the builder. */
export const AutoDiscoveryOptions = AutoDiscoveryOptionsBuilder;
