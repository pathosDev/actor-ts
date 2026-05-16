/**
 * K8s API live-integration runner (B.9 / Closes #298).
 *
 * Reads k3s's admin kubeconfig (mounted from the shared volume),
 * builds a fetch function that talks to the K8s API with the admin
 * cert, and exercises KubernetesApiSeedProvider against
 * Service+Endpoints fixtures created via direct API calls.
 *
 * Why bypass the default in-cluster credential path: the default
 * `defaultFetchEndpoints` in the seed provider reads
 * `/var/run/secrets/kubernetes.io/serviceaccount/...` which only
 * exists inside a real pod.  Outside the cluster we use the admin
 * kubeconfig directly — same API surface, different auth path.
 * Testing the seed provider's lookup() over the same wire shape
 * proves the JSON-parsing + IP-extraction logic against a real
 * K8s API response.
 */
import { readFileSync } from 'node:fs';
import { Agent, type RequestOptions, request } from 'node:https';
import { KubernetesApiSeedProvider } from '../../../../src/discovery/KubernetesApiSeedProvider.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioCtx } from '../lib/scenario.js';
import { scenario as basicLookupScenario } from './scenarios/01-basic-lookup.js';
import { scenario as emptyEndpointsScenario } from './scenarios/02-empty-endpoints.js';

export interface K8sCtx extends BrokerScenarioCtx {
  readonly apiUrl: string;
  readonly ca: Buffer;
  readonly clientCert: Buffer;
  readonly clientKey: Buffer;
  readonly seedProvider: KubernetesApiSeedProvider;
  /** Direct API call helper — used by scenarios to set up fixtures. */
  api(method: string, path: string, body?: unknown): Promise<{ status: number; body: string }>;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`runner: missing env var ${name}`);
  return v;
}

/**
 * Parse k3s's kubeconfig.  We don't pull in `@kubernetes/client-node`
 * since we only need three values: the CA cert, the client cert, and
 * the client key.  k3s writes them base64-inline in the kubeconfig.
 */
function readK3sAuth(): {
  ca: Buffer; clientCert: Buffer; clientKey: Buffer;
} {
  const path = requireEnv('KUBECONFIG');
  const raw = readFileSync(path, 'utf8');
  // Yaml-style; the relevant lines are: certificate-authority-data: <b64>
  //                                     client-certificate-data: <b64>
  //                                     client-key-data: <b64>
  const grab = (key: string): Buffer => {
    const m = raw.match(new RegExp(`${key}:\\s*(\\S+)`));
    if (!m) throw new Error(`kubeconfig missing ${key}`);
    return Buffer.from(m[1]!, 'base64');
  };
  return {
    ca: grab('certificate-authority-data'),
    clientCert: grab('client-certificate-data'),
    clientKey: grab('client-key-data'),
  };
}

async function main(): Promise<void> {
  const apiUrl = requireEnv('K3S_SERVER_URL');
  const auth = readK3sAuth();

  const agent = new Agent({
    ca: auth.ca,
    cert: auth.clientCert,
    key: auth.clientKey,
  });

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> => {
    const url = new URL(path, apiUrl);
    const opts: RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      agent,
      headers: { Accept: 'application/json' },
    };
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    if (bodyStr) {
      (opts.headers as Record<string, string>)['Content-Type'] = 'application/json';
      (opts.headers as Record<string, string>)['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    return new Promise((resolve, reject) => {
      const req = request(opts, (r) => {
        let buf = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => { buf += c; });
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body: buf }));
        r.on('error', reject);
      });
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  };

  // Custom fetchEndpoints that talks to our k3s API with admin certs.
  const buildSeedProvider = (namespace: string, serviceName: string): KubernetesApiSeedProvider =>
    new KubernetesApiSeedProvider({
      namespace,
      serviceName,
      systemName: 'k8s-integration',
      port: 9000,
      fetchEndpoints: async (): Promise<string[]> => {
        const res = await api('GET', `/api/v1/namespaces/${namespace}/endpoints/${serviceName}`);
        if (res.status !== 200) throw new Error(`k8s API ${res.status}: ${res.body.slice(0, 200)}`);
        const parsed = JSON.parse(res.body) as {
          subsets?: Array<{ addresses?: Array<{ ip: string }> }>;
        };
        const ips: string[] = [];
        for (const s of parsed.subsets ?? []) {
          for (const a of s.addresses ?? []) ips.push(a.ip);
        }
        return ips;
      },
    });

  const ctx: K8sCtx = {
    env: process.env,
    apiUrl,
    ca: auth.ca,
    clientCert: auth.clientCert,
    clientKey: auth.clientKey,
    seedProvider: buildSeedProvider('default', 'placeholder'),
    api,
  };
  // Stuff the builder onto the ctx so scenarios can re-build with
  // different namespace/serviceName.  Cast to side-extend.
  (ctx as unknown as { buildSeedProvider: typeof buildSeedProvider }).buildSeedProvider =
    buildSeedProvider;

  const scenarios: BrokerScenario<K8sCtx>[] = [
    basicLookupScenario,
    emptyEndpointsScenario,
  ];
  await runScenarios(scenarios, ctx);
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
