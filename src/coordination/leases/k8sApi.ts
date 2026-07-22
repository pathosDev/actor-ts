import { Lazy } from '../../util/Lazy.js';

/**
 * Low-level Kubernetes API helpers used by `KubernetesLease`.  Three
 * concerns live here: where we get our credentials (Pod-mounted
 * ServiceAccount or explicit overrides), how we talk to the API server
 * (TLS-pinned `node:https.request`), and the four CRUD operations on
 * `coordination.k8s.io/v1/Lease` objects.
 *
 * We intentionally do NOT depend on `@kubernetes/client-node` — the
 * surface we need is small (3 endpoints), and the official client adds
 * ~3 MB of dependencies that small / edge deployments can do without.
 */

/* --------------------------- credentials ------------------------------ */

const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface K8sCredentials {
  /** API server URL (defaults to https://kubernetes.default.svc when running in-cluster). */
  readonly apiServerUrl: string;
  /** Bearer token for the ServiceAccount. */
  readonly authToken: string;
  /** PEM-encoded CA cert pinned for the API server's TLS. */
  readonly caCert: string;
  /** Default namespace as read from the SA mount; user-supplied namespace wins where supplied. */
  readonly defaultNamespace?: string;
}

/**
 * Load credentials from the standard ServiceAccount mount points.  Returns
 * `null` (rather than throwing) when none of the files are present so the
 * caller can fall back to explicit options.
 */
export async function loadInClusterCredentials(): Promise<K8sCredentials | null> {
  const fs = await fsLazy.get();
  try {
    const [token, caCert, ns] = await Promise.all([
      fs.readFile(`${SERVICE_ACCOUNT_DIR}/token`, 'utf8').catch(() => null),
      fs.readFile(`${SERVICE_ACCOUNT_DIR}/ca.crt`, 'utf8').catch(() => null),
      fs.readFile(`${SERVICE_ACCOUNT_DIR}/namespace`, 'utf8').catch(() => null),
    ]);
    if (!token || !caCert) return null;
    // KUBERNETES_SERVICE_HOST is set by the kubelet in every Pod.
    const host = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.KUBERNETES_SERVICE_HOST;
    const port = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.KUBERNETES_SERVICE_PORT_HTTPS
      ?? (globalThis as { process?: { env?: Record<string, string | undefined> } })
        .process?.env?.KUBERNETES_SERVICE_PORT
      ?? '443';
    const apiServerUrl = host
      ? `https://${host}:${port}`
      : 'https://kubernetes.default.svc';
    return {
      apiServerUrl,
      authToken: token.trim(),
      caCert,
      defaultNamespace: ns ? ns.trim() : undefined,
    };
  } catch {
    return null;
  }
}

/* --------------------------- HTTPS request ---------------------------- */

export interface K8sRequestOptions {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  readonly path: string;
  readonly body?: unknown;
  /** Provide a request-injected client (test override). */
  readonly client?: K8sFetchClient;
}

export interface K8sResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Test seam — the real impl uses `node:https`; tests pass a mock. */
export interface K8sFetchClient {
  request(creds: K8sCredentials, options: K8sRequestOptions): Promise<K8sResponse>;
}

/**
 * Perform a request against the K8s API server.  Uses `node:https` with
 * the SA-supplied CA pinned, plus a `Bearer` token in the `Authorization`
 * header.  Returns `{ status, body }` — the caller is responsible for
 * mapping HTTP status to lease semantics (200 ok, 404 missing,
 * 409 conflict).
 */
export async function k8sRequest(
  creds: K8sCredentials,
  options: K8sRequestOptions,
): Promise<K8sResponse> {
  const client = options.client ?? (await defaultClient.get());
  return client.request(creds, options);
}

/** Real `node:https` client — lazy-imported so test mocks can short-circuit. */
const defaultClient: Lazy<Promise<K8sFetchClient>> = Lazy.of(async () => {
  const httpsModule = 'node:https';
  const urlModule = 'node:url';
  const https = await import(httpsModule) as typeof import('node:https');
  const { URL } = await import(urlModule) as typeof import('node:url');
  return {
    async request(creds: K8sCredentials, options: K8sRequestOptions): Promise<K8sResponse> {
      return new Promise<K8sResponse>((resolve, reject) => {
        const url = new URL(options.path, creds.apiServerUrl);
        const bodyString = options.body === undefined ? null : JSON.stringify(options.body);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${creds.authToken}`,
          Accept: 'application/json',
        };
        if (bodyString !== null) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = String(Buffer.byteLength(bodyString));
        }
        const req = https.request({
          method: options.method,
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          headers,
          ca: creds.caCert,
          // Conservative timeout — beyond this the K8s API server is
          // probably unreachable; the lease ought to be considered lost.
          timeout: 10_000,
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = raw;
            if (raw.length > 0) {
              try { parsed = JSON.parse(raw); }
              catch { /* leave as string */ }
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('k8s request timeout')); });
        if (bodyString !== null) req.write(bodyString);
        req.end();
      });
    },
  };
});

const fsLazy: Lazy<Promise<typeof import('node:fs/promises')>> = Lazy.of(async () => {
  const name = 'node:fs/promises';
  return await import(name);
});

/* ----------------------- Lease CRUD wrappers -------------------------- */

/**
 * Wire shape for `coordination.k8s.io/v1/Lease`.  We only model the fields
 * we touch — Kubernetes returns more (managedFields, generateName, etc.)
 * but they round-trip through `unknown` if we send them back unchanged.
 */
export interface K8sLeaseObject {
  readonly apiVersion: 'coordination.k8s.io/v1';
  readonly kind: 'Lease';
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly resourceVersion?: string;
    readonly [key: string]: unknown;
  };
  readonly spec: {
    readonly holderIdentity?: string;
    readonly leaseDurationSeconds?: number;
    readonly acquireTime?: string;
    readonly renewTime?: string;
    readonly leaseTransitions?: number;
  };
}

const leasePath = (ns: string, name?: string): string =>
  `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/leases${name ? `/${encodeURIComponent(name)}` : ''}`;

/** GET — returns null on 404 (lease doesn't exist yet). */
export async function getLease(
  creds: K8sCredentials,
  namespace: string,
  name: string,
  client?: K8sFetchClient,
): Promise<K8sLeaseObject | null> {
  const response = await k8sRequest(creds, {
    method: 'GET', path: leasePath(namespace, name), client,
  });
  if (response.status === 404) return null;
  if (response.status !== 200) throw new K8sLeaseError(`GET lease ${namespace}/${name} → HTTP ${response.status}`, response);
  return response.body as K8sLeaseObject;
}

/**
 * CREATE — returns the created lease, or null on 409 (race: someone else
 * created it first; the caller should re-GET and try acquire).
 */
export async function createLease(
  creds: K8sCredentials,
  namespace: string,
  spec: Pick<K8sLeaseObject['spec'], 'holderIdentity' | 'leaseDurationSeconds' | 'acquireTime' | 'renewTime'>,
  name: string,
  client?: K8sFetchClient,
): Promise<K8sLeaseObject | null> {
  const body: K8sLeaseObject = {
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: { name, namespace },
    spec: { ...spec, leaseTransitions: 1 },
  };
  const response = await k8sRequest(creds, {
    method: 'POST', path: leasePath(namespace), body, client,
  });
  if (response.status === 201) return response.body as K8sLeaseObject;
  if (response.status === 409) return null;
  throw new K8sLeaseError(`CREATE lease ${namespace}/${name} → HTTP ${response.status}`, response);
}

/**
 * PUT — optimistic-write update.  Pass the lease object you got from
 * `getLease`, with `metadata.resourceVersion` intact, and the spec
 * fields modified.  Returns null on 409 (someone else mutated the lease
 * since we read it; caller should re-GET + retry or treat as lost).
 */
export async function updateLease(
  creds: K8sCredentials,
  lease: K8sLeaseObject,
  client?: K8sFetchClient,
): Promise<K8sLeaseObject | null> {
  const response = await k8sRequest(creds, {
    method: 'PUT',
    path: leasePath(lease.metadata.namespace, lease.metadata.name),
    body: lease,
    client,
  });
  if (response.status === 200) return response.body as K8sLeaseObject;
  if (response.status === 409) return null;
  if (response.status === 404) return null;  // someone deleted it between get + put
  throw new K8sLeaseError(
    `PUT lease ${lease.metadata.namespace}/${lease.metadata.name} → HTTP ${response.status}`, response,
  );
}

/** DELETE — best-effort, returns void.  404 is treated as success (already gone). */
export async function deleteLease(
  creds: K8sCredentials,
  namespace: string,
  name: string,
  client?: K8sFetchClient,
): Promise<void> {
  const response = await k8sRequest(creds, {
    method: 'DELETE', path: leasePath(namespace, name), client,
  });
  if (response.status === 200 || response.status === 202 || response.status === 404) return;
  throw new K8sLeaseError(`DELETE lease ${namespace}/${name} → HTTP ${response.status}`, response);
}

/* ---------------------------- errors --------------------------------- */

export class K8sLeaseError extends Error {
  constructor(message: string, public readonly response: K8sResponse) {
    super(message);
    this.name = 'K8sLeaseError';
  }
}
