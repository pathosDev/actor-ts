import { LeaseOptions } from '../LeaseOptions.js';
import type { K8sFetchClient } from './k8sApi.js';
import type { KubernetesLeaseSettings } from './KubernetesLease.js';

/**
 * Fluent builder for {@link KubernetesLeaseSettings}.  Extends
 * {@link LeaseOptions} so the six common lease setters (`withName`,
 * `withOwner`, `withTtlMs`, …) are inherited; adds the K8s-specific
 * connection + credential setters on top.
 *
 *     new KubernetesLease(
 *       KubernetesLeaseOptions.create()
 *         .withName('singleton').withOwner(podName).withTtlMs(15_000)
 *         .withNamespace('actors'),
 *     );
 */
export class KubernetesLeaseOptions extends LeaseOptions<KubernetesLeaseSettings> {
  /** Start a fresh builder.  Equivalent to `new KubernetesLeaseOptions()`. */
  static override create(): KubernetesLeaseOptions {
    return new KubernetesLeaseOptions();
  }

  /** Kubernetes namespace that owns the `coordination.k8s.io/v1/Lease` object. */
  withNamespace(namespace: string): this {
    return this.set('namespace', namespace);
  }

  /** API-server URL.  Defaults to the in-cluster service or `https://kubernetes.default.svc`. */
  withApiServerUrl(apiServerUrl: string): this {
    return this.set('apiServerUrl', apiServerUrl);
  }

  /** Bearer token for the ServiceAccount.  Reads `/var/run/...` if omitted. */
  withAuthToken(authToken: string): this {
    return this.set('authToken', authToken);
  }

  /** PEM-encoded CA cert for the API server.  Reads `/var/run/...` if omitted. */
  withCaCert(caCert: string): this {
    return this.set('caCert', caCert);
  }

  /** Test seam — inject a fake fetch client. */
  withClient(client: K8sFetchClient): this {
    return this.set('client', client);
  }
}
