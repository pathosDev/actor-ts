import { NodeAddress } from '../cluster/NodeAddress.js';
import type { KubernetesApiSeedProviderOptions } from './KubernetesApiSeedProviderOptions.js';
import type { SeedProvider } from './SeedProvider.js';

export interface KubernetesApiSeedProviderSettings {
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
 * Seed provider driven by the Kubernetes API.  Reads the Endpoints object
 * for a headless Service (or any Service) and extracts the ready pod IPs.
 *
 * Intentionally lightweight: we don't ship a full K8s client.  The
 * `fetchEndpoints` hook lets callers plug in either `@kubernetes/client-node`
 * or their own small fetch wrapper; the default implementation makes a
 * simple HTTPS call to `https://kubernetes.default.svc` using the standard
 * ServiceAccount token mount.
 */
export class KubernetesApiSeedProvider implements SeedProvider {
  private readonly settings: KubernetesApiSeedProviderSettings;

  constructor(options: KubernetesApiSeedProviderOptions | Partial<KubernetesApiSeedProviderSettings> = {}) {
    this.settings = options as KubernetesApiSeedProviderSettings;
  }

  async lookup(): Promise<NodeAddress[]> {
    const fetchEndpoints = this.settings.fetchEndpoints ?? defaultFetchEndpoints(this.settings);
    const ips = await fetchEndpoints();
    return ips.map(ip => new NodeAddress(this.settings.systemName, ip, this.settings.port));
  }
}

/**
 * Minimal in-cluster endpoints fetcher.  Reads the in-pod ServiceAccount
 * credentials and calls the core API.  Keeps the code path small — real
 * production deployments often swap this for the canonical K8s client.
 */
function defaultFetchEndpoints(settings: KubernetesApiSeedProviderSettings): () => Promise<string[]> {
  return async (): Promise<string[]> => {
    const fs = await import('node:fs/promises');
    const https = await import('node:https');
    const token = await fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').catch(() => '');
    const ca = await fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt').catch(() => undefined);
    if (!token) throw new Error('KubernetesApiSeedProvider: no ServiceAccount token found — run inside a pod or provide fetchEndpoints');

    const path = `/api/v1/namespaces/${settings.namespace}/endpoints/${settings.serviceName}`;
    const agent = new https.Agent(ca ? { ca } : {});
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = https.request({
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
      req.on('error', reject);
      req.end();
    });
    if (res.status !== 200) throw new Error(`K8s API returned ${res.status}: ${res.body.slice(0, 200)}`);
    const parsed = JSON.parse(res.body) as {
      subsets?: Array<{ addresses?: Array<{ ip: string }> }>;
    };
    const ips: string[] = [];
    for (const subset of parsed.subsets ?? []) {
      for (const addr of subset.addresses ?? []) ips.push(addr.ip);
    }
    return ips;
  };
}
