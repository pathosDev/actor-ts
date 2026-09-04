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

/**
 * Where a Pod's projected ServiceAccount credential is read from.  The three
 * files used to be a module-level constant; they are parameters now so a
 * deployment can name them in HOCON (#859) — a projected volume mounted
 * somewhere other than the kubelet's default, or a token a sidecar refreshes.
 *
 * They describe **one** source and are taken whole, never field by field: the
 * defect behind #599 was exactly a per-field mix of the mounted credential
 * with an operator-named API server.
 */
export type ServiceAccountPaths = {
  /** File holding the Pod's namespace. */
  readonly namespacePath: string;
  /** File holding the bearer token. */
  readonly tokenPath: string;
  /** File holding the PEM CA cert the API server's TLS is pinned to. */
  readonly caPath: string;
};

export type K8sCredentials = {
  /** API server URL (defaults to https://kubernetes.default.svc when running in-cluster). */
  readonly apiServerUrl: string;
  /** Bearer token for the ServiceAccount. */
  readonly authToken: string;
  /** PEM-encoded CA cert pinned for the API server's TLS. */
  readonly caCert: string;
  /** Namespace as read from the SA mount; a user-supplied `namespace` wins over it. */
  readonly defaultNamespace?: string;
};

/**
 * Load credentials from the ServiceAccount mount `paths` names.  Returns
 * `null` (rather than throwing) when the token or the CA cert is not there, so
 * the caller can fall back to explicit options.
 */
export async function loadInClusterCredentials(
  paths: ServiceAccountPaths,
): Promise<K8sCredentials | null> {
  const fs = await fsLazy.get();
  try {
    const [token, caCert, ns] = await Promise.all([
      fs.readFile(paths.tokenPath, 'utf8').catch(() => null),
      fs.readFile(paths.caPath, 'utf8').catch(() => null),
      fs.readFile(paths.namespacePath, 'utf8').catch(() => null),
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

/**
 * One read of the ServiceAccount mount: the credential itself, plus the
 * `mtimeMs` the token file carried at that moment.
 *
 * The mtime travels with the credential because it is what makes re-reading
 * on a short interval affordable (#760).  A `stat` answers "still the same
 * file" for the overwhelmingly common case where nothing rotated, so only an
 * actual rotation pays for reading and trimming three files again.  It is
 * `null` when the mount could not be stat'ed, which callers must read as
 * *assume it moved* — a check that exists to skip work has to fall back to
 * the correct branch when it cannot be performed.
 */
export type MountedCredentials = {
  readonly credentials: K8sCredentials;
  readonly tokenModifiedAt: number | null;
};

/**
 * Reads the Pod's ServiceAccount mount.  A seam rather than a bare `fs` call
 * because the mounted-credential path is otherwise unreachable from a test:
 * the files live at an absolute path under `/var/run` that no test may
 * create, so without an injectable loader the whole in-cluster branch — its
 * rotation handling included — would be exercised by nothing at all.
 */
export interface MountedCredentialLoader {
  /** Read token, CA cert and namespace whole; `null` when the mount is absent. */
  read(): Promise<MountedCredentials | null>;
  /** The token file's `mtimeMs`, or `null` when it cannot be stat'ed. */
  tokenModifiedAt(): Promise<number | null>;
}

/** The token file's `mtimeMs`, or `null` when the mount cannot be stat'ed. */
async function statMountedToken(paths: ServiceAccountPaths): Promise<number | null> {
  try {
    const fs = await fsLazy.get();
    const stats = await fs.stat(paths.tokenPath);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Read the mount, stamping the credential with the token file's mtime.
 *
 * The `stat` deliberately runs **before** the read.  Rotating between the
 * two then records an mtime older than the bytes in hand, which costs one
 * redundant re-read at the next interval; the other order would record an
 * mtime newer than the bytes and miss the rotation entirely until something
 * came back 401.
 */
async function readMountedCredentials(
  paths: ServiceAccountPaths,
): Promise<MountedCredentials | null> {
  const tokenModifiedAt = await statMountedToken(paths);
  const credentials = await loadInClusterCredentials(paths);
  if (!credentials) return null;
  return { credentials, tokenModifiedAt };
}

/**
 * The real mount reader — `node:fs/promises` against the files `paths` names.
 *
 * A factory rather than the module-level singleton it replaces: the paths are
 * configuration now (#859), so which files a loader reads is a property of the
 * lease that built it and not of this module. The `credentialLoader` test seam
 * is unaffected — an injected loader still replaces this one wholesale.
 */
export function createMountedCredentialLoader(paths: ServiceAccountPaths): MountedCredentialLoader {
  return {
    read: () => readMountedCredentials(paths),
    tokenModifiedAt: () => statMountedToken(paths),
  };
}

/* --------------------------- HTTPS request ---------------------------- */

/**
 * The per-call knobs every Lease CRUD wrapper forwards to {@link k8sRequest}.
 *
 * `timeoutMs` is required rather than defaulted here on purpose: it is
 * configuration (`actor-ts.coordination.lease.kubernetes.operation-timeout`),
 * and a second copy of the number in this file is how the published default and
 * the effective one drift apart.
 */
export type K8sCallOptions = {
  /** Provide a request-injected client (test override). */
  readonly client?: K8sFetchClient;
  /** Ceiling on this one request, in ms. */
  readonly timeoutMs: number;
};

export type K8sRequestOptions = {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  readonly path: string;
  readonly body?: unknown;
  /** Provide a request-injected client (test override). */
  readonly client?: K8sFetchClient;
  /** Ceiling on this one request, in ms. */
  readonly timeoutMs: number;
};

export type K8sResponse = {
  readonly status: number;
  readonly body: unknown;
};

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
          // Beyond this the K8s API server is probably unreachable and the
          // lease ought to be considered lost.  The number comes from the
          // caller (`operationTimeoutMs`) rather than sitting here, because
          // the renewal loop's in-flight guard reasons from it.
          timeout: options.timeoutMs,
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
export type K8sLeaseObject = {
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
};

const leasePath = (ns: string, name?: string): string =>
  `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/leases${name ? `/${encodeURIComponent(name)}` : ''}`;

/** GET — returns null on 404 (lease doesn't exist yet). */
export async function getLease(
  creds: K8sCredentials,
  namespace: string,
  name: string,
  call: K8sCallOptions,
): Promise<K8sLeaseObject | null> {
  const response = await k8sRequest(creds, {
    method: 'GET', path: leasePath(namespace, name), ...call,
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
  call: K8sCallOptions,
): Promise<K8sLeaseObject | null> {
  const body: K8sLeaseObject = {
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: { name, namespace },
    spec: { ...spec, leaseTransitions: 1 },
  };
  const response = await k8sRequest(creds, {
    method: 'POST', path: leasePath(namespace), body, ...call,
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
  call: K8sCallOptions,
): Promise<K8sLeaseObject | null> {
  const response = await k8sRequest(creds, {
    method: 'PUT',
    path: leasePath(lease.metadata.namespace, lease.metadata.name),
    body: lease,
    ...call,
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
  call: K8sCallOptions,
): Promise<void> {
  const response = await k8sRequest(creds, {
    method: 'DELETE', path: leasePath(namespace, name), ...call,
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
