import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import {
  CLUSTER_MEMBERSHIP_CHECK_NAME,
  CLUSTER_TRANSPORT_CHECK_NAME,
} from '../../../src/cluster/ClusterHealthChecks.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { Config } from '../../../src/config/Config.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { BearerTokenAuth } from '../../../src/http/middleware/BearerToken.js';
import { IpAllowlist } from '../../../src/http/middleware/IpAllowlist.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  ACTOR_SYSTEM_LIVENESS_CHECK_NAME,
  HealthCheckRegistry,
  HealthCheckRegistryOptions,
  healthChecksOf,
  isHealthy,
  managementRoutes,
} from '../../../src/management/index.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import {
  DefaultMetricsRegistry,
  type Counter,
  type CounterOptions,
  type Gauge,
  type GaugeOptions,
  type Histogram,
  type HistogramOptions,
  type Labels,
  type MetricSample,
  type MetricsRegistry,
} from '../../../src/metrics/Metrics.js';

/**
 * A registry whose writes go to a collector this process cannot read back —
 * the shape `promClientRegistry` has (#744).  It still has to *work*, since
 * installing it starts the mailbox-depth sampler against it; only `collect()`
 * is blind.  The reader-side behaviour lives in
 * `tests/unit/metrics/NonCollectableRegistry.test.ts`; here it exists only to
 * make the management route face one.
 */
class WriteThroughRegistry implements MetricsRegistry {
  readonly collectable = false;
  private readonly foreign = new DefaultMetricsRegistry();

  counter(name: string, labels?: Labels, options?: CounterOptions): Counter {
    return this.foreign.counter(name, labels, options);
  }
  gauge(name: string, labels?: Labels, options?: GaugeOptions): Gauge {
    return this.foreign.gauge(name, labels, options);
  }
  histogram(name: string, labels?: Labels, options?: HistogramOptions): Histogram {
    return this.foreign.histogram(name, labels, options);
  }
  collect(): ReadonlyArray<MetricSample> { return []; }
  remove(name: string, labels?: Labels): boolean { return this.foreign.remove(name, labels); }
  clear(): void { this.foreign.clear(); }
}

describe('HealthCheckRegistry', () => {
  test('aggregates liveness + readiness separately', async () => {
    const reg = new HealthCheckRegistry();
    reg.addLiveness(async () => ({ name: 'core', status: true }));
    reg.addReadiness(async () => ({ name: 'db', status: false, detail: 'down' }));
    reg.addReadiness(() => ({ name: 'cache', status: true }));

    const liveness = await reg.checkLiveness();
    const readiness = await reg.checkReadiness();
    expect(liveness).toHaveLength(1);
    expect(isHealthy(liveness)).toBe(true);
    expect(readiness).toHaveLength(2);
    expect(isHealthy(readiness)).toBe(false);
  });

  test('exceptions from a check are reported as unhealthy', async () => {
    const reg = new HealthCheckRegistry();
    reg.addLiveness(() => { throw new Error('bad'); });
    const results = await reg.checkLiveness();
    expect(results[0]!.status).toBe(false);
    expect(results[0]!.detail).toContain('bad');
  });

  /**
   * The per-check deadline (#467, folded into #882).
   *
   * A probe aggregates every check into one response, so before this a single
   * check that never settled was a probe that never answered — which an
   * orchestrator reads as a failed probe carrying no information about which
   * dependency caused it.  The deadline turns that into one failing entry.
   */
  test('a check that never settles is answered for, and its siblings still report', async () => {
    const reg = new HealthCheckRegistry({ checkTimeoutMs: 30 });
    reg.addReadiness(() => new Promise<never>(() => { /* never settles */ }));
    reg.addReadiness(() => ({ name: 'cache', status: true }));

    const results = await reg.checkReadiness();
    expect(results).toHaveLength(2);
    // A timed-out check has no name: the name lives inside the result the
    // check never returned, so the registry answers with the same 'unknown'
    // the throw path uses and puts the deadline in the detail.
    expect(results[0]).toEqual({
      name: 'unknown',
      status: false,
      detail: 'health check did not answer within 30ms',
    });
    expect(results[1]).toEqual({ name: 'cache', status: true });
    expect(isHealthy(results)).toBe(false);
  });

  test('the deadline covers liveness too, not only readiness', async () => {
    // Built from the fluent builder rather than a plain object, because the
    // two are meant to be interchangeable and only one of them is exercised
    // everywhere else in this file.
    const registryOptions = HealthCheckRegistryOptions.create().withCheckTimeoutMs(30);
    const reg = new HealthCheckRegistry(registryOptions);
    reg.addLiveness(() => new Promise<never>(() => { /* never settles */ }));
    const results = await reg.checkLiveness();
    expect(results[0]!.status).toBe(false);
    expect(results[0]!.detail).toContain('30ms');
  });

  test('a check that answers inside the deadline is untouched by it', async () => {
    const reg = new HealthCheckRegistry({ checkTimeoutMs: 5_000 });
    reg.addReadiness(async () => ({ name: 'db', status: true, detail: 'fast' }));
    expect(await reg.checkReadiness()).toEqual([{ name: 'db', status: true, detail: 'fast' }]);
  });

  test('the registry validates its own options', () => {
    expect(() => new HealthCheckRegistry({ checkTimeoutMs: 0 })).toThrow(OptionsError);
    expect(() => new HealthCheckRegistry()).not.toThrow();
  });

  test('the per-system registry takes its deadline from the config block', () => {
    // The wiring the block exists for: `healthChecksOf` reaches the registry
    // through the extension factory, which is the one construction site with
    // an ActorSystem — and therefore a `system.config` — in scope.
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(Config.parseString('actor-ts.management.health-checks.check-timeout = 40ms'));
    const system = ActorSystem.create('health-timeout', systemOptions);
    const registry = healthChecksOf(system);
    registry.addReadiness(() => new Promise<never>(() => { /* never settles */ }));

    return registry.checkReadiness().then(async (results) => {
      expect(results[0]!.detail).toBe('health check did not answer within 40ms');
      await system.terminate();
    });
  });
});

describe('managementRoutes — cluster queries', () => {
  async function startNode(): Promise<{ sys: ActorSystem; cluster: Cluster; port: number }> {
    const port = 55200 + Math.floor(Math.random() * 300);
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('mgmt', sysOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      .withTransport(new InMemoryTransport(new NodeAddress('mgmt', 'h', port)))
      .withGossipIntervalMs(80);
    const cluster = await Cluster.join(
      sys,
      clusterOptions,
    );
    return { sys, cluster, port };
  }

  test('/cluster/members returns the current membership as JSON', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster);
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/cluster/members`);
    const body = await response.json() as { members: Array<{ address: string }>; self: string };
    expect(response.status).toBe(200);
    expect(body.members.length).toBe(1);
    expect(body.self).toContain('mgmt@h:');

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/health is 200 when all liveness checks pass', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster);
    healthChecksOf(sys).addLiveness(() => ({ name: 'ok', status: true }));
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/health`);
    const body = await response.json() as { status: string };
    expect(response.status).toBe(200);
    expect(body.status).toBe('UP');

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/health is 503 when a liveness check fails', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster);
    healthChecksOf(sys).addLiveness(() => ({ name: 'database', status: false, detail: 'connection refused' }));
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/health`);
    expect(response.status).toBe(503);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  // The endpoint no longer computes membership itself — `Cluster._start`
  // registers that check, and `clusterReady` is read back off the aggregate
  // (#655).  Asserting both here is what pins the two together: a future
  // change that recomputes the field in the handler would keep
  // `clusterReady` true while the check it is supposed to mirror is absent.
  test('/ready reports the framework readiness checks and mirrors membership in clusterReady', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster);
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    // Wait until self member is Up.
    await Bun.sleep(150);

    const response = await fetch(`http://127.0.0.1:${binding.port}/ready`);
    const body = await response.json() as {
      status: string;
      clusterReady: boolean;
      checks: Array<{ name: string; status: boolean }>;
    };
    expect(body.checks.map((c) => c.name).sort())
      .toEqual([CLUSTER_MEMBERSHIP_CHECK_NAME, CLUSTER_TRANSPORT_CHECK_NAME].sort());
    expect(body.checks.every((c) => c.status)).toBe(true);
    expect(body.clusterReady).toBe(true);
    expect(body.status).toBe('UP');
    expect(response.status).toBe(200);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  // Liveness must not grow a cluster dependency: the same node that is
  // `/ready` above is `/health` UP purely on "the actor system is running",
  // and that is the entire framework-owned liveness list.
  test('/health carries exactly the framework liveness check', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster);
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/health`);
    const body = await response.json() as {
      status: string;
      checks: Array<{ name: string; status: boolean }>;
    };
    expect(body.checks.map((c) => c.name)).toEqual([ACTOR_SYSTEM_LIVENESS_CHECK_NAME]);
    expect(body.status).toBe('UP');
    expect(response.status).toBe(200);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/cluster/leave triggers cluster.leave when enabled', async () => {
    const { sys, cluster, port } = await startNode();
    void port;
    const routes = managementRoutes(sys, cluster, { enableLeaveEndpoint: true });
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/cluster/leave`, { method: 'POST' });
    expect(response.status).toBe(202);
    // `leave` is answered 202 before it has been applied, and what follows is a
    // disjunction over three acceptable end states (gone, 'leaving', 'removed'),
    // so there is no single condition to poll for.
    await Bun.sleep(100);
    // After leave, the cluster's started flag is cleared — getMembers() may still show self in 'leaving'.
    const members = cluster.getMembers();
    const self = members.find(m => m.address.equals(cluster.selfAddress));
    expect(self == null || self.status === 'leaving' || self.status === 'removed').toBe(true);

    await binding.unbind();
    await sys.terminate();
  });

  test('/cluster/down 404s for unknown address (endpoint enabled)', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster, { enableDownEndpoint: true });
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/cluster/down`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'mgmt@h:99999' }),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('no member');

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/cluster/down rejects body without address field', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster, { enableDownEndpoint: true });
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/cluster/down`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wrongField: 'mgmt@h:1' }),
    });
    expect(response.status).toBe(400);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/cluster/down is 404 when endpoint is disabled', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster);   // defaults — disabled
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/cluster/down`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'mgmt@h:1' }),
    });
    expect(response.status).toBe(404);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/cluster/shards 400s without `type` query parameter', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster);
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/cluster/shards`);
    expect(response.status).toBe(400);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/cluster/shards 404s for a type this node has no region for', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster);
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/cluster/shards?type=Orders`);
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain('Orders');
    // The 404 used to be a DistributedData precondition, and it fired on every
    // default configuration — nothing in `src/` starts that extension, so a
    // 200 was unreachable out of the box (#682).  The route reads
    // `ClusterSharding.shardMap()` now, and the only precondition left is
    // participating in the type, so naming DD here would mean the old data
    // source is back.  See
    // `tests/integration/in-process/cluster/sharding/ShardMapEndpoint.test.ts`
    // for the 200 this makes reachable.
    expect(body).not.toContain('DistributedData');

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/metrics returns Prometheus text format when enabled', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster, { enableMetricsEndpoint: true });
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')?.toLowerCase())
      .toContain('text/plain');

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/metrics refuses a registry it cannot read, and leaves /health alone', async () => {
    const { sys, cluster } = await startNode();
    // The documented "one scrape endpoint" wiring: the operator's own
    // collector holds the values, and this registry keeps no copy (#744).
    sys.extension(MetricsExtensionId).useRegistry(new WriteThroughRegistry());
    const routes = managementRoutes(sys, cluster, { enableMetricsEndpoint: true });
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const metrics = await fetch(`http://127.0.0.1:${binding.port}/metrics`);
    expect(metrics.status).toBe(503);
    expect(await metrics.text()).toContain('collect()');

    // The reason the refusal is a per-request status and not a throw from
    // `managementRoutes`: a startup error would take the probes down too, to
    // report a metrics problem that costs the node nothing else.
    const health = await fetch(`http://127.0.0.1:${binding.port}/health`);
    expect(health.status).toBe(200);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/metrics is 404 when disabled (default)', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster);
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/metrics`);
    expect(response.status).toBe(404);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('cluster.down() force-downs a known peer and emits MemberDown/Removed', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    // Drive cluster.down via the public API rather than HTTP so the
    // event-emission contract is observable from the test directly —
    // the HTTP route is a thin wrapper around the same method.
    const sysA = ActorSystem.create('mgmt', sysOptions);
    const sysOptions2 = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sysB = ActorSystem.create('mgmt', sysOptions2);
    const portA = 56_000 + Math.floor(Math.random() * 500);
    const portB = portA + 1;
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(portA)
      .withTransport(new InMemoryTransport(new NodeAddress('mgmt', 'h', portA)))
      .withGossipIntervalMs(50);
    const clA = await Cluster.join(
      sysA,
      clusterOptions,
    );
    const clusterOptions2 = ClusterOptions.create()
      .withHost('h')
      .withPort(portB)
      .withSeeds([`mgmt@h:${portA}`])
      .withTransport(new InMemoryTransport(new NodeAddress('mgmt', 'h', portB)))
      .withGossipIntervalMs(50);
    const clB = await Cluster.join(
      sysB,
      clusterOptions2,
    );
    // Wait for B to be up on both sides.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const sees = clA.getMembers().some(m => m.address.equals(clB.selfAddress) && m.status === 'up');
      if (sees) break;
      // The poll cadence of the loop above, not a wait.
      await Bun.sleep(20);
    }
    // Force-down B from A.
    const ok = clA.down(clB.selfAddress);
    expect(ok).toBe(true);
    const stillThere = clA.getMembers().find(m => m.address.equals(clB.selfAddress));
    // Either tombstoned (`removed` status) or filtered out — public API filters removed.
    expect(stillThere == null || stillThere.status === 'removed').toBe(true);
    // Idempotent — second call returns false (already terminal).
    expect(clA.down(clB.selfAddress)).toBe(false);

    await clA.leave(); await clB.leave();
    await sysA.terminate(); await sysB.terminate();
  });
});

describe('managementRoutes — auth + IP allowlist (#312)', () => {
  async function startNode(): Promise<{ sys: ActorSystem; cluster: Cluster }> {
    const port = 55500 + Math.floor(Math.random() * 300);
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('mgmt', sysOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      .withTransport(new InMemoryTransport(new NodeAddress('mgmt', 'h', port)))
      .withGossipIntervalMs(80);
    const cluster = await Cluster.join(
      sys,
      clusterOptions,
    );
    return { sys, cluster };
  }

  test('/cluster/members is 401 without bearer token; 200 with correct token', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster, {
      auth: BearerTokenAuth({ tokens: ['s3cret-token'] }),
    });
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const denied = await fetch(`http://127.0.0.1:${binding.port}/cluster/members`);
    expect(denied.status).toBe(401);

    const wrong = await fetch(`http://127.0.0.1:${binding.port}/cluster/members`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`http://127.0.0.1:${binding.port}/cluster/members`, {
      headers: { authorization: 'Bearer s3cret-token' },
    });
    expect(ok.status).toBe(200);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/health and /ready remain anonymous when auth is set (default)', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster, {
      auth: BearerTokenAuth({ tokens: ['s3cret-token'] }),
    });
    healthChecksOf(sys).addLiveness(() => ({ name: 'ok', status: true }));
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    // Health probes work WITHOUT a token — the standard K8s probe
    // path.  This is the explicit-policy contract from #312.
    const healthResponse = await fetch(`http://127.0.0.1:${binding.port}/health`);
    expect(healthResponse.status).toBe(200);
    const readyResponse = await fetch(`http://127.0.0.1:${binding.port}/ready`);
    expect(readyResponse.status).toBe(200);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('authProtectHealth: true forces auth on health/ready too', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster, {
      auth: BearerTokenAuth({ tokens: ['s3cret-token'] }),
      authProtectHealth: true,
    });
    healthChecksOf(sys).addLiveness(() => ({ name: 'ok', status: true }));
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const noAuth = await fetch(`http://127.0.0.1:${binding.port}/health`);
    expect(noAuth.status).toBe(401);

    const withAuth = await fetch(`http://127.0.0.1:${binding.port}/health`, {
      headers: { authorization: 'Bearer s3cret-token' },
    });
    expect(withAuth.status).toBe(200);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('ipAllowlist gates every endpoint including /health by network', async () => {
    const { sys, cluster } = await startNode();
    const routes = managementRoutes(sys, cluster, {
      // Allowlist contains nothing useful — we want the middleware to
      // refuse the request, then we'll relax it via getClientIp.
      ipAllowlist: IpAllowlist({
        allow: ['10.0.0.0/8'],
        // Pin the IP via a custom extractor so the test is not
        // dependent on whatever the platform reports as remoteAddress.
        getClientIp: (request) => request.headers['x-test-client'] ?? null,
      }),
    });
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const denied = await fetch(`http://127.0.0.1:${binding.port}/health`, {
      headers: { 'x-test-client': '192.168.1.5' },
    });
    expect(denied.status).toBe(403);

    const allowed = await fetch(`http://127.0.0.1:${binding.port}/health`, {
      headers: { 'x-test-client': '10.0.1.2' },
    });
    expect(allowed.status).toBe(200);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });
});
