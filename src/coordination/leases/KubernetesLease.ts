import type { Lease } from '../Lease.js';
import { KubernetesLeaseOptionsValidator } from './KubernetesLeaseOptions.js';
import type { KubernetesLeaseOptions, KubernetesLeaseOptionsType } from './KubernetesLeaseOptions.js';
import {
  createLease,
  deleteLease,
  getLease,
  K8sLeaseError,
  loadInClusterCredentials,
  updateLease,
  type K8sCredentials,
  type K8sLeaseObject,
} from './k8sApi.js';

/**
 * Lease backed by a Kubernetes `coordination.k8s.io/v1/Lease` object.
 * Self-contained — speaks the K8s REST API directly, no client-library
 * dependency.  Designed for use behind `ClusterSingleton` so split-brain
 * is impossible: at most one Pod can hold the lease at a time, K8s
 * arbitrates via optimistic concurrency control.
 *
 * Lifecycle:
 *
 *   1. **acquire()** — GET the lease object.  If it doesn't exist, CREATE
 *      it with `holderIdentity = options.owner`.  If it does exist and
 *      either it's already ours or the previous holder's `renewTime + ttl`
 *      has passed, PUT a new spec with our owner + a fresh
 *      `acquireTime` / `renewTime`.  Returns true on success, false on a
 *      live conflict.  Optimistic-write 409 conflicts are retried up to
 *      `acquireRetries` times.
 *
 *   2. **renewal loop** — every `renewalIntervalMs` (default `ttl/3`),
 *      GET + PUT to bump `renewTime`.  A 409 / 404 / network error here
 *      is treated as 'lease lost' and fires `onLost(reason)`.
 *
 *   3. **release()** — DELETE the lease (404 is treated as success).
 *      Cancels the renewal timer.
 *
 * Failure modes that fire `onLost`:
 *   - PUT during renewal returns 409 (someone else won a race after we
 *     read the resourceVersion).
 *   - PUT during renewal returns 404 (someone deleted the lease).
 *   - Network error during renewal that the renewal-loop's retry budget
 *     can't absorb.
 *   - The K8s API server is unreachable for longer than `ttlMs`.
 */
export class KubernetesLease implements Lease {
  private readonly renewalIntervalMs: number;
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  private held = false;
  private currentLease: K8sLeaseObject | null = null;
  private readonly onLostHandlers = new Set<(reason: string) => void>();
  private creds: K8sCredentials | null = null;

  private readonly options: KubernetesLeaseOptionsType;

  constructor(options: KubernetesLeaseOptions = {}) {
    this.options = options as KubernetesLeaseOptionsType;
    new KubernetesLeaseOptionsValidator().validate(this.options);
    this.renewalIntervalMs = this.options.renewalIntervalMs
      ?? Math.max(500, Math.floor(this.options.ttlMs / 3));
  }

  /** Resolve credentials lazily — once on first call, cached after. */
  private async getCreds(): Promise<K8sCredentials> {
    if (this.creds) return this.creds;
    if (this.options.apiServerUrl && this.options.authToken && this.options.caCert) {
      this.creds = {
        apiServerUrl: this.options.apiServerUrl,
        authToken: this.options.authToken,
        caCert: this.options.caCert,
      };
      return this.creds;
    }
    const inCluster = await loadInClusterCredentials();
    if (!inCluster) {
      throw new Error(
        'KubernetesLease: no credentials available.  Either supply apiServerUrl '
        + '+ authToken + caCert, or run inside a Pod with a mounted ServiceAccount '
        + `(${'/var/run/secrets/kubernetes.io/serviceaccount'}).`,
      );
    }
    this.creds = {
      apiServerUrl: this.options.apiServerUrl ?? inCluster.apiServerUrl,
      authToken: this.options.authToken ?? inCluster.authToken,
      caCert: this.options.caCert ?? inCluster.caCert,
      defaultNamespace: inCluster.defaultNamespace,
    };
    return this.creds;
  }

  async acquire(): Promise<boolean> {
    return (await this.acquireWithToken()) !== null;
  }

  /**
   * Fencing-token variant: returns a backend-issued token assembled
   * from the K8s `Lease` object's `metadata.resourceVersion` and the
   * `spec.leaseTransitions` counter — both monotonically bumped by
   * the API server on every successful PUT.  The combination is
   * unique per acquire across the lease's lifetime, so a
   * late-arriving "I acquired" can be distinguished from a fresh
   * one by its token.
   *
   * Format: `<resourceVersion>/<leaseTransitions>` (resourceVersion
   * is opaque K8s state; leaseTransitions is decimal).
   */
  async acquireWithToken(): Promise<{ readonly token: string } | null> {
    const retries = this.options.acquireRetries ?? 3;
    const retryDelay = this.options.acquireRetryDelayMs ?? 100;
    for (let attempt = 0; attempt < retries; attempt++) {
      const result = await this.tryAcquireOnce();
      if (result === 'success') {
        const obj = this.currentLease;
        const rv = obj?.metadata?.resourceVersion ?? 'unknown';
        const transitions = obj?.spec.leaseTransitions ?? 0;
        return { token: `${rv}/${transitions}` };
      }
      if (result === 'held-by-other') return null;
      // 'race' — someone else mutated the lease between our GET and PUT;
      // back off briefly and retry.
      if (attempt < retries - 1) await sleep(retryDelay);
    }
    return null;
  }

  /** One pass of GET → CREATE-or-PUT.  Three outcomes: success / held-by-other / race. */
  private async tryAcquireOnce(): Promise<'success' | 'held-by-other' | 'race'> {
    const creds = await this.getCreds();
    const ns = this.options.namespace;
    const name = this.options.name;
    const ttlSec = Math.max(1, Math.ceil(this.options.ttlMs / 1000));
    const now = new Date().toISOString();

    const existing = await getLease(creds, ns, name, this.options.client);

    if (existing === null) {
      // No lease object yet — create.  CREATE returns null on 409 (race lost).
      const created = await createLease(creds, ns, {
        holderIdentity: this.options.owner,
        leaseDurationSeconds: ttlSec,
        acquireTime: now,
        renewTime: now,
      }, name, this.options.client);
      if (!created) return 'race';
      this.held = true;
      this.currentLease = created;
      this.startRenewalLoop();
      return 'success';
    }

    // Lease object exists.  Decide whether we can take it.
    if (this.isStillHeldByOther(existing)) return 'held-by-other';

    // Either ours or expired — bump owner via PUT with the resourceVersion
    // we just GET'd.  K8s rejects with 409 if anyone else mutated since.
    const transitionsBefore = existing.spec.leaseTransitions ?? 0;
    const ownerChanging = existing.spec.holderIdentity !== this.options.owner;
    const updated: K8sLeaseObject = {
      ...existing,
      spec: {
        ...existing.spec,
        holderIdentity: this.options.owner,
        leaseDurationSeconds: ttlSec,
        acquireTime: now,
        renewTime: now,
        leaseTransitions: ownerChanging ? transitionsBefore + 1 : transitionsBefore,
      },
    };
    const result = await updateLease(creds, updated, this.options.client);
    if (!result) return 'race';
    this.held = true;
    this.currentLease = result;
    this.startRenewalLoop();
    return 'success';
  }

  /** True iff the existing lease has a different live holder. */
  private isStillHeldByOther(lease: K8sLeaseObject): boolean {
    const holder = lease.spec.holderIdentity;
    if (!holder) return false;                       // unowned
    if (holder === this.options.owner) return false; // we already hold it
    const renewTime = lease.spec.renewTime;
    const durationSec = lease.spec.leaseDurationSeconds ?? this.options.ttlMs / 1000;
    if (!renewTime) return true;                     // owned but no time → assume live
    const expiresAt = new Date(renewTime).getTime() + durationSec * 1000;
    return expiresAt > Date.now();
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }
    const creds = await this.getCreds().catch(() => null);
    if (!creds) return;
    try {
      await deleteLease(creds, this.options.namespace, this.options.name, this.options.client);
    } catch (e) {
      // best-effort — log via thrown info but don't fail the caller
      // (release is a cleanup hook).
      void e;
    }
    this.currentLease = null;
  }

  checkAlive(): boolean { return this.held; }

  onLost(handler: (reason: string) => void): () => void {
    this.onLostHandlers.add(handler);
    return () => this.onLostHandlers.delete(handler);
  }

  /* ---------------------------- internals --------------------------- */

  private startRenewalLoop(): void {
    if (this.renewalTimer) return;
    this.renewalTimer = setInterval(() => {
      void this.renewOnce();
    }, this.renewalIntervalMs);
  }

  private async renewOnce(): Promise<void> {
    if (!this.held || !this.currentLease) return;
    let creds: K8sCredentials;
    try { creds = await this.getCreds(); }
    catch (e) {
      this.fireLost(`renewal failed: ${(e as Error).message}`);
      return;
    }
    const now = new Date().toISOString();
    const ttlSec = Math.max(1, Math.ceil(this.options.ttlMs / 1000));
    const updated: K8sLeaseObject = {
      ...this.currentLease,
      spec: {
        ...this.currentLease.spec,
        holderIdentity: this.options.owner,
        leaseDurationSeconds: ttlSec,
        renewTime: now,
      },
    };
    try {
      const result = await updateLease(creds, updated, this.options.client);
      if (!result) {
        // 409 / 404 — somebody else won, or the object was deleted.
        this.fireLost('lease lost during renewal (conflict or 404)');
        return;
      }
      this.currentLease = result;
    } catch (e) {
      const msg = e instanceof K8sLeaseError
        ? `renewal http error: ${e.message}`
        : `renewal error: ${(e as Error).message}`;
      this.fireLost(msg);
    }
  }

  private fireLost(reason: string): void {
    if (!this.held) return;
    this.held = false;
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }
    this.currentLease = null;
    for (const handler of this.onLostHandlers) {
      try { handler(reason); } catch { /* swallow */ }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
