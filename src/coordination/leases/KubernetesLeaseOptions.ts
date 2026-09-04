import { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import { LeaseOptionsBuilder, LeaseOptionsValidator, readLeaseOptionsFromConfig } from '../LeaseOptions.js';
import type { LeaseConfigDefaults, LeaseOptionsType } from '../LeaseOptions.js';
import type { K8sFetchClient, MountedCredentialLoader } from './K8sApi.js';
import { MINIMUM_LEASE_NAME_MAX_LENGTH } from './LeaseName.js';

/** Where the kubelet projects a Pod's ServiceAccount credential by default. */
const SERVICE_ACCOUNT_DIRECTORY = '/var/run/secrets/kubernetes.io/serviceaccount';

/**
 * Default location of the Pod's namespace file.
 *
 * The three mount paths are settable (#859) because a projected volume does not
 * have to be mounted where the kubelet puts it by default, and because a
 * deployment that refreshes the token from a sidecar needs to say so. What they
 * are *not* is a way to pass a token: the values stay files, so a credential is
 * never written into a config file that gets committed, logged or dumped by
 * `actor-ts.devtools`' config panel.
 */
export const DEFAULT_SERVICE_ACCOUNT_NAMESPACE_PATH = `${SERVICE_ACCOUNT_DIRECTORY}/namespace`;
/** Default location of the Pod's bearer-token file — see {@link DEFAULT_SERVICE_ACCOUNT_NAMESPACE_PATH}. */
export const DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH = `${SERVICE_ACCOUNT_DIRECTORY}/token`;
/** Default location of the cluster CA cert the API server's TLS is pinned to. */
export const DEFAULT_SERVICE_ACCOUNT_CA_PATH = `${SERVICE_ACCOUNT_DIRECTORY}/ca.crt`;

/**
 * Ceiling on one API-server request, in ms.
 *
 * `KubernetesLease`'s in-flight guard reasons from this number: the default
 * renewal interval is `ttlMs / 3` — 5 s at the 15 s TTL the docs recommend —
 * so a request allowed 10 s may legitimately span two ticks, and the tick that
 * overlaps is dropped rather than queued (#761). Lowering it changes that
 * arithmetic as well as how long a stalled request is tolerated, which is why
 * it is one knob with a written-down default rather than a literal in
 * `K8sApi`.
 */
export const DEFAULT_K8S_OPERATION_TIMEOUT_MS = 10_000;

/**
 * Longest Lease object name sent unchanged; anything longer is truncated to a
 * stable head plus a hash (see `truncateLeaseName`).
 *
 * 253 is the DNS-1123 **subdomain** bound — the shape apimachinery validates a
 * `coordination.k8s.io/v1` Lease name against, and the one this repo already
 * models for Endpoints names in `KubernetesApiSeedProviderOptions`. It is not
 * the 63-character *label* bound: truncating there would rewrite names the API
 * server accepts unchanged.
 *
 * It doubles as the validator's ceiling, because a larger value could not be
 * enforced by anything — the server would reject the name this setting had just
 * waved through. The key exists to lower the bound, not to raise it.
 */
export const DEFAULT_LEASE_NAME_MAX_LENGTH = 253;

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
  /**
   * Kubernetes namespace that owns the `coordination.k8s.io/v1/Lease` object.
   *
   * Optional since #859: left unset, the namespace is the one read from
   * {@link namespacePath} in the Pod's own ServiceAccount mount, which is the
   * value a Pod is almost always after and which the adapter has been reading
   * (and then discarding) all along. It is only resolvable at the first API
   * call, so a lease with neither this nor a readable mount fails there rather
   * than in the constructor.
   */
  readonly namespace?: string;
  /**
   * File holding the Pod's namespace.  Part of the in-cluster credential
   * source, so it may not be redirected alongside an explicit
   * {@link apiServerUrl}.  Defaults to
   * {@link DEFAULT_SERVICE_ACCOUNT_NAMESPACE_PATH}.
   */
  readonly namespacePath?: string;
  /**
   * File holding the bearer token.  A **path**, never the token itself — the
   * value belongs in a mounted file, not in a config key.  Defaults to
   * {@link DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH}.
   */
  readonly tokenPath?: string;
  /** File holding the PEM CA cert the API server's TLS is pinned to.  Defaults to {@link DEFAULT_SERVICE_ACCOUNT_CA_PATH}. */
  readonly caPath?: string;
  /** Ceiling on one API-server request, in ms.  Defaults to {@link DEFAULT_K8S_OPERATION_TIMEOUT_MS}. */
  readonly operationTimeoutMs?: number;
  /**
   * Longest Lease object name sent unchanged; a longer {@link name} is
   * truncated deterministically.  Defaults to
   * {@link DEFAULT_LEASE_NAME_MAX_LENGTH}.
   */
  readonly leaseNameMaxLength?: number;
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

  /** Kubernetes namespace that owns the `coordination.k8s.io/v1/Lease` object.  Unset reads it from the ServiceAccount mount. */
  withNamespace(namespace: string): this {
    return this.set('namespace', namespace);
  }

  /** File holding the Pod's namespace — part of the in-cluster credential source. */
  withNamespacePath(namespacePath: string): this {
    return this.set('namespacePath', namespacePath);
  }

  /** File holding the bearer token.  A path, not the token. */
  withTokenPath(tokenPath: string): this {
    return this.set('tokenPath', tokenPath);
  }

  /** File holding the PEM CA cert the API server's TLS is pinned to. */
  withCaPath(caPath: string): this {
    return this.set('caPath', caPath);
  }

  /** Ceiling on one API-server request, in ms. */
  withOperationTimeoutMs(operationTimeoutMs: number): this {
    return this.set('operationTimeoutMs', operationTimeoutMs);
  }

  /** Longest Lease object name sent unchanged; a longer one is truncated deterministically. */
  withLeaseNameMaxLength(leaseNameMaxLength: number): this {
    return this.set('leaseNameMaxLength', leaseNameMaxLength);
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

  /**
   * The three mount paths, with the file each one defaults to.
   *
   * The cross-field rule below compares against these values rather than
   * merely asking whether a field is set, and it has to: `reference.conf`
   * *ships* all three, so after the config layer is merged in they are always
   * present and "supplied" could never mean "chosen". A path equal to its
   * default names the same in-cluster mount the adapter would have read anyway.
   */
  private static readonly defaultMountPaths = {
    namespacePath: DEFAULT_SERVICE_ACCOUNT_NAMESPACE_PATH,
    tokenPath: DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH,
    caPath: DEFAULT_SERVICE_ACCOUNT_CA_PATH,
  } as const;

  constructor() {
    super('KubernetesLeaseOptions');
  }
  protected override rules(s: Partial<KubernetesLeaseOptionsType>): void {
    this.commonRules(s);
    this.nonEmptyString('namespace');
    this.nonEmptyString('namespacePath');
    this.nonEmptyString('tokenPath');
    this.nonEmptyString('caPath');
    this.nonEmptyString('authToken');
    this.nonEmptyString('caCert');
    this.positiveNumber('tokenReloadIntervalMs');
    this.positiveNumber('operationTimeoutMs');
    // Integer first, then the window: an integer check alone would accept 4,
    // which no truncated name can fit inside, and a range check alone would
    // accept 63.5.  The upper bound is the API server's own, so a larger value
    // could only wave through a name the server then rejects.
    this.positiveInt('leaseNameMaxLength');
    this.numberInRange('leaseNameMaxLength', MINIMUM_LEASE_NAME_MAX_LENGTH, DEFAULT_LEASE_NAME_MAX_LENGTH);
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

    // Same invariant, one axis over (#859).  The mount paths describe the
    // IN-CLUSTER source; an explicit `apiServerUrl` says that source is not
    // being used at all.  Accepting both would let a later refactor reopen
    // #599 by a new route — read the token from a path an operator named,
    // send it to a host an operator named — and even without that it is a
    // configuration whose two halves contradict each other, which is worth an
    // error rather than a silently ignored half.
    if (s.apiServerUrl !== undefined) {
      const defaults = KubernetesLeaseOptionsValidator.defaultMountPaths;
      const redirected = (Object.keys(defaults) as (keyof typeof defaults)[])
        .filter((field) => s[field] !== undefined && s[field] !== defaults[field]);
      if (redirected.length > 0) {
        this.fail(
          redirected.join(' + '),
          'must not be redirected while apiServerUrl is supplied — the mount paths name the '
          + 'in-cluster credential, which an explicit apiServerUrl replaces whole',
        );
      }
    }
  }
}

/**
 * The slice of the K8s-specific settings HOCON can supply — the sub-block
 * `actor-ts.coordination.lease.kubernetes.*` (#859).
 *
 * `apiServerUrl`, `authToken` and `caCert` are deliberately absent and have no
 * keys at all. Two of them are a bearer token and a private trust anchor, and a
 * config file is the wrong place for either: `ACTOR_TS_CONFIG` and a dropped-in
 * `application.conf` both feed {@link Config.load}, the merged config is
 * readable from the DevTools config panel, and a token in a file that gets
 * committed is the failure this issue exists to prevent. The path keys are the
 * supported way to move that half of the configuration out of code —
 * indirection to a file, never the secret itself. `client` and
 * `credentialLoader` are absent for the ordinary reason: they are live objects,
 * which HOCON cannot express.
 */
export type KubernetesLeaseConfigDefaults = Partial<Pick<
  KubernetesLeaseOptionsType,
  'namespace' | 'namespacePath' | 'tokenPath' | 'caPath'
  | 'tokenReloadIntervalMs' | 'operationTimeoutMs' | 'leaseNameMaxLength'
>>;

/**
 * Read `actor-ts.coordination.lease.kubernetes.*`.  Loads its own {@link Config}
 * for the reason {@link readLeaseOptionsFromConfig} does — see there.
 *
 * `namespace` ships no leaf in `reference.conf`, so its `hasPath` is false
 * until an operator sets one, and unset keeps meaning "read it from
 * `namespace-path` in the Pod's mount".
 */
export function readKubernetesLeaseOptionsFromConfig(
  config: Config = Config.load(),
): KubernetesLeaseConfigDefaults {
  const keys = ConfigKeys.coordination.lease.kubernetes;
  const out: {
    -readonly [K in keyof KubernetesLeaseConfigDefaults]: KubernetesLeaseConfigDefaults[K]
  } = {};
  if (config.hasPath(keys.namespace)) {
    out.namespace = config.getString(keys.namespace);
  }
  if (config.hasPath(keys.namespacePath)) {
    out.namespacePath = config.getString(keys.namespacePath);
  }
  if (config.hasPath(keys.tokenPath)) {
    out.tokenPath = config.getString(keys.tokenPath);
  }
  if (config.hasPath(keys.caPath)) {
    out.caPath = config.getString(keys.caPath);
  }
  if (config.hasPath(keys.tokenReloadInterval)) {
    out.tokenReloadIntervalMs = config.getDuration(keys.tokenReloadInterval);
  }
  if (config.hasPath(keys.operationTimeout)) {
    out.operationTimeoutMs = config.getDuration(keys.operationTimeout);
  }
  if (config.hasPath(keys.leaseNameMaxLength)) {
    out.leaseNameMaxLength = config.getInt(keys.leaseNameMaxLength);
  }
  return out;
}

/**
 * Layer both config blocks under the caller's options — **explicit options >
 * HOCON > built-in defaults**.
 *
 * The common `lease.*` block is read here too, because a `KubernetesLease` is
 * a lease first: `ttl` and `renewal-interval` are set once for a deployment
 * whichever backend it runs. One {@link Config} is loaded for both reads rather
 * than one each.
 */
export function withKubernetesLeaseConfigDefaults(
  options: KubernetesLeaseOptionsType,
  config?: Config,
): KubernetesLeaseOptionsType {
  const resolved = config ?? Config.load();
  const fromConfig: LeaseConfigDefaults & KubernetesLeaseConfigDefaults = {
    ...readLeaseOptionsFromConfig(resolved),
    ...readKubernetesLeaseOptionsFromConfig(resolved),
  };
  return mergeOptions<KubernetesLeaseOptionsType>({}, fromConfig, options);
}

/**
 * Accepted input for the {@link KubernetesLease} constructor: the fluent
 * {@link KubernetesLeaseOptionsBuilder} OR a plain
 * {@link KubernetesLeaseOptionsType} object.
 */
export type KubernetesLeaseOptions = KubernetesLeaseOptionsBuilder | Partial<KubernetesLeaseOptionsType>;
/** Value alias so `KubernetesLeaseOptions.create()` / `new KubernetesLeaseOptions()` resolve to the builder. */
export const KubernetesLeaseOptions = KubernetesLeaseOptionsBuilder;
