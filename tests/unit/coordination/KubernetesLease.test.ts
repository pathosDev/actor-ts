import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { KubernetesLease, type KubernetesLeaseSettings } from '../../../src/coordination/leases/KubernetesLease.js';
import { KubernetesLeaseOptions } from '../../../src/coordination/leases/KubernetesLeaseOptions.js';
import type {
  K8sCredentials,
  K8sFetchClient,
  K8sLeaseObject,
  K8sRequestOptions,
  K8sResponse,
} from '../../../src/coordination/leases/k8sApi.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

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
 * forceMissingNext) so tests can drive the failure paths without timing
 * tricks.
 */
class FakeK8sServer implements K8sFetchClient {
  private leases = new Map<string, K8sLeaseObject>();
  private rvCounter = 1;
  /** When set, the next mutating op (PUT / POST / DELETE) returns 409. */
  forceConflictNext = false;
  /** When set, the next GET pretends the lease is missing. */
  forceMissingNext = false;
  /** Capture every request for assertion. */
  log: Array<{ method: string; path: string; body?: unknown }> = [];

  async request(_creds: K8sCredentials, opts: K8sRequestOptions): Promise<K8sResponse> {
    this.log.push({ method: opts.method, path: opts.path, body: opts.body });
    const m = opts.path.match(/^\/apis\/coordination\.k8s\.io\/v1\/namespaces\/([^/]+)\/leases(?:\/([^/]+))?$/);
    if (!m) return { status: 404, body: null };
    const ns = decodeURIComponent(m[1]!);
    const name = m[2] ? decodeURIComponent(m[2]) : null;

    if (opts.method === 'GET') {
      if (!name) return { status: 200, body: { kind: 'LeaseList', items: [] } };
      if (this.forceMissingNext) {
        this.forceMissingNext = false;
        return { status: 404, body: { code: 404, reason: 'NotFound' } };
      }
      const found = this.leases.get(`${ns}/${name}`);
      if (!found) return { status: 404, body: { code: 404, reason: 'NotFound' } };
      return { status: 200, body: found };
    }

    if (opts.method === 'POST' && !name) {
      const lease = opts.body as K8sLeaseObject;
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

    if (opts.method === 'PUT' && name) {
      const incoming = opts.body as K8sLeaseObject;
      const key = `${ns}/${name}`;
      if (this.forceConflictNext) {
        this.forceConflictNext = false;
        return { status: 409, body: { code: 409, reason: 'Conflict' } };
      }
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
    }

    if (opts.method === 'DELETE' && name) {
      const key = `${ns}/${name}`;
      const existed = this.leases.delete(key);
      if (!existed) return { status: 404, body: { code: 404 } };
      return { status: 200, body: { kind: 'Status', status: 'Success' } };
    }

    return { status: 405, body: { code: 405 } };
  }

  /** Test helper — directly insert a lease as if another holder had created it. */
  seedLease(namespace: string, lease: Omit<K8sLeaseObject, 'metadata'> & { metadata: Omit<K8sLeaseObject['metadata'], 'resourceVersion'> }): K8sLeaseObject {
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

let server: FakeK8sServer;
beforeEach(() => { server = new FakeK8sServer(); });
afterEach(() => { /* nothing global */ });

const baseSettings = (overrides: Partial<KubernetesLeaseSettings> = {}): KubernetesLeaseOptions => {
  const s: KubernetesLeaseSettings = {
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
  const o = KubernetesLeaseOptions.create()
    .withName(s.name)
    .withNamespace(s.namespace)
    .withOwner(s.owner)
    .withTtlMs(s.ttlMs);
  if (s.renewalIntervalMs !== undefined) o.withRenewalIntervalMs(s.renewalIntervalMs);
  if (s.acquireRetries !== undefined) o.withAcquireRetries(s.acquireRetries);
  if (s.acquireRetryDelayMs !== undefined) o.withAcquireRetryDelayMs(s.acquireRetryDelayMs);
  if (s.apiServerUrl !== undefined) o.withApiServerUrl(s.apiServerUrl);
  if (s.authToken !== undefined) o.withAuthToken(s.authToken);
  if (s.caCert !== undefined) o.withCaCert(s.caCert);
  if (s.client !== undefined) o.withClient(s.client);
  return o;
};

describe('KubernetesLease — acquire (no existing lease)', () => {
  test('creates the lease object and sets holderIdentity', async () => {
    const lease = new KubernetesLease(baseSettings());
    expect(await lease.acquire()).toBe(true);
    expect(lease.checkAlive()).toBe(true);
    const stored = server.peek('default', 'test-lease');
    expect(stored?.spec.holderIdentity).toBe('test-pod');
    expect(stored?.spec.leaseTransitions).toBe(1);
    await lease.release();
  });

  test('release deletes the lease object', async () => {
    const lease = new KubernetesLease(baseSettings());
    await lease.acquire();
    await lease.release();
    expect(lease.checkAlive()).toBe(false);
    expect(server.peek('default', 'test-lease')).toBeUndefined();
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
    const lease = new KubernetesLease(baseSettings());
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
    const lease = new KubernetesLease(baseSettings());
    expect(await lease.acquire()).toBe(true);
    const stored = server.peek('default', 'test-lease');
    expect(stored?.spec.holderIdentity).toBe('test-pod');
    expect(stored?.spec.leaseTransitions).toBe(2);  // bumped on takeover
    await lease.release();
  });
});

describe('KubernetesLease — race / retry', () => {
  test('CREATE 409 retries up to acquireRetries', async () => {
    server.forceConflictNext = true;  // first POST will 409
    const lease = new KubernetesLease(baseSettings({ acquireRetries: 3 }));
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
    const lease = new KubernetesLease(baseSettings({ acquireRetries: 2 }));
    expect(await lease.acquire()).toBe(false);
  });
});

describe('KubernetesLease — renewal loop', () => {
  test('renewal updates renewTime regularly', async () => {
    const lease = new KubernetesLease(baseSettings({ renewalIntervalMs: 30 }));
    await lease.acquire();
    const t1 = server.peek('default', 'test-lease')!.spec.renewTime!;
    await sleep(120);
    const t2 = server.peek('default', 'test-lease')!.spec.renewTime!;
    expect(new Date(t2).getTime()).toBeGreaterThan(new Date(t1).getTime());
    await lease.release();
  });

  test('renewal 409 fires onLost(reason) and stops the loop', async () => {
    const lease = new KubernetesLease(baseSettings({ renewalIntervalMs: 30 }));
    let lostReason: string | null = null;
    lease.onLost((reason) => { lostReason = reason; });
    await lease.acquire();
    server.forceConflictNext = true;
    await sleep(80);
    expect(lostReason).toContain('lease lost');
    expect(lease.checkAlive()).toBe(false);
    await lease.release();
  });

  test('renewal 404 (lease deleted out from under us) fires onLost', async () => {
    const lease = new KubernetesLease(baseSettings({ renewalIntervalMs: 30 }));
    let lostReason: string | null = null;
    lease.onLost((reason) => { lostReason = reason; });
    await lease.acquire();
    // Simulate "another operator deleted the lease object" — the
    // backing server forgets it.  The next renewal-loop tick sends a
    // PUT and gets a 404, which is mapped to lease-lost.
    server.deleteForTest('default', 'test-lease');
    await sleep(80);
    expect(lostReason).not.toBeNull();
    expect(lease.checkAlive()).toBe(false);
    await lease.release();
  });

  test('onLost handler can be unregistered', async () => {
    const lease = new KubernetesLease(baseSettings({ renewalIntervalMs: 30 }));
    let calls = 0;
    const unregister = lease.onLost(() => { calls++; });
    await lease.acquire();
    unregister();
    server.forceConflictNext = true;
    await sleep(80);
    expect(calls).toBe(0);
    await lease.release();
  });
});

describe('KubernetesLease — multi-process arbitration', () => {
  test('two leases against the same key — only one wins', async () => {
    const a = new KubernetesLease(baseSettings({ owner: 'pod-A' }));
    const b = new KubernetesLease(baseSettings({ owner: 'pod-B' }));
    const [aOk, bOk] = await Promise.all([a.acquire(), b.acquire()]);
    expect(aOk !== bOk).toBe(true);  // exactly one is true
    await a.release();
    await b.release();
  });

  test('after release, the other holder can acquire', async () => {
    const a = new KubernetesLease(baseSettings({ owner: 'pod-A' }));
    const b = new KubernetesLease(baseSettings({ owner: 'pod-B' }));
    expect(await a.acquire()).toBe(true);
    await a.release();
    expect(await b.acquire()).toBe(true);
    expect(server.peek('default', 'test-lease')?.spec.holderIdentity).toBe('pod-B');
    await b.release();
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
    await sleep(2_500);
    expect(lease.checkAlive()).toBe(true);
    await lease.release();
  });
});
