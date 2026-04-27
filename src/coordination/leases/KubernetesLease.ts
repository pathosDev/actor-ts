import type { Lease, LeaseSettings } from '../Lease.js';

/**
 * K8s-specific additions to the common lease settings.  `fetch` and
 * `authToken` are optional — when omitted the adapter probes the default
 * service-account mount points (`/var/run/secrets/kubernetes.io/...`).
 */
export interface KubernetesLeaseSettings extends LeaseSettings {
  /** Kubernetes namespace that owns the `coordination.k8s.io/v1/Lease` object. */
  readonly namespace: string;
  /** API-server URL; defaults to `https://kubernetes.default.svc`. */
  readonly apiServerUrl?: string;
  /** Bearer token for the ServiceAccount.  Reads `/var/run/...` if omitted. */
  readonly authToken?: string;
  /** PEM-encoded CA cert for the API server.  Reads `/var/run/...` if omitted. */
  readonly caCert?: string;
}

/**
 * Lease backed by a Kubernetes `coordination.k8s.io/v1/Lease` object.  The
 * adapter is deliberately minimal — it does its own REST calls against the
 * API server instead of pulling in the full `@kubernetes/client-node`
 * dependency — so it can be used in small/edge deployments.
 *
 * **Status:** stub.  The protocol is fully described in
 * https://kubernetes.io/docs/concepts/architecture/leases/ and the
 * implementation would:
 *   1. `GET /apis/coordination.k8s.io/v1/namespaces/<ns>/leases/<name>`
 *   2. optimistic-write via `PUT` with `resourceVersion` set to force a
 *      conflict when another holder races.
 *   3. renewal loop bumps `spec.renewTime` every `ttl/3` seconds.
 *
 * We intentionally do not ship a network implementation here — the K8s
 * client surface (TLS, auth, retries) deserves its own hardening pass and
 * likely belongs in a separate optional package.  Users that need it today
 * should write a thin adapter that implements the `Lease` interface
 * against their preferred K8s client library.
 */
export class KubernetesLease implements Lease {
  constructor(private readonly settings: KubernetesLeaseSettings) { void this.settings; }

  acquire(): Promise<boolean> {
    return Promise.reject(new Error(
      'KubernetesLease is a stub — plug in a K8s client library or use InMemoryLease for tests. '
      + 'See the module docstring for the required REST exchange.',
    ));
  }

  release(): Promise<void> {
    return Promise.resolve();
  }

  checkAlive(): boolean { return false; }

  onLost(_handler: (reason: string) => void): () => void {
    return () => { /* no-op in the stub */ };
  }
}
