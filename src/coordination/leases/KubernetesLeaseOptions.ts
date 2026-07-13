import { LeaseOptionsBuilder, LeaseOptionsValidator } from '../LeaseOptions.js';
import type { LeaseOptionsType } from '../LeaseOptions.js';
import type { K8sFetchClient } from './k8sApi.js';

/**
 * K8s-specific additions to the common lease options.  When `apiServerUrl`,
 * `authToken`, or `caCert` are omitted the adapter probes the standard
 * ServiceAccount mount points (`/var/run/secrets/kubernetes.io/...`).
 *
 * `client` is a test seam — pass a fake `K8sFetchClient` to drive the
 * lease without a real API server.
 */
export interface KubernetesLeaseOptionsType extends LeaseOptionsType {
  /** Kubernetes namespace that owns the `coordination.k8s.io/v1/Lease` object. */
  readonly namespace: string;
  /** API-server URL.  Defaults to the in-cluster service or `https://kubernetes.default.svc`. */
  readonly apiServerUrl?: string;
  /** Bearer token for the ServiceAccount.  Reads `/var/run/...` if omitted. */
  readonly authToken?: string;
  /** PEM-encoded CA cert for the API server.  Reads `/var/run/...` if omitted. */
  readonly caCert?: string;
  /** Test seam — inject a fake fetch client. */
  readonly client?: K8sFetchClient;
}

/**
 * Fluent builder for {@link KubernetesLeaseOptionsType}.  Extends
 * {@link LeaseOptionsBuilder} so the six common lease setters (`withName`,
 * `withOwner`, `withTtlMs`, …) are inherited; adds the K8s-specific
 * connection + credential setters on top.
 *
 *     new KubernetesLease(
 *       KubernetesLeaseOptions.create()
 *         .withName('singleton').withOwner(podName).withTtlMs(15_000)
 *         .withNamespace('actors'),
 *     );
 */
export class KubernetesLeaseOptionsBuilder extends LeaseOptionsBuilder<KubernetesLeaseOptionsType> {
  /** Start a fresh builder.  Equivalent to `new KubernetesLeaseOptionsBuilder()`. */
  static override create(): KubernetesLeaseOptionsBuilder {
    return new KubernetesLeaseOptionsBuilder();
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

/** Validates resolved {@link KubernetesLeaseOptionsType} settings — common lease fields plus namespace / apiServerUrl. */
export class KubernetesLeaseOptionsValidator extends LeaseOptionsValidator<KubernetesLeaseOptionsType> {
  constructor() {
    super('KubernetesLeaseOptions');
  }
  protected override rules(s: Partial<KubernetesLeaseOptionsType>): void {
    this.commonRules(s);
    this.nonEmptyString('namespace');
    this.url('apiServerUrl', ['http', 'https']);
  }
}

/**
 * Accepted input for the {@link KubernetesLease} constructor: the fluent
 * {@link KubernetesLeaseOptionsBuilder} OR a plain
 * {@link KubernetesLeaseOptionsType} object.
 */
export type KubernetesLeaseOptions = KubernetesLeaseOptionsBuilder | Partial<KubernetesLeaseOptionsType>;
/** Value alias so `KubernetesLeaseOptions.create()` / `new KubernetesLeaseOptions()` resolve to the builder. */
export const KubernetesLeaseOptions = KubernetesLeaseOptionsBuilder;
