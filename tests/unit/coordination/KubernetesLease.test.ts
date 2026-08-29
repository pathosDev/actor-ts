import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { KubernetesLease } from '../../../src/coordination/leases/KubernetesLease.js';
import { KubernetesLeaseOptions, type KubernetesLeaseOptionsType } from '../../../src/coordination/leases/KubernetesLeaseOptions.js';
import type {
  K8sCredentials,
  K8sFetchClient,
  K8sLeaseObject,
  K8sRequestOptions,
  K8sResponse,
  MountedCredentialLoader,
  MountedCredentials,
} from '../../../src/coordination/leases/K8sApi.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

const TEST_CREDS = {
  apiServerUrl: 'https://kubernetes.test',
  authToken: 'test-token',
  caCert: '<<test-ca-cert>>',
};

/**
 * In-memory K8s API server stand-in.  Holds a single Lease object for
 * the namespace the tests operate in, supports the four operations
 * (GET / POST / PUT / DELETE), and respects optimistic concurrency via
 * `metadata.resourceVersion`.  Exposes a few hooks (forceConflictNext,
 * forceMissingNext, blockPuts, bumpResourceVersion) so tests can drive the
 * failure paths without timing tricks.
 */
class FakeK8sServer implements K8sFetchClient {
  private leases = new Map<string, K8sLeaseObject>();
  private rvCounter = 1;
  /** When set, the next mutating op (PUT / POST / DELETE) returns 409. */
  forceConflictNext = false;
  /** When set, the next GET pretends the lease is missing. */
  forceMissingNext = false;
  /** When set, the next DELETE fails with a 500 (API server having a bad day). */
  forceDeleteErrorNext = false;
  /**
   * Bearer tokens this API server refuses — every request carrying one is
   * answered 401, for as long as it stays in the set.  Modelling expiry as
   * a property of the *token* rather than of the request count is what lets
   * a test rotate the mount and watch which copy the next request sends
   * (#760).
   */
  rejectedTokens = new Set<string>();
  /**
   * Capture every request for assertion — `authToken` included, since which
   * credential a request carried is the whole subject of the token-reload
   * cases and used to be discarded here.
   */
  log: Array<{ method: string; path: string; body?: unknown; authToken: string }> = [];
  /**
   * The highest number of PUTs that were ever inside {@link request} at the
   * same instant.  The direct observable for the in-flight guard (#761):
   * the defect is two renewal PUTs overlapping, and this counts exactly
   * that, without the test having to reason about which one won.
   */
  maxConcurrentPuts = 0;
  private putsInProgress = 0;
  /** Resolvers for the PUTs {@link blockPuts} is holding open, oldest first. */
  private readonly parkedPutResolvers: Array<() => void> = [];
  private putsBlocked = false;

  async request(credentials: K8sCredentials, options: K8sRequestOptions): Promise<K8sResponse> {
    this.log.push({
      method: options.method,
      path: options.path,
      body: options.body,
      authToken: credentials.authToken,
    });
    if (this.rejectedTokens.has(credentials.authToken)) {
      return { status: 401, body: { code: 401, reason: 'Unauthorized' } };
    }
    const match = options.path.match(/^\/apis\/coordination\.k8s\.io\/v1\/namespaces\/([^/]+)\/leases(?:\/([^/]+))?$/);
    if (!match) return { status: 404, body: null };
    const ns = decodeURIComponent(match[1]!);
    const name = match[2] ? decodeURIComponent(match[2]) : null;

    if (options.method === 'GET') {
      if (!name) return { status: 200, body: { kind: 'LeaseList', items: [] } };
      if (this.forceMissingNext) {
        this.forceMissingNext = false;
        return { status: 404, body: { code: 404, reason: 'NotFound' } };
      }
      const found = this.leases.get(`${ns}/${name}`);
      if (!found) return { status: 404, body: { code: 404, reason: 'NotFound' } };
      return { status: 200, body: found };
    }

    if (options.method === 'POST' && !name) {
      const lease = options.body as K8sLeaseObject;
      const key = `${ns}/${lease.metadata.name}`;
      if (this.forceConflictNext) {
        this.forceConflictNext = false;
        return { status: 409, body: { code: 409, reason: 'AlreadyExists' } };
      }
      if (this.leases.has(key)) {
        return { status: 409, body: { code: 409, reason: 'AlreadyExists' } };
      }
      const created: K8sLeaseObject = {
        ...lease,
        metadata: { ...lease.metadata, resourceVersion: String(this.rvCounter++) },
      };
      this.leases.set(key, created);
      return { status: 201, body: created };
    }

    if (options.method === 'PUT' && name) {
      return await this.servePut(ns, name, options.body as K8sLeaseObject);
    }

    if (options.method === 'DELETE' && name) {
      if (this.forceDeleteErrorNext) {
        this.forceDeleteErrorNext = false;
        return { status: 500, body: { code: 500, reason: 'InternalError' } };
      }
      const key = `${ns}/${name}`;
      const existed = this.leases.delete(key);
      if (!existed) return { status: 404, body: { code: 404 } };
      return { status: 200, body: { kind: 'Status', status: 'Success' } };
    }

    return { status: 405, body: { code: 405 } };
  }

  /**
   * The PUT branch, split out so the concurrency bookkeeping can wrap the
   * whole of it — including the parking {@link blockPuts} performs, which
   * is the point: a request held open is still in flight, and counting it
   * as such is what makes the overlap observable (#761).
   */
  private async servePut(
    namespace: string,
    name: string,
    incoming: K8sLeaseObject,
  ): Promise<K8sResponse> {
    this.putsInProgress++;
    this.maxConcurrentPuts = Math.max(this.maxConcurrentPuts, this.putsInProgress);
    try {
      if (this.putsBlocked) {
        await new Promise<void>((resolve) => { this.parkedPutResolvers.push(resolve); });
      }
      if (this.forceConflictNext) {
        this.forceConflictNext = false;
        return { status: 409, body: { code: 409, reason: 'Conflict' } };
      }
      const key = `${namespace}/${name}`;
      const existing = this.leases.get(key);
      if (!existing) return { status: 404, body: { code: 404 } };
      if (existing.metadata.resourceVersion !== incoming.metadata.resourceVersion) {
        return { status: 409, body: { code: 409, reason: 'Conflict' } };
      }
      const updated: K8sLeaseObject = {
        ...incoming,
        metadata: { ...incoming.metadata, resourceVersion: String(this.rvCounter++) },
      };
      this.leases.set(key, updated);
      return { status: 200, body: updated };
    } finally {
      this.putsInProgress--;
    }
  }

  /**
   * Test helper — hold every PUT from now on open instead of answering it.
   *
   * Parking the request rather than delaying it behind a timer is what
   * makes the overlap deterministic: while one is parked, any PUT that
   * arrives is unambiguously a second one on the wire, with no sleep to
   * tune and nothing for a loaded machine to reorder.
   */
  blockPuts(): void { this.putsBlocked = true; }

  /** Test helper — answer every parked PUT and stop parking new ones. */
  unblockPuts(): void {
    this.putsBlocked = false;
    for (const resolve of this.parkedPutResolvers.splice(0)) resolve();
  }

  /** Test helper — how many PUTs are parked right now. */
  parkedPuts(): number { return this.parkedPutResolvers.length; }

  /**
   * Test helper — move the stored `resourceVersion` on without touching the
   * spec, and return the new one.
   *
   * This is what the tail of an overlapping renewal looks like from the
   * holder's side: its own earlier PUT landed and bumped the version, so
   * the write it has already built carries a stale one and is rejected —
   * by the holder itself, against a record that still names it (#761).
   */
  bumpResourceVersion(namespace: string, name: string): string {
    const key = `${namespace}/${name}`;
    const existing = this.leases.get(key)!;
    const resourceVersion = String(this.rvCounter++);
    this.leases.set(key, { ...existing, metadata: { ...existing.metadata, resourceVersion } });
    return resourceVersion;
  }

  /**
   * Test helper — directly insert a lease as if another holder had created it.
   *
   * Takes a plain `K8sLeaseObject`: `resourceVersion` is already optional on
   * it, and the `Omit<…, 'resourceVersion'>` this used to carry was worse
   * than redundant — `metadata` has an index signature, and `Omit` over one
   * collapses to `{ [x: string]: unknown }`, dropping the required `name`
   * and `namespace` from the spread below.
   */
  seedLease(namespace: string, lease: K8sLeaseObject): K8sLeaseObject {
    const stamped: K8sLeaseObject = {
      ...lease,
      metadata: { ...lease.metadata, resourceVersion: String(this.rvCounter++) },
    };
    this.leases.set(`${namespace}/${lease.metadata.name}`, stamped);
    return stamped;
  }

  /** Test helper — peek at the stored lease. */
  peek(namespace: string, name: string): K8sLeaseObject | undefined {
    return this.leases.get(`${namespace}/${name}`);
  }

  /** Test helper — yank a lease out from under any holder (simulates another operator's delete). */
  deleteForTest(namespace: string, name: string): void {
    this.leases.delete(`${namespace}/${name}`);
  }
}

/**
 * Stand-in for the Pod's ServiceAccount mount.
 *
 * The real mount lives at an absolute path under `/var/run` that no test may
 * create, so without this seam the entire in-cluster credential branch — the
 * one every production deployment takes — is exercised by nothing: every
 * other suite in this file supplies the explicit `apiServerUrl` + `authToken`
 * + `caCert` triple and never reaches it.
 *
 * `rotate()` models what the kubelet does: it rewrites the token file, which
 * both changes the bytes and moves the mtime.
 */
class FakeServiceAccountMount implements MountedCredentialLoader {
  token = 'mounted-token-1';
  modifiedAt: number | null = 1_000;
  /** How many times the mount was read whole, and how many times only stat'ed. */
  reads = 0;
  stats = 0;
  /** When set, the mount reads as absent — no token file, no CA cert. */
  absent = false;

  async read(): Promise<MountedCredentials | null> {
    this.reads++;
    if (this.absent) return null;
    return {
      credentials: {
        apiServerUrl: 'https://kubernetes.default.svc',
        authToken: this.token,
        caCert: '<<mounted-ca-cert>>',
        defaultNamespace: 'default',
      },
      tokenModifiedAt: this.modifiedAt,
    };
  }

  async tokenModifiedAt(): Promise<number | null> {
    this.stats++;
    return this.modifiedAt;
  }

  /** The kubelet rewrote the token file: new bytes, new mtime. */
  rotate(token: string): void {
    this.token = token;
    this.modifiedAt = (this.modifiedAt ?? 0) + 1_000;
  }
}

let server: FakeK8sServer;
beforeEach(() => { server = new FakeK8sServer(); });
afterEach(() => { /* nothing global */ });

const baseOptions = (overrides: Partial<KubernetesLeaseOptionsType> = {}): KubernetesLeaseOptions => {
  const s: KubernetesLeaseOptionsType = {
    name: 'test-lease',
    namespace: 'default',
    owner: 'test-pod',
    ttlMs: 5_000,
    renewalIntervalMs: 50,
    acquireRetries: 3,
    acquireRetryDelayMs: 5,
    ...TEST_CREDS,
    client: server,
    ...overrides,
  };
  const options = KubernetesLeaseOptions.create()
    .withName(s.name)
    .withNamespace(s.namespace)
    .withOwner(s.owner)
    .withTtlMs(s.ttlMs);
  if (s.renewalIntervalMs !== undefined) options.withRenewalIntervalMs(s.renewalIntervalMs);
  if (s.acquireRetries !== undefined) options.withAcquireRetries(s.acquireRetries);
  if (s.acquireRetryDelayMs !== undefined) options.withAcquireRetryDelayMs(s.acquireRetryDelayMs);
  if (s.apiServerUrl !== undefined) options.withApiServerUrl(s.apiServerUrl);
  if (s.authToken !== undefined) options.withAuthToken(s.authToken);
  if (s.caCert !== undefined) options.withCaCert(s.caCert);
  if (s.client !== undefined) options.withClient(s.client);
  return options;
};

/**
 * Options for the *other* credential source: no explicit triple, so the
 * lease reads `mount` the way a Pod reads its ServiceAccount volume.
 */
const inClusterOptions = (
  mount: FakeServiceAccountMount,
  overrides: Partial<Pick<KubernetesLeaseOptionsType,
    'owner' | 'ttlMs' | 'renewalIntervalMs' | 'tokenReloadIntervalMs'>> = {},
): KubernetesLeaseOptions => {
  const options = KubernetesLeaseOptions.create()
    .withName('test-lease')
    .withNamespace('default')
    .withOwner(overrides.owner ?? 'test-pod')
    .withTtlMs(overrides.ttlMs ?? 5_000)
    .withRenewalIntervalMs(overrides.renewalIntervalMs ?? 50)
    .withAcquireRetries(3)
    .withAcquireRetryDelayMs(5)
    .withClient(server)
    .withCredentialLoader(mount);
  if (overrides.tokenReloadIntervalMs !== undefined) {
    options.withTokenReloadIntervalMs(overrides.tokenReloadIntervalMs);
  }
  return options;
};

describe('KubernetesLease — required options (#596)', () => {
  /**
   * Each of these used to construct silently and then disable mutual
   * exclusion on the wire: no `owner` means no `spec.holderIdentity`
   * (JSON.stringify drops the undefined key), which `isStillHeldByOther`
   * reads as "unowned" for every Pod; no `ttlMs` makes the expiry `NaN`,
   * which is never greater than `Date.now()`.
   */
  test('rejects a missing owner instead of writing a lease without a holderIdentity', () => {
    const withoutOwner = KubernetesLeaseOptions.create()
      .withName('test-lease')
      .withNamespace('default')
      .withTtlMs(5_000);
    expect(() => new KubernetesLease(withoutOwner)).toThrow(OptionsError);
    expect(() => new KubernetesLease(withoutOwner)).toThrow(/owner is required/);
  });

  test('rejects a missing ttlMs', () => {
    const withoutTtl = KubernetesLeaseOptions.create()
      .withName('test-lease')
      .withNamespace('default')
      .withOwner('test-pod');
    expect(() => new KubernetesLease(withoutTtl)).toThrow(/ttlMs is required/);
  });

  test('rejects a missing name and a missing namespace', () => {
    const withoutName = KubernetesLeaseOptions.create()
      .withNamespace('default')
      .withOwner('test-pod')
      .withTtlMs(5_000);
    expect(() => new KubernetesLease(withoutName)).toThrow(/name is required/);

    const withoutNamespace = KubernetesLeaseOptions.create()
      .withName('test-lease')
      .withOwner('test-pod')
      .withTtlMs(5_000);
    expect(() => new KubernetesLease(withoutNamespace)).toThrow(/namespace is required/);
  });

  test('rejects an options-less construction', () => {
    expect(() => new KubernetesLease()).toThrow(OptionsError);
  });

  test('a plain options object is held to the same requirement as the builder', () => {
    expect(() => new KubernetesLease({ name: 'test-lease', namespace: 'default', ttlMs: 5_000 }))
      .toThrow(/owner is required/);
  });
});

describe('KubernetesLease — API-server credentials (#599)', () => {
  test('rejects an apiServerUrl without its token and CA cert', () => {
    // Accepting it meant the Pod's mounted ServiceAccount token was sent
    // to whatever host the caller named.
    const partialCredential = KubernetesLeaseOptions.create()
      .withName('test-lease')
      .withNamespace('default')
      .withOwner('test-pod')
      .withTtlMs(5_000)
      .withApiServerUrl('https://k8s.example.internal');
    expect(() => new KubernetesLease(partialCredential)).toThrow(OptionsError);
    expect(() => new KubernetesLease(partialCredential)).toThrow(/authToken \+ caCert/);
  });

  test('accepts the complete triple', () => {
    expect(() => new KubernetesLease(baseOptions())).not.toThrow();
  });
});

describe('KubernetesLease — acquire (no existing lease)', () => {
  test('creates the lease object and sets holderIdentity', async () => {
    const lease = new KubernetesLease(baseOptions());
    expect(await lease.acquire()).toBe(true);
    expect(lease.checkAlive()).toBe(true);
    const stored = server.peek('default', 'test-lease');
    expect(stored?.spec.holderIdentity).toBe('test-pod');
    expect(stored?.spec.leaseTransitions).toBe(1);
    await lease.release();
  });

  test('release deletes the lease object', async () => {
    const lease = new KubernetesLease(baseOptions());
    await lease.acquire();
    await lease.release();
    expect(lease.checkAlive()).toBe(false);
    expect(server.peek('default', 'test-lease')).toBeUndefined();
  });

  test('release rejects when the DELETE fails, and stops renewing anyway (#600)', async () => {
    // Swallowing the failure reported a clean release for a record still
    // claimed on the server — which is exactly the ambiguity
    // LeaseMajority's fail-safe exists for, and made it unreachable.
    const lease = new KubernetesLease(baseOptions({ renewalIntervalMs: 20 }));
    await lease.acquire();
    server.forceDeleteErrorNext = true;
    await expect(lease.release()).rejects.toThrow(/DELETE lease default\/test-lease/);
    expect(lease.checkAlive()).toBe(false);

    // The record is still there — that is the point of the rejection —
    // but this process must not keep renewing it.
    const stored = server.peek('default', 'test-lease');
    expect(stored).toBeDefined();
    const renewTimeAfterRelease = stored!.spec.renewTime;
    // The assertion is an absence: `renewTime` must be the same string four
    // 20 ms renewal ticks later.  A poll cannot express that — the condition
    // holds at t=0 and has to still hold afterwards.
    await sleep(80);
    expect(server.peek('default', 'test-lease')?.spec.renewTime).toBe(renewTimeAfterRelease);
  });

  test('release is a no-op when the lease was never held', async () => {
    const lease = new KubernetesLease(baseOptions());
    await lease.release();
    expect(server.log.filter((l) => l.method === 'DELETE')).toHaveLength(0);
  });
});

describe('KubernetesLease — contention with another holder', () => {
  test('refuses to take a lease that another live holder owns', async () => {
    server.seedLease('default', {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: { name: 'test-lease', namespace: 'default' },
      spec: {
        holderIdentity: 'other-pod',
        leaseDurationSeconds: 30,
        renewTime: new Date().toISOString(),
        leaseTransitions: 1,
      },
    });
    const lease = new KubernetesLease(baseOptions());
    expect(await lease.acquire()).toBe(false);
    expect(lease.checkAlive()).toBe(false);
  });

  test('takes over a lease whose previous holder has expired', async () => {
    const longAgo = new Date(Date.now() - 60_000).toISOString();
    server.seedLease('default', {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: { name: 'test-lease', namespace: 'default' },
      spec: {
        holderIdentity: 'dead-pod',
        leaseDurationSeconds: 5,
        renewTime: longAgo,
        leaseTransitions: 1,
      },
    });
    const lease = new KubernetesLease(baseOptions());
    expect(await lease.acquire()).toBe(true);
    const stored = server.peek('default', 'test-lease');
    expect(stored?.spec.holderIdentity).toBe('test-pod');
    expect(stored?.spec.leaseTransitions).toBe(2);  // bumped on takeover
    await lease.release();
  });
});

describe('KubernetesLease — hostile lease records (#598)', () => {
  /** Seed a lease held by `other-pod` with the given spec overrides. */
  const seedForeignLease = (spec: Partial<K8sLeaseObject['spec']>): void => {
    server.seedLease('default', {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: { name: 'test-lease', namespace: 'default' },
      spec: { holderIdentity: 'other-pod', leaseTransitions: 1, ...spec },
    });
  };

  test('a hostile leaseDurationSeconds cannot pin the lease past the local budget', async () => {
    // 68 years of "duration", renewed a minute ago.  Unbounded, this
    // reads as live until 2093; capped at 4 × our 5 s TTL it expired
    // 40 s ago.
    seedForeignLease({
      leaseDurationSeconds: 2_147_483_647,
      renewTime: new Date(Date.now() - 60_000).toISOString(),
    });
    const lease = new KubernetesLease(baseOptions());
    expect(await lease.acquire()).toBe(true);
    await lease.release();
  });

  test('a renewTime far in the future is not credible and does not wedge the lease', async () => {
    seedForeignLease({
      leaseDurationSeconds: 30,
      renewTime: new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000).toISOString(),
    });
    const lease = new KubernetesLease(baseOptions());
    expect(await lease.acquire()).toBe(true);
    await lease.release();
  });

  test('an unparseable renewTime reads as live, not as free for the taking', async () => {
    // `new Date('yesterday-ish').getTime()` is NaN, and `NaN > now` is
    // false — which used to hand the lease to whoever asked next.
    seedForeignLease({ leaseDurationSeconds: 30, renewTime: 'yesterday-ish' });
    const lease = new KubernetesLease(baseOptions());
    expect(await lease.acquire()).toBe(false);
  });

  test('a live holder configured with a larger ttl is not stolen', async () => {
    // The rolling-upgrade case that rules out clamping at exactly our own
    // TTL: the holder runs ttlMs 15 s, we still run 5 s, and it renewed
    // 10 s ago.  A `Math.min(remote, ours)` clamp would call it expired
    // and take a live lease.
    seedForeignLease({
      leaseDurationSeconds: 15,
      renewTime: new Date(Date.now() - 10_000).toISOString(),
    });
    const lease = new KubernetesLease(baseOptions());
    expect(await lease.acquire()).toBe(false);
  });

  test('a negative leaseDurationSeconds falls back to the local ttl', async () => {
    seedForeignLease({
      leaseDurationSeconds: -1,
      renewTime: new Date(Date.now() - 1_000).toISOString(),
    });
    const lease = new KubernetesLease(baseOptions());
    expect(await lease.acquire()).toBe(false);   // 1 s ago + our 5 s TTL → still live
  });
});

describe('KubernetesLease — race / retry', () => {
  test('CREATE 409 retries up to acquireRetries', async () => {
    server.forceConflictNext = true;  // first POST will 409
    const lease = new KubernetesLease(baseOptions({ acquireRetries: 3 }));
    expect(await lease.acquire()).toBe(true);
    // Second POST attempt found "no existing lease" again, succeeded.
    const posts = server.log.filter((l) => l.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(2);
    await lease.release();
  });

  test('exhausting retries returns false', async () => {
    server.seedLease('default', {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: { name: 'test-lease', namespace: 'default' },
      spec: {
        holderIdentity: 'other-pod',
        leaseDurationSeconds: 30,
        renewTime: new Date().toISOString(),
        leaseTransitions: 1,
      },
    });
    const lease = new KubernetesLease(baseOptions({ acquireRetries: 2 }));
    expect(await lease.acquire()).toBe(false);
  });
});

describe('KubernetesLease — renewal loop', () => {
  test('renewal updates renewTime regularly', async () => {
    const lease = new KubernetesLease(baseOptions({ renewalIntervalMs: 30 }));
    await lease.acquire();
    const t1 = server.peek('default', 'test-lease')!.spec.renewTime!;
    // Poll the record the assertion below reads, not the interval it was
    // configured with: the renewal is a PUT to the fake API server, so the
    // stored `renewTime` is the only thing that proves a tick landed.
    await awaitCondition(
      () => new Date(server.peek('default', 'test-lease')!.spec.renewTime!).getTime()
        > new Date(t1).getTime(),
      { label: 'the renewal loop wrote a newer renewTime' },
    );
    const t2 = server.peek('default', 'test-lease')!.spec.renewTime!;
    expect(new Date(t2).getTime()).toBeGreaterThan(new Date(t1).getTime());
    await lease.release();
  });

  test('renewal 409 whose re-read shows a foreign holder fires onLost(reason) and stops the loop', async () => {
    const lease = new KubernetesLease(baseOptions({ renewalIntervalMs: 30 }));
    let lostReason: string | null = null;
    lease.onLost((reason) => { lostReason = reason; });
    await lease.acquire();
    // A real takeover, not a forced status: another pod rewrites the record,
    // which both moves the `resourceVersion` (so our next PUT is rejected)
    // and changes `holderIdentity` (so the re-read confirms the loss).
    // Forcing a bare 409 no longer proves anything here — since #761 that is
    // also what a holder conflicting with its own write looks like, and the
    // re-read would find this owner still on the record.
    server.seedLease('default', {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: { name: 'test-lease', namespace: 'default' },
      spec: {
        holderIdentity: 'other-pod',
        leaseDurationSeconds: 5,
        acquireTime: new Date().toISOString(),
        renewTime: new Date().toISOString(),
        leaseTransitions: 2,
      },
    });
    // `fireLost` clears `held` before it calls the handlers, so a non-null
    // reason already implies the `checkAlive()` assertion below.
    await awaitCondition(() => lostReason !== null, {
      label: 'the renewal 409 against a foreign holder fired onLost',
    });
    // Written only by the `onLost` callback, so flow analysis still has
    // `lostReason` at its `null` initialiser here.
    expect<string | null>(lostReason).toContain('lease lost');
    expect<string | null>(lostReason).toContain('other-pod');
    expect(lease.checkAlive()).toBe(false);
    await lease.release();
  });

  test('a renewal tick that finds one already on the wire is skipped, not sent (#761)', async () => {
    const lease = new KubernetesLease(baseOptions({ renewalIntervalMs: 20 }));
    let lostReason: string | null = null;
    lease.onLost((reason) => { lostReason = reason; });
    await lease.acquire();

    // Model the API-server latency spike the issue is about: the first
    // renewal PUT is held open, and the ticks that fire meanwhile would each
    // build their write from the same `currentLease` snapshot and carry the
    // same stale `resourceVersion`.
    server.blockPuts();
    await awaitCondition(() => server.parkedPuts() === 1, {
      label: 'the first renewal PUT reached the API server',
    });
    // The assertion is an absence — no second PUT — so the wait has to
    // outlive several of the 20 ms ticks that would have produced one.
    await sleep(100);
    expect(server.maxConcurrentPuts).toBe(1);
    expect(server.parkedPuts()).toBe(1);

    // The stalled request finally lands.  It is the *only* one, so it CASes
    // cleanly, nothing 409s, and no ownership was ever in question.
    server.unblockPuts();
    const afterUnblock = server.peek('default', 'test-lease')!.metadata.resourceVersion;
    await awaitCondition(
      () => server.peek('default', 'test-lease')!.metadata.resourceVersion !== afterUnblock,
      { label: 'the renewal loop resumed once the stalled PUT settled' },
    );
    expect<string | null>(lostReason).toBeNull();
    expect(lease.checkAlive()).toBe(true);
    await lease.release();
  });

  test('a 409 whose re-read still names this owner keeps the lease held (#761)', async () => {
    const lease = new KubernetesLease(baseOptions({ renewalIntervalMs: 20 }));
    let lostReason: string | null = null;
    lease.onLost((reason) => { lostReason = reason; });
    await lease.acquire();

    // The tail of a self-conflict, whatever produced it: the server's
    // version moved while `holderIdentity` did not, so the next tick's CAS
    // is rejected by this holder's own earlier write.  Concluding "lost"
    // from the 409 alone stops a singleton whose lease is still on the
    // record — and, since the record names this pod with a fresh
    // `renewTime`, no other pod may take it over either.
    const bumped = server.bumpResourceVersion('default', 'test-lease');
    await awaitCondition(
      () => server.peek('default', 'test-lease')!.metadata.resourceVersion !== bumped,
      { label: 'the renewal loop adopted the new resourceVersion and wrote again' },
    );
    expect<string | null>(lostReason).toBeNull();
    expect(lease.checkAlive()).toBe(true);
    expect(server.peek('default', 'test-lease')!.spec.holderIdentity).toBe('test-pod');
    await lease.release();
  });

  test('renewal 404 (lease deleted out from under us) fires onLost', async () => {
    const lease = new KubernetesLease(baseOptions({ renewalIntervalMs: 30 }));
    let lostReason: string | null = null;
    lease.onLost((reason) => { lostReason = reason; });
    await lease.acquire();
    // Simulate "another operator deleted the lease object" — the
    // backing server forgets it.  The next renewal-loop tick sends a
    // PUT and gets a 404, which is mapped to lease-lost.
    server.deleteForTest('default', 'test-lease');
    await awaitCondition(() => lostReason !== null, {
      label: 'the renewal 404 fired onLost',
    });
    expect<string | null>(lostReason).toContain('deleted');
    expect(lease.checkAlive()).toBe(false);
    await lease.release();
  });

  test('onLost handler can be unregistered', async () => {
    const lease = new KubernetesLease(baseOptions({ renewalIntervalMs: 30 }));
    let calls = 0;
    const unregister = lease.onLost(() => { calls++; });
    await lease.acquire();
    unregister();
    // Deleting the object rather than forcing a 409: since #761 a bare 409
    // is re-read and found to be this holder's own, so it fires nothing at
    // all — which would leave this case passing for the wrong reason.
    server.deleteForTest('default', 'test-lease');
    // The assertion is an absence: the unregistered handler must never fire, so
    // the wait has to outlive the 30 ms renewal tick that would have called it.
    await sleep(80);
    expect(calls).toBe(0);
    expect(lease.checkAlive()).toBe(false);
    await lease.release();
  });
});

describe('KubernetesLease — credential freshness (#760)', () => {
  /**
   * The credential used to be memoised for the process lifetime, both
   * sources alike, with no re-read and no invalidation on an auth failure.
   * A projected ServiceAccount token is time-bound, so the first rejection
   * was terminal: `onLost` fired, `ClusterSingletonManager` re-acquired on
   * the same lease instance every 5 s, and every attempt replayed the same
   * dead bearer token until the pod was restarted.
   */

  test('a 401 during renewal re-reads the mounted token and retries once', async () => {
    const mount = new FakeServiceAccountMount();
    const leaseOptions = inClusterOptions(mount, { renewalIntervalMs: 30 });
    const lease = new KubernetesLease(leaseOptions);
    let lostReason: string | null = null;
    lease.onLost((reason) => { lostReason = reason; });
    expect(await lease.acquire()).toBe(true);

    // The token this process cached at acquire time expires; the kubelet has
    // already written its replacement to the mount.
    server.rejectedTokens.add('mounted-token-1');
    mount.rotate('mounted-token-2');

    await awaitCondition(
      () => server.log.some((entry) => entry.authToken === 'mounted-token-2'),
      { label: 'the renewal retried against the rotated token' },
    );
    // The retry succeeded, so nothing was lost — the singleton above never
    // even learns that the credential turned over.
    expect<string | null>(lostReason).toBeNull();
    expect(lease.checkAlive()).toBe(true);
    await lease.release();
  });

  test('a 401 that survives the re-read is reported as lease loss, after exactly one retry', async () => {
    const mount = new FakeServiceAccountMount();
    const leaseOptions = inClusterOptions(mount, { renewalIntervalMs: 30 });
    const lease = new KubernetesLease(leaseOptions);
    let lostReason: string | null = null;
    lease.onLost((reason) => { lostReason = reason; });
    await lease.acquire();

    // Both copies are refused — a revocation, not an expiry.  A re-read
    // cannot help, and the retry must not become a loop.
    server.rejectedTokens.add('mounted-token-1');
    server.rejectedTokens.add('mounted-token-2');
    mount.rotate('mounted-token-2');

    await awaitCondition(() => lostReason !== null, {
      label: 'the twice-rejected credential fired onLost',
    });
    expect<string | null>(lostReason).toContain('401');
    expect(lease.checkAlive()).toBe(false);
    // Acquire is a GET + POST, so every PUT here belongs to the one renewal
    // tick: the original attempt and its single retry.
    expect(server.log.filter((entry) => entry.method === 'PUT')).toHaveLength(2);
  });

  test('a 401 against an explicitly supplied token is not retried', async () => {
    // There is no second copy of a caller-supplied token to read, so
    // re-sending it would only double the traffic on a failing path — and,
    // wired to a re-acquire loop, spin.
    const lease = new KubernetesLease(baseOptions({ renewalIntervalMs: 30 }));
    let lostReason: string | null = null;
    lease.onLost((reason) => { lostReason = reason; });
    await lease.acquire();
    server.rejectedTokens.add('test-token');

    await awaitCondition(() => lostReason !== null, {
      label: 'the 401 against the static token fired onLost',
    });
    expect<string | null>(lostReason).toContain('401');
    expect(server.log.filter((entry) => entry.method === 'PUT')).toHaveLength(1);
  });

  test('after the reload interval the rotated mounted token is what the next request sends', async () => {
    const mount = new FakeServiceAccountMount();
    const leaseOptions = inClusterOptions(mount, {
      renewalIntervalMs: 20,
      tokenReloadIntervalMs: 40,
    });
    const lease = new KubernetesLease(leaseOptions);
    await lease.acquire();
    expect(server.log.every((entry) => entry.authToken === 'mounted-token-1')).toBe(true);

    // No 401 anywhere: the API server keeps accepting the old token.  The
    // re-read has to happen because the interval elapsed and the file moved,
    // not because a request failed.
    mount.rotate('mounted-token-2');
    await awaitCondition(
      () => server.log.some((entry) => entry.authToken === 'mounted-token-2'),
      { label: 'the reload interval picked up the rotated mounted token' },
    );
    await lease.release();
  });

  test('an unchanged token file is revalidated by mtime instead of re-read', async () => {
    const mount = new FakeServiceAccountMount();
    const leaseOptions = inClusterOptions(mount, {
      renewalIntervalMs: 20,
      tokenReloadIntervalMs: 30,
    });
    const lease = new KubernetesLease(leaseOptions);
    await lease.acquire();
    const readsAfterAcquire = mount.reads;

    // What makes a one-minute interval affordable in production: the steady
    // state is a stat, not three file reads.
    await awaitCondition(() => mount.stats >= 2, {
      label: 'the reload interval stat-ed the token file twice',
    });
    expect(mount.reads).toBe(readsAfterAcquire);
    await lease.release();
  });

  test('a lease lost to a rejected token re-acquires against a freshly read one', async () => {
    // The `ClusterSingletonManager` recovery path end to end: it re-acquires
    // on the SAME lease instance, so a credential the API server has already
    // refused must not survive as the memo the next attempt starts from.
    const mount = new FakeServiceAccountMount();
    const leaseOptions = inClusterOptions(mount, { renewalIntervalMs: 30 });
    const lease = new KubernetesLease(leaseOptions);
    let lostReason: string | null = null;
    lease.onLost((reason) => { lostReason = reason; });
    await lease.acquire();

    server.rejectedTokens.add('mounted-token-1');
    server.rejectedTokens.add('mounted-token-2');
    mount.rotate('mounted-token-2');
    await awaitCondition(() => lostReason !== null, { label: 'the lease was lost' });

    // A third token lands on the mount.  The re-acquire must reach for it on
    // its FIRST request — an expired token does not become valid again, so a
    // retry that merely recovers from another 401 is not the same thing.
    const requestsBeforeReAcquire = server.log.length;
    mount.rotate('mounted-token-3');
    expect(await lease.acquire()).toBe(true);

    const reAcquireRequests = server.log.slice(requestsBeforeReAcquire);
    expect(reAcquireRequests.length).toBeGreaterThan(0);
    expect(reAcquireRequests.every((entry) => entry.authToken === 'mounted-token-3')).toBe(true);
    await lease.release();
  });

  test('an absent ServiceAccount mount is still reported, not retried into', async () => {
    const mount = new FakeServiceAccountMount();
    mount.absent = true;
    const leaseOptions = inClusterOptions(mount);
    const lease = new KubernetesLease(leaseOptions);
    await expect(lease.acquire()).rejects.toThrow(/no credentials available/);
  });
});

describe('KubernetesLease — multi-process arbitration', () => {
  test('two leases against the same key — only one wins', async () => {
    const leaseA = new KubernetesLease(baseOptions({ owner: 'pod-A' }));
    const leaseB = new KubernetesLease(baseOptions({ owner: 'pod-B' }));
    const [aOk, bOk] = await Promise.all([leaseA.acquire(), leaseB.acquire()]);
    expect(aOk !== bOk).toBe(true);  // exactly one is true
    await leaseA.release();
    await leaseB.release();
  });

  test('after release, the other holder can acquire', async () => {
    const leaseA = new KubernetesLease(baseOptions({ owner: 'pod-A' }));
    const leaseB = new KubernetesLease(baseOptions({ owner: 'pod-B' }));
    expect(await leaseA.acquire()).toBe(true);
    await leaseA.release();
    expect(await leaseB.acquire()).toBe(true);
    expect(server.peek('default', 'test-lease')?.spec.holderIdentity).toBe('pod-B');
    await leaseB.release();
  });
});

/* ------------- live integration test (env-gated against k3d/kind) -------- */

const liveK8s = process.env.K8S_LEASE_LIVE === '1';
const describeMaybe = liveK8s ? describe : describe.skip;

describeMaybe('KubernetesLease — live integration (set K8S_LEASE_LIVE=1)', () => {
  test('acquire + renew + release against a real cluster', async () => {
    const apiServerUrl = process.env.K8S_API_URL ?? 'https://kubernetes.default.svc';
    const authToken = process.env.K8S_TOKEN;
    const caCert = process.env.K8S_CA_CERT;
    if (!authToken || !caCert) {
      throw new Error('K8S_LEASE_LIVE requires K8S_TOKEN + K8S_CA_CERT env vars');
    }
    const k8sLeaseOptions = KubernetesLeaseOptions.create()
      .withName('actor-ts-live-test')
      .withNamespace('default')
      .withOwner('live-runner')
      .withTtlMs(5_000)
      .withRenewalIntervalMs(1_000)
      .withApiServerUrl(apiServerUrl)
      .withAuthToken(authToken)
      .withCaCert(caCert);
    const lease = new KubernetesLease(
      k8sLeaseOptions,
    );
    expect(await lease.acquire()).toBe(true);
    // The elapsed time IS the assertion: `checkAlive()` is already true here,
    // so what is under test is that it is still true after half the 5 s TTL —
    // i.e. that the 1 s renewal loop reached a real API server twice.
    await sleep(2_500);
    expect(lease.checkAlive()).toBe(true);
    await lease.release();
  });
});
