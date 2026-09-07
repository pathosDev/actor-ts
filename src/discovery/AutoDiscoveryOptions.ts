import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { Config } from '../config/Config.js';

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
 *
 * **Where the environment sits (#860).** Every field below that names one of
 * those variables layers *above* it: an explicit `serviceName` wins over
 * `CLUSTER_SERVICE_NAME`, and `actor-ts.discovery.*` reaches this type
 * through {@link readAutoDiscoveryOptionsFromConfig}, which
 * `bootstrapCluster` layers under the caller's options.  The resulting order
 * is the project's usual one with the environment appended at the bottom
 * rather than a fourth layer on top:
 *
 *   explicit options > `actor-ts.discovery.*` > `CLUSTER_*` > built-in default
 *
 * The variables kept the bottom slot deliberately, so an env-only deployment
 * behaves byte for byte as it did before this type grew a config path.  A
 * deployment that wants one of them at *config* precedence writes the
 * substitution itself — `namespace = ${?CLUSTER_NAMESPACE}` — which the HOCON
 * parser resolves while reading the file, so it stays three layers.
 */
export type AutoDiscoveryOptionsType = {
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
  readonly log?: (message: string, err?: unknown) => void;
  /**
   * The service whose members are this cluster's peers — the DNS name the
   * DNS rung resolves and the Kubernetes Service whose `Endpoints` the K8s
   * rung reads.  One field for both because one deployment names one
   * service, which is also why `CLUSTER_SERVICE_NAME` drives both today.
   *
   * Unset falls through to `CLUSTER_SERVICE_NAME`.
   */
  readonly serviceName?: string;
  /**
   * Static `[system@]host:port` seeds for the `ConfigSeedProvider` rung.
   * Unset falls through to the comma-separated `CLUSTER_SEEDS`.
   *
   * An **empty array is not the same as unset**: it is a deliberate "there
   * is no static list", and `ConfigSeedProvider` refuses it — so it drops
   * that rung rather than resurrecting the environment's.
   */
  readonly seeds?: readonly string[];
  /**
   * Namespace the Kubernetes rung reads `Endpoints` from.  Unset falls
   * through to `CLUSTER_NAMESPACE` and then to
   * {@link DEFAULT_KUBERNETES_NAMESPACE}.
   *
   * Which is why `actor-ts.discovery.kubernetes.namespace` ships comment-only:
   * a published leaf would fill this field on every node and the fallback
   * chain would end here.
   */
  readonly kubernetesNamespace?: string;
  /**
   * CIDRs the pod IPs the Kubernetes rung discovers must fall inside.  Unset
   * means no pinning.  See
   * {@link KubernetesApiSeedProviderOptionsType.pinnedAddresses} — the guard
   * is against an `Endpoints` object naming an address outside the cluster,
   * not against the transport, which the default fetcher already pins to the
   * ServiceAccount CA.
   */
  readonly kubernetesPinnedAddresses?: readonly string[];
  /**
   * How long the DNS rung reuses one resolved answer.  Unset takes
   * {@link DEFAULT_DNS_CACHE_TTL_MS}; `0` disables caching.
   */
  readonly dnsCacheTtlMs?: number;
  /**
   * Read SRV records instead of A records on the DNS rung.  Unset takes
   * {@link DEFAULT_DNS_USE_SRV}.
   */
  readonly dnsUseSrv?: boolean;
  /**
   * CIDRs (A-record mode) and/or host suffixes (SRV mode) the DNS rung's
   * answers must match.  Unset means no pinning.  This is the #145
   * DNS-hijack mitigation, and until #860 it was reachable only by building
   * a `DnsSeedProvider` by hand — every `discovery:` shorthand left it off
   * (#1107).
   */
  readonly dnsPinnedAddresses?: readonly string[];
};

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
  withLog(log: (message: string, err?: unknown) => void): this {
    return this.set('log', log);
  }

  /** The service whose members are this cluster's peers.  Unset = `CLUSTER_SERVICE_NAME`. */
  withServiceName(serviceName: string): this {
    return this.set('serviceName', serviceName);
  }

  /** Static seeds for the config rung.  Unset = `CLUSTER_SEEDS`. */
  withSeeds(seeds: readonly string[]): this {
    return this.set('seeds', seeds);
  }

  /** Namespace the Kubernetes rung reads Endpoints from.  Unset = `CLUSTER_NAMESPACE`. */
  withKubernetesNamespace(kubernetesNamespace: string): this {
    return this.set('kubernetesNamespace', kubernetesNamespace);
  }

  /** Restrict the Kubernetes rung's pod IPs to these CIDRs.  Unset means no pinning. */
  withKubernetesPinnedAddresses(kubernetesPinnedAddresses: readonly string[]): this {
    return this.set('kubernetesPinnedAddresses', kubernetesPinnedAddresses);
  }

  /** How long the DNS rung reuses one answer.  `0` disables caching. */
  withDnsCacheTtlMs(dnsCacheTtlMs: number): this {
    return this.set('dnsCacheTtlMs', dnsCacheTtlMs);
  }

  /** Read SRV records instead of A records on the DNS rung. */
  withDnsUseSrv(dnsUseSrv = true): this {
    return this.set('dnsUseSrv', dnsUseSrv);
  }

  /** Restrict the DNS rung's answers to these CIDRs / host suffixes.  Unset means no pinning. */
  withDnsPinnedAddresses(dnsPinnedAddresses: readonly string[]): this {
    return this.set('dnsPinnedAddresses', dnsPinnedAddresses);
  }
}

/**
 * Validates resolved {@link AutoDiscoveryOptionsType} settings.
 *
 * The per-provider fields are checked only for the shapes this type owns —
 * a non-negative cache TTL, a non-empty service name if one was named.  The
 * pin lists are deliberately *not* re-validated here: their rules depend on
 * the mode the rung ends up in (`DnsSeedProviderOptionsValidator` refuses a
 * CIDR-only list in SRV mode and a suffix-only list in A-record mode), and
 * duplicating that judgement would put two verdicts on one value.  Each
 * provider's own validator runs when its rung is built, inside `addRung`, so
 * a rejected pin list costs exactly that rung (#597).
 */
export class AutoDiscoveryOptionsValidator extends OptionsValidator<AutoDiscoveryOptionsType> {
  constructor() {
    super('AutoDiscoveryOptions');
  }
  protected rules(_s: Partial<AutoDiscoveryOptionsType>): void {
    this.nonEmptyString('systemName');
    this.positiveInt('port'); // node-address port (transport-agnostic — see ClusterOptions.port)
    this.nonEmptyString('serviceName');
    this.nonEmptyString('kubernetesNamespace');
    this.nonNegativeNumber('dnsCacheTtlMs');
  }
}

/**
 * Read `actor-ts.discovery.*` into the shape {@link bootstrapCluster} layers
 * under the caller's {@link AutoDiscoveryOptions}.  Only keys actually
 * present are returned, so an absent one falls through to the environment and
 * then to the built-in default instead of landing as an explicit `undefined`
 * — the rule `mergeOptions` encodes, and the reason
 * `readStableObservationOptionsFromConfig` is written the same way.
 *
 * `systemName`, `port`, `env` and `log` have no leaf here on purpose: the
 * first two are the join's own identity (they come from
 * `actor-ts.remote.tcp.*` by way of the bootstrap), and the last two are
 * objects HOCON cannot express.
 *
 * The four comment-only keys — both `pinned-addresses` lists, `config.seeds`
 * and `kubernetes.namespace` — are read exactly like the published ones.  They
 * ship without a value because "unset" has to stay expressible, not because
 * they are unread.
 *
 * For the first three that is expressiveness: no pinning is the default and an
 * always-present empty list could not say so, and a seed list written once is
 * correct on no node.  For `namespace` it is **precedence**, and the reason
 * this reader is not the place to fix it.  Every field here is decided by
 * `hasPath`, so a published leaf is indistinguishable from a configured one —
 * the first cut of this block shipped `namespace = "default"` and therefore
 * returned a namespace on every node, which put a value nobody wrote into the
 * layer above `CLUSTER_NAMESPACE` and made the variable unreachable on the
 * `Cluster.bootstrap` path.
 *
 * The alternative was for this reader to drop `"default"` the way
 * `readClusterBootstrapDiscoveryFromConfig` drops the empty `service-name`.
 * It was rejected: `""` is not a service anyone runs, so dropping it discards
 * nothing, while `"default"` **is** a namespace someone may mean — a
 * deployment that writes it to override an inherited `CLUSTER_NAMESPACE`
 * would have been silently overruled by the environment it was overriding.
 * Not publishing the leaf keeps "unset" and "set to default" distinguishable,
 * which is the same trade `remote.tcp.advertised-host` makes.
 */
export function readAutoDiscoveryOptionsFromConfig(config: Config): Partial<AutoDiscoveryOptionsType> {
  const keys = ConfigKeys.discovery;
  const out: {
    -readonly [K in keyof AutoDiscoveryOptionsType]?: AutoDiscoveryOptionsType[K]
  } = {};
  if (config.hasPath(keys.dns.cacheTtl)) out.dnsCacheTtlMs = config.getDuration(keys.dns.cacheTtl);
  if (config.hasPath(keys.dns.useSrv)) out.dnsUseSrv = config.getBoolean(keys.dns.useSrv);
  if (config.hasPath(keys.dns.dnsPinnedAddresses)) {
    out.dnsPinnedAddresses = config.getStringList(keys.dns.dnsPinnedAddresses);
  }
  if (config.hasPath(keys.kubernetes.namespace)) {
    out.kubernetesNamespace = config.getString(keys.kubernetes.namespace);
  }
  if (config.hasPath(keys.kubernetes.kubernetesPinnedAddresses)) {
    out.kubernetesPinnedAddresses = config.getStringList(keys.kubernetes.kubernetesPinnedAddresses);
  }
  if (config.hasPath(keys.config.seeds)) out.seeds = config.getStringList(keys.config.seeds);
  return out;
}

/**
 * Accepted input for {@link autoDiscovery} / {@link singleProviderDiscovery}:
 * the fluent {@link AutoDiscoveryOptionsBuilder} OR a plain
 * {@link AutoDiscoveryOptionsType} object.
 */
export type AutoDiscoveryOptions = AutoDiscoveryOptionsBuilder | Partial<AutoDiscoveryOptionsType>;
/** Value alias so `AutoDiscoveryOptions.create()` / `new AutoDiscoveryOptions()` resolve to the builder. */
export const AutoDiscoveryOptions = AutoDiscoveryOptionsBuilder;
