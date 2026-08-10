import { addressPinRejection, isCidrEntry } from '../util/CidrMatch.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Plain options-object shape accepted by a {@link KubernetesApiSeedProvider}. */
export type KubernetesApiSeedProviderOptionsType = {
  /** Target namespace to look up endpoints in. */
  readonly namespace: string;
  /** Service or Endpoints name whose backing pods provide the cluster. */
  readonly serviceName: string;
  /** System name stamped on the discovered NodeAddresses. */
  readonly systemName: string;
  /** Port for the cluster remoting endpoint on each pod. */
  readonly port: number;
  /** Override the Endpoints-fetch function — defaults to the in-cluster API. */
  readonly fetchEndpoints?: () => Promise<string[]>;
  /**
   * CIDRs the pod IPs must fall inside.  Endpoints are IPs, so entries
   * are CIDRs only — a host suffix could never match and is rejected.
   * Unset means no pinning.
   *
   * The K8s path is already the better-defended one: the default fetcher
   * pins TLS to the ServiceAccount CA, so it does not inherit DNS's
   * trust problem the way {@link DnsSeedProviderOptionsType} does.  What
   * this guards is the layer above — an `Endpoints` object may name
   * *any* IP, including one outside the cluster, and RBAC that can write
   * Endpoints is a much cheaper find than a CA key.
   */
  readonly pinnedAddresses?: readonly string[];
  /**
   * Reports addresses dropped by {@link pinnedAddresses}.  Default:
   * no-op.
   */
  readonly log?: (message: string, error?: unknown) => void;
};

/**
 * Fluent builder for {@link KubernetesApiSeedProviderOptionsType}.
 *
 *     new KubernetesApiSeedProvider(
 *       KubernetesApiSeedProviderOptions.create()
 *         .withNamespace('actors').withServiceName('my-svc')
 *         .withSystemName('my-system').withPort(2552),
 *     );
 */
export class KubernetesApiSeedProviderOptionsBuilder extends OptionsBuilder<KubernetesApiSeedProviderOptionsType> {
  /** Start a fresh builder.  Equivalent to `new KubernetesApiSeedProviderOptionsBuilder()`. */
  static create(): KubernetesApiSeedProviderOptionsBuilder {
    return new KubernetesApiSeedProviderOptionsBuilder();
  }

  /** Target namespace to look up endpoints in. */
  withNamespace(namespace: string): this {
    return this.set('namespace', namespace);
  }

  /** Service or Endpoints name whose backing pods provide the cluster. */
  withServiceName(serviceName: string): this {
    return this.set('serviceName', serviceName);
  }

  /** System name stamped on the discovered NodeAddresses. */
  withSystemName(systemName: string): this {
    return this.set('systemName', systemName);
  }

  /** Port for the cluster remoting endpoint on each pod. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** Override the Endpoints-fetch function — defaults to the in-cluster API. */
  withFetchEndpoints(fetchEndpoints: () => Promise<string[]>): this {
    return this.set('fetchEndpoints', fetchEndpoints);
  }

  /** Restrict discovered pod IPs to these CIDRs.  Unset means no pinning. */
  withPinnedAddresses(pinnedAddresses: readonly string[]): this {
    return this.set('pinnedAddresses', pinnedAddresses);
  }

  /** Reports addresses dropped by `pinnedAddresses`.  Default: no-op. */
  withLog(log: (message: string, error?: unknown) => void): this {
    return this.set('log', log);
  }
}

/** Validates resolved {@link KubernetesApiSeedProviderOptionsType} settings. */
export class KubernetesApiSeedProviderOptionsValidator extends OptionsValidator<KubernetesApiSeedProviderOptionsType> {
  constructor() {
    super('KubernetesApiSeedProviderOptions');
  }
  protected rules(s: Partial<KubernetesApiSeedProviderOptionsType>): void {
    this.nonEmptyString('namespace');
    this.nonEmptyString('serviceName');
    this.nonEmptyString('systemName');
    this.positiveInt('port'); // node-address port (transport-agnostic — see ClusterOptions.port)

    if (s.pinnedAddresses === undefined) return;
    this.nonEmptyArray('pinnedAddresses');
    for (const entry of s.pinnedAddresses) {
      if (!isCidrEntry(entry)) {
        this.fail(
          'pinnedAddresses',
          'accepts CIDRs only — Endpoints resolve to IPs, so a host suffix can never match',
          entry,
        );
      }
      const rejection = addressPinRejection(entry);
      if (rejection !== null) this.fail('pinnedAddresses', rejection, entry);
    }
  }
}

/**
 * Accepted input for the {@link KubernetesApiSeedProvider} constructor: the
 * fluent {@link KubernetesApiSeedProviderOptionsBuilder} OR a plain
 * {@link KubernetesApiSeedProviderOptionsType} object.
 */
export type KubernetesApiSeedProviderOptions =
  | KubernetesApiSeedProviderOptionsBuilder
  | Partial<KubernetesApiSeedProviderOptionsType>;
/** Value alias so `KubernetesApiSeedProviderOptions.create()` / `new KubernetesApiSeedProviderOptions()` resolve to the builder. */
export const KubernetesApiSeedProviderOptions = KubernetesApiSeedProviderOptionsBuilder;
