import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { KubernetesApiSeedProviderSettings } from './KubernetesApiSeedProvider.js';

/**
 * Fluent builder for {@link KubernetesApiSeedProviderSettings}.
 *
 *     new KubernetesApiSeedProvider(
 *       KubernetesApiSeedProviderOptions.create()
 *         .withNamespace('actors').withServiceName('my-svc')
 *         .withSystemName('my-system').withPort(2552),
 *     );
 */
export class KubernetesApiSeedProviderOptions extends OptionsBuilder<KubernetesApiSeedProviderSettings> {
  /** Start a fresh builder.  Equivalent to `new KubernetesApiSeedProviderOptions()`. */
  static create(): KubernetesApiSeedProviderOptions {
    return new KubernetesApiSeedProviderOptions();
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
