import type { Lease } from '../Lease.js';
import {
  DEFAULT_K8S_OPERATION_TIMEOUT_MS,
  DEFAULT_LEASE_NAME_MAX_LENGTH,
  DEFAULT_SERVICE_ACCOUNT_CA_PATH,
  DEFAULT_SERVICE_ACCOUNT_NAMESPACE_PATH,
  DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH,
  DEFAULT_TOKEN_RELOAD_INTERVAL_MS,
  KubernetesLeaseOptionsValidator,
  withKubernetesLeaseConfigDefaults,
} from './KubernetesLeaseOptions.js';
import type { KubernetesLeaseOptions, KubernetesLeaseOptionsType } from './KubernetesLeaseOptions.js';
import { truncateLeaseName } from './LeaseName.js';
import {
  createLease,
  createMountedCredentialLoader,
  deleteLease,
  getLease,
  K8sLeaseError,
  updateLease,
  type K8sCallOptions,
  type K8sCredentials,
  type K8sLeaseObject,
  type MountedCredentialLoader,
} from './K8sApi.js';

/**
 * A credential the caller supplied as a complete triple.  It carries no
 * freshness state at all, and that is the point: a token handed to the
 * constructor cannot be re-read from anywhere, so ageing it out would only
 * replace it with itself and retrying a rejected one would spin.
 */
type ExplicitCredentials = {
  readonly kind: 'explicit';
  readonly credentials: K8sCredentials;
};

/**
 * A credential read from the Pod's ServiceAccount mount.  This one does go
 * stale — the projected token is time-bound and the kubelet rewrites the
 * file — so the read is stamped with when it happened and with the token
 * file's mtime, the two facts that decide whether the copy in hand may
 * still be sent.
 */
type InClusterCredentials = {
  readonly kind: 'in-cluster';
  readonly credentials: K8sCredentials;
  /** `Date.now()` at the read that produced this copy. */
  readonly loadedAt: number;
  /** The token file's `mtimeMs` immediately before that read, `null` when unavailable. */
  readonly tokenModifiedAt: number | null;
};

/** Either credential source, tagged with which one it is. */
type ResolvedCredentials = ExplicitCredentials | InClusterCredentials;

/**
 * True for the two statuses that reject the **credential** rather than the
 * request.  Read off `K8sLeaseError.response` here rather than special-cased
 * inside the CRUD wrappers, which stay status-mapping-only as their JSDoc
 * promises.
 *
 * 403 counts alongside 401 even though it usually means RBAC: an expired
 * bearer token surfaces as either depending on the authenticator chain, and
 * being wrong costs one extra request on a path that is already failing —
 * whereas missing the 401 costs a coordination outage that no retry clears.
 */
function isCredentialRejection(error: unknown): boolean {
  if (!(error instanceof K8sLeaseError)) return false;
  return error.response.status === 401 || error.response.status === 403;
}

/**
 * Lease backed by a Kubernetes `coordination.k8s.io/v1/Lease` object.
 * Self-contained — speaks the K8s REST API directly, no client-library
 * dependency.  Designed for use behind `ClusterSingleton` so split-brain
 * is impossible: at most one Pod can hold the lease at a time, K8s
 * arbitrates via optimistic concurrency control.
 *
 * That guarantee rests on `name`, `owner` and `ttlMs` being present, so the
 * constructor rejects a missing one with `OptionsError` rather than starting
 * up half-configured (#596) — without an `owner` the CREATE/PUT carries no
 * `spec.holderIdentity` and every Pod's `acquire()` succeeds against the same
 * object.  `namespace` is checked one step later, at the first API call, only
 * because it may legitimately come from the Pod's own ServiceAccount mount
 * and that file cannot be read from a synchronous constructor (#859).
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
 *      PUT a bumped `renewTime`.  At most one renewal PUT is ever
 *      outstanding, and a rejected one is re-read before ownership is
 *      given up (#761), so only a *foreign* holder, a deleted object or
 *      an unanswerable API server fires `onLost(reason)`.
 *
 *   3. **release()** — DELETE the lease (404 is treated as success).
 *      Cancels the renewal timer first, and rejects if the DELETE
 *      itself fails — the record is then still claimed on the server
 *      while this process has dropped it, which callers must be able
 *      to see.
 *
 * Credentials are resolved per interaction and their lifetime depends on
 * where they came from (#760): an explicitly supplied triple is static, the
 * Pod's mounted ServiceAccount token is re-read on `tokenReloadIntervalMs`
 * and immediately on a 401/403.  See {@link resolveCredentials}.
 *
 * Failure modes that fire `onLost`:
 *   - A rejected renewal PUT whose re-read shows a different
 *     `holderIdentity` — someone else won a race after we read the
 *     resourceVersion.
 *   - A rejected renewal PUT whose re-read finds no lease object at all —
 *     someone deleted it.
 *   - Network error during renewal that the renewal-loop's retry budget
 *     can't absorb, including a failed re-read: ownership that cannot be
 *     confirmed may not be assumed.
 *   - PUT during renewal returns 401/403 **again** after the credential
 *     was re-read — a revocation rather than an expiry.
 *   - The K8s API server is unreachable for longer than `ttlMs`.
 *
 * A 409 whose re-read still names this owner is deliberately *not* one of
 * them: that is this holder conflicting with its own earlier write, and
 * the record is still ours (#761).
 */
export class KubernetesLease implements Lease {
  private readonly renewalIntervalMs: number;
  private readonly tokenReloadIntervalMs: number;
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The renewal currently on the wire, or `null` when none is — the guard
   * that keeps two renewals from overlapping (#761).
   *
   * `setInterval` fires on wall-clock cadence, not on completion, so a
   * request that outlives `renewalIntervalMs` is *joined* by the next tick
   * rather than replacing it.  That is ordinary rather than exotic here:
   * the default interval is `ttlMs / 3` — 5 s at the 15 s TTL the docs
   * recommend — while the HTTP client's own timeout is 10 s, so a single
   * request may legitimately span two ticks.  Both writes are then built
   * from the same `currentLease` snapshot and carry the same
   * `metadata.resourceVersion`, so the API server's optimistic concurrency
   * rejects one of *this holder's own* writes.
   *
   * Skipping the overlapping tick rather than queueing it is deliberate: a
   * renewal carries nothing the next one will not carry, so a coalesced
   * tick would only duplicate a write that is already in flight, and the
   * loop resumes on the following tick either way.
   *
   * It holds the promise rather than a boolean so the slot can be cleared
   * by *identity*.  `release()` and `fireLost()` both drop the lease while
   * a PUT may still be on the wire, and a fresh `acquire()` on the same
   * instance — which is exactly what `ClusterSingletonManager` does — can
   * start a new renewal before that PUT settles.  A boolean reset would
   * then clear the new renewal's guard on the old one's completion, which
   * is the overlap this field exists to prevent.
   */
  private renewalInFlight: Promise<void> | null = null;
  private held = false;
  private currentLease: K8sLeaseObject | null = null;
  private readonly onLostHandlers = new Set<(reason: string) => void>();
  private cachedCredentials: ResolvedCredentials | null = null;
  private readonly credentialLoader: MountedCredentialLoader;

  private readonly operationTimeoutMs: number;
  /**
   * The object name actually sent to the API server — {@link options}'s `name`,
   * truncated once here if it is longer than `leaseNameMaxLength` (#859).
   *
   * Resolved in the constructor rather than per call so every path uses one
   * name: an acquire that created `foo-<hash>` and a release that deleted `foo`
   * would leave the record claimed on the server by a process that thinks it
   * let go.
   */
  private readonly leaseName: string;
  /** Client override and per-request timeout, resolved once and forwarded to every CRUD call. */
  private readonly callOptions: K8sCallOptions;

  private readonly options: KubernetesLeaseOptionsType;

  constructor(options: KubernetesLeaseOptions = {}) {
    // HOCON layers UNDER the caller's options and ABOVE the built-in defaults,
    // and is applied before validation so a bad `operation-timeout` in a config
    // file is rejected exactly like a bad one in code (#859).
    this.options = withKubernetesLeaseConfigDefaults(options as KubernetesLeaseOptionsType);
    // Required-ness first, domain validity second — a missing field must be
    // reported as missing, not as a domain violation of `undefined`.
    const validator = new KubernetesLeaseOptionsValidator();
    validator.validateRequired(this.options);
    validator.validate(this.options);
    this.renewalIntervalMs = this.options.renewalIntervalMs
      ?? Math.max(500, Math.floor(this.options.ttlMs / 3));
    this.tokenReloadIntervalMs = this.options.tokenReloadIntervalMs
      ?? DEFAULT_TOKEN_RELOAD_INTERVAL_MS;
    this.operationTimeoutMs = this.options.operationTimeoutMs
      ?? DEFAULT_K8S_OPERATION_TIMEOUT_MS;
    this.leaseName = truncateLeaseName(
      this.options.name,
      this.options.leaseNameMaxLength ?? DEFAULT_LEASE_NAME_MAX_LENGTH,
    );
    this.callOptions = { client: this.options.client, timeoutMs: this.operationTimeoutMs };
    // The mount paths are read here and not inside the loader so an injected
    // `credentialLoader` still replaces the source whole — the seam is what
    // makes the in-cluster branch reachable from a test at all (#760).
    this.credentialLoader = this.options.credentialLoader ?? createMountedCredentialLoader({
      namespacePath: this.options.namespacePath ?? DEFAULT_SERVICE_ACCOUNT_NAMESPACE_PATH,
      tokenPath: this.options.tokenPath ?? DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH,
      caPath: this.options.caPath ?? DEFAULT_SERVICE_ACCOUNT_CA_PATH,
    });
  }

  /**
   * The namespace this lease addresses: the configured one, else the one the
   * Pod's ServiceAccount mount reported.
   *
   * The mount's `defaultNamespace` has been read since the adapter was written
   * and used by nothing — `K8sApi`'s own JSDoc claimed a fallback that did not
   * exist. Making it real is what gives `namespace-path` something to do, and
   * it is the value an in-cluster Pod almost always wants: the namespace it is
   * running in.
   *
   * It cannot be resolved in the constructor, because reading the mount is
   * asynchronous, so the failure lands at the first API call instead. That is
   * one step later than #596's other required fields and deliberately so: those
   * three, left unset, disable mutual exclusion silently, while a missing
   * namespace stops every request with the error below.
   */
  private namespaceOf(credentials: K8sCredentials): string {
    const namespace = this.options.namespace ?? credentials.defaultNamespace;
    if (namespace === undefined || namespace.length === 0) {
      throw new Error(
        'KubernetesLease: no namespace available.  Either set `namespace` (in code or as '
        + 'actor-ts.coordination.lease.kubernetes.namespace), or run inside a Pod whose '
        + 'ServiceAccount mount carries one.',
      );
    }
    return namespace;
  }

  /**
   * Resolve credentials, distinguishing the two sources by **lifetime** and
   * not only by shape (#760).
   *
   * Either source is still used **whole** (#599).  The per-field `??` merge
   * that predates this let a caller-supplied `apiServerUrl` be paired with
   * the Pod's mounted ServiceAccount token, i.e. the cluster's own bearer
   * credential sent to a host the operator named.
   * `KubernetesLeaseOptionsValidator` rejects a partial triple at
   * construction; keeping the invariant here too means no future caller can
   * reintroduce the mix by reaching past the validator.
   *
   * What differs per source is how long a resolved copy may be reused.  An
   * explicit triple is memoised for the process lifetime because it is
   * static by construction.  A mounted credential is not: the projected
   * token is time-bound, so a copy is reused for at most
   * `tokenReloadIntervalMs`, after which the token file's mtime decides
   * between another interval on the same bytes and a fresh read.  Memoising
   * *that* one forever is what turned a single expired token into a
   * coordination outage no retry could clear — `ClusterSingletonManager`
   * re-acquires on the same lease instance, so every attempt replayed the
   * same dead bearer token until the process was restarted.
   */
  private async resolveCredentials(): Promise<ResolvedCredentials> {
    const cached = this.cachedCredentials;
    if (cached !== null) {
      if (cached.kind === 'explicit') return cached;
      const revalidated = await this.revalidateInClusterCredentials(cached);
      if (revalidated !== null) {
        this.cachedCredentials = revalidated;
        return revalidated;
      }
    }
    const loaded = await this.loadCredentials();
    this.cachedCredentials = loaded;
    return loaded;
  }

  /**
   * Decide whether a cached mount read may be served again: the same
   * credential with its clock restarted, or `null` for "read the mount
   * again".
   *
   * Within the interval nothing is checked at all — that is what keeps the
   * cost of a short interval to a `stat` rather than three file reads.  An
   * unavailable mtime reads as *moved*, since a check that exists to skip
   * work must fall back to doing the work when it cannot be performed.
   */
  private async revalidateInClusterCredentials(
    cached: InClusterCredentials,
  ): Promise<InClusterCredentials | null> {
    if (Date.now() - cached.loadedAt < this.tokenReloadIntervalMs) return cached;
    const tokenModifiedAt = await this.credentialLoader.tokenModifiedAt();
    if (tokenModifiedAt === null || tokenModifiedAt !== cached.tokenModifiedAt) return null;
    return { ...cached, loadedAt: Date.now() };
  }

  /** Read whichever credential source is configured, whole. */
  private async loadCredentials(): Promise<ResolvedCredentials> {
    if (this.options.apiServerUrl && this.options.authToken && this.options.caCert) {
      return {
        kind: 'explicit',
        credentials: {
          apiServerUrl: this.options.apiServerUrl,
          authToken: this.options.authToken,
          caCert: this.options.caCert,
        },
      };
    }
    const mounted = await this.credentialLoader.read();
    if (!mounted) {
      throw new Error(
        'KubernetesLease: no credentials available.  Either supply apiServerUrl '
        + '+ authToken + caCert, or run inside a Pod with a mounted ServiceAccount '
        + `(expected a token at ${this.options.tokenPath ?? DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH}).`,
      );
    }
    return {
      kind: 'in-cluster',
      credentials: mounted.credentials,
      loadedAt: Date.now(),
      tokenModifiedAt: mounted.tokenModifiedAt,
    };
  }

  /**
   * Run one credentialed interaction with the API server, retrying it
   * exactly once against a freshly read credential when the first attempt
   * came back 401/403 (#760).
   *
   * Only the in-cluster source retries.  A caller-supplied token has no
   * second copy to read, so retrying it would send the same rejected bearer
   * token twice and turn one failing request into two — which is also what
   * bounds this against a retry loop.
   *
   * A retry that is itself rejected drops the cache before it rethrows.
   * Leaving a credential the API server has just refused as the memo the
   * next attempt starts from is precisely the defect being fixed: the
   * caller above is a 5-second re-acquire loop, and the cache is what
   * decides whether that loop can ever recover.
   */
  private async withFreshCredentials<T>(
    operation: (credentials: K8sCredentials) => Promise<T>,
  ): Promise<T> {
    const resolved = await this.resolveCredentials();
    try {
      return await operation(resolved.credentials);
    } catch (e) {
      if (resolved.kind !== 'in-cluster' || !isCredentialRejection(e)) throw e;
      this.cachedCredentials = null;
      const reloaded = await this.resolveCredentials();
      try {
        return await operation(reloaded.credentials);
      } catch (retryFailure) {
        if (isCredentialRejection(retryFailure)) this.cachedCredentials = null;
        throw retryFailure;
      }
    }
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

  /**
   * One pass of GET → CREATE-or-PUT.  Three outcomes: success /
   * held-by-other / race.
   *
   * The whole pass sits inside {@link withFreshCredentials}, so a stale
   * mounted token is re-read and the GET replayed rather than surfacing as
   * a failed acquire — which is the path `ClusterSingletonManager` retries
   * on after a lost lease.
   */
  private async tryAcquireOnce(): Promise<'success' | 'held-by-other' | 'race'> {
    return await this.withFreshCredentials((credentials) => this.acquirePass(credentials));
  }

  /** The GET → CREATE-or-PUT itself, against one already-resolved credential. */
  private async acquirePass(
    credentials: K8sCredentials,
  ): Promise<'success' | 'held-by-other' | 'race'> {
    const namespace = this.namespaceOf(credentials);
    const name = this.leaseName;
    const ttlSeconds = Math.max(1, Math.ceil(this.options.ttlMs / 1000));
    const now = new Date().toISOString();

    const existing = await getLease(credentials, namespace, name, this.callOptions);

    if (existing === null) {
      // No lease object yet — create.  CREATE returns null on 409 (race lost).
      const created = await createLease(credentials, namespace, {
        holderIdentity: this.options.owner,
        leaseDurationSeconds: ttlSeconds,
        acquireTime: now,
        renewTime: now,
      }, name, this.callOptions);
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
        leaseDurationSeconds: ttlSeconds,
        acquireTime: now,
        renewTime: now,
        leaseTransitions: ownerChanging ? transitionsBefore + 1 : transitionsBefore,
      },
    };
    const result = await updateLease(credentials, updated, this.callOptions);
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
   * process considers released.  What it cannot cancel is a renewal PUT
   * already on the wire; {@link renewalInFlight} is deliberately left set
   * until that request settles, so a re-`acquire()` on this instance
   * cannot start a second one alongside it (#761).
   */
  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }
    this.currentLease = null;
    await this.withFreshCredentials((credentials) =>
      deleteLease(credentials, this.namespaceOf(credentials), this.leaseName, this.callOptions));
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

  /**
   * One renewal tick — or nothing at all, when the previous tick's PUT has
   * not come back yet.  See {@link renewalInFlight} for why a tick that
   * finds one outstanding is dropped rather than queued (#761).
   */
  private async renewOnce(): Promise<void> {
    if (this.renewalInFlight !== null) return;
    const lease = this.currentLease;
    if (!this.held || lease === null) return;
    const attempt = this.renewalPass(lease);
    this.renewalInFlight = attempt;
    try {
      await attempt;
    } finally {
      // By identity, not a bare null: a release + re-acquire may have
      // installed a *newer* attempt while this one was still on the wire,
      // and clearing that one's slot would let the two overlap.
      if (this.renewalInFlight === attempt) this.renewalInFlight = null;
    }
  }

  /**
   * The renewal PUT itself, against the lease snapshot the tick started
   * from.  Credential resolution is folded into the same try/catch as the
   * PUT so that a 401/403 gets the one re-read + retry
   * {@link withFreshCredentials} grants it before anything is declared
   * lost — a rotated token used to reach `onLost` on the first rejection
   * and stay there.
   *
   * The snapshot is a parameter rather than a re-read of `currentLease`
   * because the field may be nulled by `release()` or `fireLost()` while
   * this is running; the write has to be built from the state the tick
   * decided to renew.
   */
  private async renewalPass(lease: K8sLeaseObject): Promise<void> {
    const now = new Date().toISOString();
    const ttlSeconds = Math.max(1, Math.ceil(this.options.ttlMs / 1000));
    const updated: K8sLeaseObject = {
      ...lease,
      spec: {
        ...lease.spec,
        holderIdentity: this.options.owner,
        leaseDurationSeconds: ttlSeconds,
        renewTime: now,
      },
    };
    try {
      const result = await this.withFreshCredentials((credentials) =>
        updateLease(credentials, updated, this.callOptions));
      if (result === null) {
        await this.reconcileRejectedRenewal();
        return;
      }
      // Guarded because `release()` may have run while the PUT was on the
      // wire: adopting a resourceVersion into a lease this process has
      // already dropped would resurrect state nothing reads back.
      if (this.held) this.currentLease = result;
    } catch (e) {
      const message = e instanceof K8sLeaseError
        ? `renewal http error: ${e.message}`
        : `renewal error: ${(e as Error).message}`;
      this.fireLost(message);
    }
  }

  /**
   * Decide what a rejected renewal PUT actually means, by reading the
   * record back before ownership is given up (#761).
   *
   * `updateLease` maps both 409 and 404 to `null`, and a 409 is *not*
   * evidence of a takeover — it only says the `resourceVersion` moved.
   * The in-flight guard above removes the source this issue was filed
   * for, but not the others: a re-`acquire()` on a still-held lease PUTs
   * from its own GET while a renewal tick holds the older version, and
   * anything else with write access to the object — another controller,
   * a finalizer, a `kubectl label` — bumps the version without touching
   * `holderIdentity` at all.  Concluding "lost" from the status alone
   * stops the singleton for a lease this pod still owns, and the K8s
   * record then names this pod with a fresh `renewTime`, so no other pod
   * may take over either — a self-inflicted outage on both sides.
   *
   * The re-read is what distinguishes the three cases, and only the
   * `holderIdentity` on the server is trusted to do it:
   *
   *   - **gone** — someone deleted the object; the lease really is lost.
   *   - **a different holder** — a real takeover; the lease really is lost.
   *   - **still this owner** — ours all along.  Adopt the server's
   *     `resourceVersion`, which is also what lets the *next* tick's CAS
   *     match instead of conflicting again on the same stale version.
   *
   * A re-read that fails outright falls through to the caller's catch and
   * fires `onLost`: ownership that cannot be confirmed may not be assumed.
   */
  private async reconcileRejectedRenewal(): Promise<void> {
    const current = await this.withFreshCredentials((credentials) =>
      getLease(credentials, this.namespaceOf(credentials), this.leaseName, this.callOptions));
    if (current === null) {
      this.fireLost('lease lost during renewal (the lease object was deleted)');
      return;
    }
    const holder = current.spec.holderIdentity;
    if (holder !== this.options.owner) {
      // Falsy rather than nullish for the description: a missing field and
      // an empty string both mean unowned, which is how `isStillHeldByOther`
      // reads them too.  Either way the record is not ours any more.
      this.fireLost(`lease lost during renewal (now held by ${holder ? holder : 'nobody'})`);
      return;
    }
    if (this.held) this.currentLease = current;
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
