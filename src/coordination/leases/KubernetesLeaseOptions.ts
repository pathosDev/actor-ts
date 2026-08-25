import { LeaseOptionsBuilder, LeaseOptionsValidator } from '../LeaseOptions.js';
import type { LeaseOptionsType } from '../LeaseOptions.js';
import type { K8sFetchClient, MountedCredentialLoader } from './K8sApi.js';

/**
 * How long a credential read from the Pod's ServiceAccount mount may be
 * reused before the token file is checked again (#760).
 *
 * A minute bounds how long a credential that has quietly gone stale can go
 * on being replayed, while staying long enough that a renewal loop ticking
 * every few seconds does not turn every tick into a file read.  It is a
 * floor on freshness rather than the mechanism: an actual 401/403
 * invalidates the cache immediately, whatever this is set to.
 *
 * Deliberately not derived from `ttlMs`.  The two measure unrelated things,
 * and tying them would make a lease with a generous TTL hold a bounded
 * credential for longer than the credential is valid.
 */
export const DEFAULT_TOKEN_RELOAD_INTERVAL_MS = 60_000;

/**
 * K8s-specific additions to the common lease options.  `apiServerUrl`,
 * `authToken` and `caCert` form **one credential**: supply all three, or
 * none of them and let the adapter read the Pod's ServiceAccount mount
 * (`/var/run/secrets/kubernetes.io/...`) whole.  A partial set is
 * rejected by `KubernetesLeaseOptionsValidator` — see there for why.
 *
 * `client` and `credentialLoader` are test seams — pass a fake
 * `K8sFetchClient` to drive the lease without a real API server, and a fake
 * `MountedCredentialLoader` to drive the in-cluster credential path without
 * a Pod.
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
  /**
   * How long a credential read from the ServiceAccount mount may be reused
   * before the token file is checked again, in ms.  Has no effect on an
   * explicitly supplied `authToken`, which is static by construction —
   * there is nowhere to re-read it from.  Defaults to
   * {@link DEFAULT_TOKEN_RELOAD_INTERVAL_MS}.
   */
  readonly tokenReloadIntervalMs?: number;
  /** Test seam — inject a fake fetch client. */
  readonly client?: K8sFetchClient;
  /** Test seam — inject a fake ServiceAccount-mount reader. */
  readonly credentialLoader?: MountedCredentialLoader;
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

  /** How long a mounted-ServiceAccount credential may be reused before the token file is checked again, in ms. */
  withTokenReloadIntervalMs(tokenReloadIntervalMs: number): this {
    return this.set('tokenReloadIntervalMs', tokenReloadIntervalMs);
  }

  /** Test seam — inject a fake fetch client. */
  withClient(client: K8sFetchClient): this {
    return this.set('client', client);
  }

  /** Test seam — inject a fake ServiceAccount-mount reader. */
  withCredentialLoader(credentialLoader: MountedCredentialLoader): this {
    return this.set('credentialLoader', credentialLoader);
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
    this.positiveNumber('tokenReloadIntervalMs');
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
