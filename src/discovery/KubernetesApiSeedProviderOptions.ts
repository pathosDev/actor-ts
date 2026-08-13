import { addressPinRejection, isCidrEntry } from '../util/CidrMatch.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * One of the two RFC-1123 name forms Kubernetes accepts for the objects
 * this provider addresses — see {@link DNS_1123_LABEL} and
 * {@link DNS_1123_SUBDOMAIN}.
 */
type KubernetesNameShape = {
  readonly pattern: RegExp;
  readonly maxLength: number;
  /** Slotted into the rejection message after "must be ". */
  readonly description: string;
};

/*
 * Both patterns end in `(?![\s\S])` — "nothing at all follows" — rather
 * than `$`, because `$` in a JavaScript regex also matches *before* a
 * trailing newline: `/^[a-z]+$/.test('svc\n')` is `true`, so an `^…$`
 * shape rule would wave a name with a trailing line terminator through.
 * The length bound is checked separately, before the pattern runs.
 */

/** Namespace names: a single DNS-1123 label, so no dots. */
const DNS_1123_LABEL: KubernetesNameShape = {
  pattern: /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?![\s\S])/,
  maxLength: 63,
  description: 'a DNS-1123 label (lowercase alphanumeric or "-", starting and ending alphanumeric, at most 63 characters)',
};

/**
 * Service / Endpoints names: a DNS-1123 *subdomain*.  Deliberately the
 * wider of the two forms — a Service name is a label, but an `Endpoints`
 * object may carry a dotted name, and this field accepts either.
 */
const DNS_1123_SUBDOMAIN: KubernetesNameShape = {
  pattern: /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*(?![\s\S])/,
  maxLength: 253,
  description: 'a DNS-1123 subdomain (dot-separated lowercase alphanumeric labels, at most 253 characters)',
};

/** Plain options-object shape accepted by a {@link KubernetesApiSeedProvider}. */
export type KubernetesApiSeedProviderOptionsType = {
  /**
   * Target namespace to look up endpoints in.  Must be a DNS-1123 label
   * unless {@link fetchEndpoints} is supplied — see there.
   */
  readonly namespace: string;
  /**
   * Service or Endpoints name whose backing pods provide the cluster.
   * Must be a DNS-1123 subdomain unless {@link fetchEndpoints} is
   * supplied — see there.
   */
  readonly serviceName: string;
  /** System name stamped on the discovered NodeAddresses. */
  readonly systemName: string;
  /** Port for the cluster remoting endpoint on each pod. */
  readonly port: number;
  /**
   * Override the Endpoints-fetch function — defaults to the in-cluster
   * API.
   *
   * Supplying one also lifts the DNS-1123 shape rule off
   * {@link namespace} and {@link serviceName}: that rule exists because
   * the default fetcher interpolates both into the Kubernetes API path,
   * and a fetcher of your own builds its own request.  For it the two
   * fields are plain labels (they still name the Service in the
   * pin-drop message), so a name Kubernetes itself would not accept is
   * yours to define.
   */
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

    // Cross-field: the shape rule belongs to the default fetcher (#597).
    // `namespace` and `serviceName` are constrained because that fetcher
    // interpolates them into the Kubernetes API path — percent-encoding
    // keeps a `/`, `..` or `?` inside the segment it was written in, and
    // this turns what would then be a puzzling 404 into a rejection that
    // names the field.  A caller who supplies `fetchEndpoints` never
    // reaches that path, so for them the fields are plain labels and a
    // rule Kubernetes' own naming imposes would have no reason behind it.
    if (s.fetchEndpoints === undefined) {
      this.kubernetesName('namespace', s.namespace, DNS_1123_LABEL);
      this.kubernetesName('serviceName', s.serviceName, DNS_1123_SUBDOMAIN);
    }

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

  /**
   * Reject a name Kubernetes could not have given the object we are about
   * to address.  Unset passes (`nonEmptyString` above owns required-ness),
   * and the length bound is checked first so the pattern never runs over
   * an unbounded string.
   */
  private kubernetesName(
    field: 'namespace' | 'serviceName',
    value: string | undefined,
    shape: KubernetesNameShape,
  ): void {
    if (value === undefined) return;
    if (value.length > shape.maxLength || !shape.pattern.test(value)) {
      this.fail(field, `must be ${shape.description} — it addresses a Kubernetes object`, value);
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
