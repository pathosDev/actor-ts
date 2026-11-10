import { NodeAddress } from '../cluster/NodeAddress.js';
import { addressMatchesPins, parseAddressPin } from '../util/CidrMatch.js';
import type { AddressPin } from '../util/CidrMatch.js';
import {
  DEFAULT_KUBERNETES_DISCOVERY_REQUEST_TIMEOUT_MS,
  KubernetesApiSeedProviderOptionsValidator,
} from './KubernetesApiSeedProviderOptions.js';
import type { KubernetesApiSeedProviderOptions, KubernetesApiSeedProviderOptionsType } from './KubernetesApiSeedProviderOptions.js';
import type { SeedProvider } from './SeedProvider.js';

/**
 * Seed provider driven by the Kubernetes API.  Reads the Endpoints object
 * for a headless Service (or any Service) and extracts the ready pod IPs.
 *
 * Intentionally lightweight: we don't ship a full K8s client.  The
 * `fetchEndpoints` hook lets callers plug in either `@kubernetes/client-node`
 * or their own small fetch wrapper; the default implementation makes a
 * simple HTTPS call to `https://kubernetes.default.svc` using the standard
 * ServiceAccount token mount.
 *
 * **Address pinning (#145):** `pinnedAddresses` restricts the accepted
 * pod IPs to the cluster's own pod CIDR.  An `Endpoints` object is free
 * to name addresses that no pod in the cluster owns, so this is a bound
 * on what a write to that object can redirect the bootstrap towards.
 */
export class KubernetesApiSeedProvider implements SeedProvider {
  private readonly options: KubernetesApiSeedProviderOptionsType;
  /** Empty when `pinnedAddresses` is unset — i.e. pinning is off. */
  private readonly pins: readonly AddressPin[];

  constructor(options: KubernetesApiSeedProviderOptions = {}) {
    this.options = options as KubernetesApiSeedProviderOptionsType;
    new KubernetesApiSeedProviderOptionsValidator().validate(this.options);
    this.pins = (this.options.pinnedAddresses ?? [])
      .map((entry) => parseAddressPin(entry, 'KubernetesApiSeedProviderOptions'));
  }

  async lookup(): Promise<NodeAddress[]> {
    const fetchEndpoints = this.options.fetchEndpoints ?? defaultFetchEndpoints(this.options);
    const ips = await fetchEndpoints();
    return this.applyPins(ips.map(ip => new NodeAddress(this.options.systemName, ip, this.options.port)));
  }

  /**
   * Drop pod IPs outside `pinnedAddresses`, logging each one — same
   * trade-off as `DnsSeedProvider.applyPins`: a single foreign address
   * costs that address, not the whole bootstrap.
   */
  private applyPins(addresses: NodeAddress[]): NodeAddress[] {
    if (this.pins.length === 0) return addresses;
    return addresses.filter((address) => {
      if (addressMatchesPins(address.host, this.pins)) return true;
      this.options.log?.(
        `KubernetesApiSeedProvider: discarding ${address.toString()} — `
        + `Endpoints/${this.options.serviceName} named an address outside pinnedAddresses`,
      );
      return false;
    });
  }
}

/**
 * Path of the `Endpoints` object backing one Service.
 *
 * Both segments are percent-encoded, exactly as `leasePath` in
 * `src/coordination/leases/K8sApi.ts` does for the sibling lease client —
 * that client got it right and this one did not (#597).  The values reach
 * here straight out of the pod's environment (`CLUSTER_NAMESPACE` /
 * `CLUSTER_SERVICE_NAME`, via both `autoDiscovery` and
 * `singleProviderDiscovery`), so a `/` or `..` in either one otherwise
 * walks the request to a different API resource with the pod's
 * ServiceAccount token attached, and a `?` appends query parameters —
 * `?watch=true` turns the one-shot GET into a stream the body accumulator
 * below never terminates.
 *
 * Exported because it is the only seam that makes the encoding testable:
 * the `fetchEndpoints` hook replaces the whole fetcher, path construction
 * included, so injecting it can never observe what the default builds.
 */
export function endpointsPath(namespace: string, serviceName: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/endpoints/${encodeURIComponent(serviceName)}`;
}

/** What one call to the API server needs — see {@link requestEndpoints}. */
export type EndpointsRequest = {
  readonly host: string;
  readonly port: number;
  /** Built by {@link endpointsPath}. */
  readonly path: string;
  /** Bearer token — the ServiceAccount's, in-cluster. */
  readonly token: string;
  /** CA the server is verified against; `undefined` falls back to the system store. */
  readonly ca?: Buffer;
  /** Socket-inactivity ceiling, in ms — see `DEFAULT_KUBERNETES_DISCOVERY_REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs: number;
};

/**
 * One GET against the API server, returning the ready pod IPs of the
 * `Endpoints` object at `path`.
 *
 * `timeoutMs` is a wall-clock ceiling on the whole exchange, enforced through
 * an `AbortController` rather than through `https.request`'s `timeout`
 * option — and that is a measurement, not a preference.  The `timeout`
 * option is a *socket* timeout, and Bun 1.4.2 never arms it while a TLS
 * handshake is pending: against a server that accepts the connection and
 * sends nothing, `timeout: 300` and `req.setTimeout(300)` both never fire on
 * Bun (five seconds waited), while Node fires them at ~620 ms.  A stalled
 * handshake is exactly the outage this bound exists for, and the lease
 * client's `K8sApi.request` relies on that same option — so on the project's
 * primary runtime it has the hole this fixes (#1524).  `AbortSignal` fires
 * at the deadline on both runtimes and on plain HTTP alike.
 *
 * The abort carries a named reason; both runtimes surface it as the
 * `AbortError`'s `cause`, which is what the rejection unwraps to, so the
 * layers above — which handle a rejection but not a hang — see which host
 * stopped answering and after how long.
 *
 * Exported for the reason `endpointsPath` is: the default fetcher reads its
 * credentials off the in-pod mount and cannot run anywhere else, so this is
 * the seam that lets a test aim the request at a server that accepts and
 * never answers.
 */
export async function requestEndpoints(request: EndpointsRequest): Promise<string[]> {
  const https = await import('node:https');
  const agent = new https.Agent(request.ca ? { ca: request.ca } : {});
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(
    `KubernetesApiSeedProvider: no answer from ${request.host}:${request.port} within ${request.timeoutMs}ms`,
  )), request.timeoutMs);
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const clientRequest = https.request({
      host: request.host,
      port: request.port,
      path: request.path,
      method: 'GET',
      headers: { Authorization: `Bearer ${request.token}`, Accept: 'application/json' },
      agent,
      signal: deadline.signal,
    }, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => { body += c; });
      r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
      r.on('error', reject);
    });
    clientRequest.on('error', (error: Error & { cause?: unknown }) => {
      reject(error.name === 'AbortError' && error.cause instanceof Error ? error.cause : error);
    });
    clientRequest.end();
  }).finally(() => clearTimeout(timer));
  if (response.status !== 200) throw new Error(`K8s API returned ${response.status}: ${response.body.slice(0, 200)}`);
  const parsed = JSON.parse(response.body) as {
    subsets?: Array<{ addresses?: Array<{ ip: string }> }>;
  };
  const ips: string[] = [];
  for (const subset of parsed.subsets ?? []) {
    for (const addr of subset.addresses ?? []) ips.push(addr.ip);
  }
  return ips;
}

/**
 * Minimal in-cluster endpoints fetcher.  Reads the in-pod ServiceAccount
 * credentials and calls the core API through {@link requestEndpoints}.
 * Keeps the code path small — real production deployments often swap this
 * for the canonical K8s client.
 */
function defaultFetchEndpoints(options: KubernetesApiSeedProviderOptionsType): () => Promise<string[]> {
  return async (): Promise<string[]> => {
    const fs = await import('node:fs/promises');
    const token = await fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').catch(() => '');
    const ca = await fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt').catch(() => undefined);
    if (!token) throw new Error('KubernetesApiSeedProvider: no ServiceAccount token found — run inside a pod or provide fetchEndpoints');
    return requestEndpoints({
      host: 'kubernetes.default.svc',
      port: 443,
      path: endpointsPath(options.namespace, options.serviceName),
      token,
      ca,
      timeoutMs: options.requestTimeoutMs ?? DEFAULT_KUBERNETES_DISCOVERY_REQUEST_TIMEOUT_MS,
    });
  };
}
