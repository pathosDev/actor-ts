import { NodeAddress } from '../cluster/NodeAddress.js';
import { addressMatchesPins, parseAddressPin } from '../util/CidrMatch.js';
import type { AddressPin } from '../util/CidrMatch.js';
import { KubernetesApiSeedProviderOptionsValidator } from './KubernetesApiSeedProviderOptions.js';
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
 * Minimal in-cluster endpoints fetcher.  Reads the in-pod ServiceAccount
 * credentials and calls the core API.  Keeps the code path small — real
 * production deployments often swap this for the canonical K8s client.
 */
function defaultFetchEndpoints(options: KubernetesApiSeedProviderOptionsType): () => Promise<string[]> {
  return async (): Promise<string[]> => {
    const fs = await import('node:fs/promises');
    const https = await import('node:https');
    const token = await fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').catch(() => '');
    const ca = await fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt').catch(() => undefined);
    if (!token) throw new Error('KubernetesApiSeedProvider: no ServiceAccount token found — run inside a pod or provide fetchEndpoints');

    const path = `/api/v1/namespaces/${options.namespace}/endpoints/${options.serviceName}`;
    const agent = new https.Agent(ca ? { ca } : {});
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = https.request({
        host: 'kubernetes.default.svc',
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        agent,
      }, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => { body += c; });
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
        r.on('error', reject);
      });
      request.on('error', reject);
      request.end();
    });
    if (response.status !== 200) throw new Error(`K8s API returned ${response.status}: ${response.body.slice(0, 200)}`);
    const parsed = JSON.parse(response.body) as {
      subsets?: Array<{ addresses?: Array<{ ip: string }> }>;
    };
    const ips: string[] = [];
    for (const subset of parsed.subsets ?? []) {
      for (const addr of subset.addresses ?? []) ips.push(addr.ip);
    }
    return ips;
  };
}
