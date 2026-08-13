import { LeaseOptionsBuilder, LeaseOptionsValidator } from '../LeaseOptions.js';
import type { LeaseOptionsType } from '../LeaseOptions.js';
import type { K8sFetchClient } from './k8sApi.js';

/**
 * K8s-specific additions to the common lease options.  `apiServerUrl`,
 * `authToken` and `caCert` form **one credential**: supply all three, or
 * none of them and let the adapter read the Pod's ServiceAccount mount
 * (`/var/run/secrets/kubernetes.io/...`) whole.  A partial set is
 * rejected by `KubernetesLeaseOptionsValidator` — see there for why.
 *
 * `client` is a test seam — pass a fake `K8sFetchClient` to drive the
 * lease without a real API server.
 */
export interface KubernetesLeaseOptionsType extends LeaseOptionsType {
  /** Kubernetes namespace that owns the `coordination.k8s.io/v1/Lease` object. */
  readonly namespace: string;
  /** API-server URL.  Requires `authToken` + `caCert`; omit all three to use the in-cluster ServiceAccount. */
  readonly apiServerUrl?: string;
  /** Bearer token for the API server.  Requires `apiServerUrl` + `caCert`; omit all three for the in-cluster ServiceAccount. */
  readonly authToken?: string;
  /** PEM-encoded CA cert for the API server.  Requires `apiServerUrl` + `authToken`; omit all three for the in-cluster ServiceAccount. */
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

  /** API-server URL.  Requires `withAuthToken` + `withCaCert`; omit all three to use the in-cluster ServiceAccount. */
  withApiServerUrl(apiServerUrl: string): this {
    return this.set('apiServerUrl', apiServerUrl);
  }

  /** Bearer token for the API server.  Requires `withApiServerUrl` + `withCaCert`; omit all three for the in-cluster ServiceAccount. */
  withAuthToken(authToken: string): this {
    return this.set('authToken', authToken);
  }

  /** PEM-encoded CA cert for the API server.  Requires `withApiServerUrl` + `withAuthToken`; omit all three for the in-cluster ServiceAccount. */
  withCaCert(caCert: string): this {
    return this.set('caCert', caCert);
  }

  /** Test seam — inject a fake fetch client. */
  withClient(client: K8sFetchClient): this {
    return this.set('client', client);
  }
}

/** Validates resolved {@link KubernetesLeaseOptionsType} settings — common lease fields plus namespace / connection credentials. */
export class KubernetesLeaseOptionsValidator extends LeaseOptionsValidator<KubernetesLeaseOptionsType> {
  /** The three fields that together form one API-server credential. */
  private static readonly credentialFields = ['apiServerUrl', 'authToken', 'caCert'] as const;

  constructor() {
    super('KubernetesLeaseOptions');
  }
  protected override rules(s: Partial<KubernetesLeaseOptionsType>): void {
    this.commonRules(s);
    this.nonEmptyString('namespace');
    this.nonEmptyString('authToken');
    this.nonEmptyString('caCert');
    // `https` only: the client builds an `https.request` from the URL's
    // host and port and never reads its protocol, so an `http://` URL was
    // dialed over TLS anyway — a validator that accepted it only misled.
    this.url('apiServerUrl', ['https']);

    // Cross-field: half a credential is not a credential (#599).  Merging
    // the three fields individually meant a caller-supplied `apiServerUrl`
    // was paired with the Pod's mounted ServiceAccount token — the
    // cluster's own bearer credential sent to whatever host an operator
    // happened to name, over a connection still pinned to the cluster CA.
    // All three together, or none of them and the in-cluster mount is used
    // whole.
    const fields = KubernetesLeaseOptionsValidator.credentialFields;
    const supplied = fields.filter((field) => s[field] !== undefined);
    if (supplied.length > 0 && supplied.length < fields.length) {
      const missing = fields.filter((field) => s[field] === undefined);
      this.fail(
        missing.join(' + '),
        `must be supplied together with ${supplied.join(' + ')} — explicit API-server credentials are all-or-nothing`,
      );
    }
  }

  /** The K8s backend additionally cannot address a Lease object without a `namespace`. */
  protected override requiredFields(): readonly string[] {
    return [...super.requiredFields(), 'namespace'];
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
