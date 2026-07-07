import { OptionsBuilder } from '../util/OptionsBuilder.js';

/** Plain settings-object shape accepted by a {@link KubernetesApiSeedProvider}. */
export interface KubernetesApiSeedProviderOptionsType {
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
}

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
