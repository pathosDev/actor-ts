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
 * That guarantee rests on `name`, `owner`, `ttlMs` and `namespace` being
 * present, so the constructor rejects a missing one with `OptionsError`
 * rather than starting up half-configured (#596) — without an `owner`
 * the CREATE/PUT carries no `spec.holderIdentity` and every Pod's
 * `acquire()` succeeds against the same object.
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
 *      Cancels the renewal timer first, and rejects if the DELETE
 *      itself fails — the record is then still claimed on the server
 *      while this process has dropped it, which callers must be able
 *      to see.
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
    // Required-ness first, domain validity second — a missing field must be
    // reported as missing, not as a domain violation of `undefined`.
    const validator = new KubernetesLeaseOptionsValidator();
    validator.validateRequired(this.options);
    validator.validate(this.options);
    this.renewalIntervalMs = this.options.renewalIntervalMs
      ?? Math.max(500, Math.floor(this.options.ttlMs / 3));
  }

  /**
   * Resolve credentials lazily — once on first call, cached after.
   *
   * Either source is used **whole** (#599).  The per-field `??` merge this
   * replaces let a caller-supplied `apiServerUrl` be paired with the Pod's
   * mounted ServiceAccount token, i.e. the cluster's own bearer credential
   * sent to a host the operator named.  `KubernetesLeaseOptionsValidator`
   * rejects a partial triple at construction; keeping the invariant here
   * too means no future caller can reintroduce the mix by reaching past
   * the validator.
   */
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
    this.creds = inCluster;
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

  /**
   * True iff the existing lease has a different live holder.
   *
   * Every field consulted here was written by the *previous holder*, so
   * none of it may be taken at face value (#598).  Left unbounded, a
   * single write of `leaseDurationSeconds: 2147483647` or a `renewTime`
   * in the year 3000 keeps this method answering "still held" for
   * decades — no pod ever runs the singleton again, and the write needs
   * only the Lease-CRUD RBAC the framework's own example prescribes.
   * Two bounds make such a record survivable:
   *
   *   - the remote duration is capped at a *multiple* of our own TTL,
   *     not at our own TTL.  Capping at exactly ours would be unsafe in
   *     the other direction: during a rolling upgrade that raises
   *     `ttlMs`, the node still on the smaller value would declare a
   *     live holder expired and steal the lease.  The multiple absorbs
   *     an ordinary configuration spread while still bounding a hostile
   *     value;
   *   - a `renewTime` further ahead than one local TTL cannot come from
   *     an honest holder with a sane clock, so it is treated as expired
   *     rather than as live.  Believing it is what turns one write into
   *     a permanent wedge, and clamping it to "now" would be no better,
   *     since every later call would clamp it again.
   *
   * A missing *or* unparseable `renewTime` still reads as live: neither
   * carries usable information, and for an owned record the safe reading
   * is "someone holds this".  That the two now agree is itself a fix —
   * `new Date('garbage').getTime()` is `NaN` and `NaN > Date.now()` is
   * `false`, so an unparseable timestamp used to mean *free for the
   * taking*, the opposite polarity of the missing-timestamp branch
   * directly beside it.
   */
  private isStillHeldByOther(lease: K8sLeaseObject): boolean {
    const holder = lease.spec.holderIdentity;
    if (!holder) return false;                       // unowned
    if (holder === this.options.owner) return false; // we already hold it

    const renewedAt = new Date(lease.spec.renewTime ?? '').getTime();
    if (!Number.isFinite(renewedAt)) return true;    // missing / unparseable → assume live
    const now = Date.now();
    if (renewedAt > now + this.options.ttlMs) return false;  // implausibly far ahead → not credible

    /** How far a remote holder's TTL may exceed ours before we stop believing it. */
    const remoteDurationTolerance = 4;
    const remoteDurationMs = (lease.spec.leaseDurationSeconds ?? 0) * 1000;
    const durationMs = Number.isFinite(remoteDurationMs) && remoteDurationMs > 0
      ? Math.min(remoteDurationMs, this.options.ttlMs * remoteDurationTolerance)
      : this.options.ttlMs;
    return renewedAt + durationMs > now;
  }

  /**
   * Stop renewing, then DELETE the lease object.
   *
   * A DELETE that fails now rejects instead of being swallowed (#600).
   * Swallowing it reported a clean release for a record still claimed by
   * us on the server — the ambiguous state `LeaseMajority`'s fail-safe
   * exists for, which the swallow made unreachable.  Every in-repo caller
   * treats release as cleanup and catches; `Lease.release()` documents
   * the rejection.
   *
   * Renewal is stopped and local state dropped before the request, so a
   * failed DELETE cannot leave a timer quietly renewing a lease this
   * process considers released.
   */
  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }
    this.currentLease = null;
    const creds = await this.getCreds();
    await deleteLease(creds, this.options.namespace, this.options.name, this.options.client);
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
      const message = e instanceof K8sLeaseError
        ? `renewal http error: ${e.message}`
        : `renewal error: ${(e as Error).message}`;
      this.fireLost(message);
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
