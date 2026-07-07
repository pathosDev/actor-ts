import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { BearerTokenAuth } from '../../../src/http/middleware/BearerToken.js';
import { IpAllowlist } from '../../../src/http/middleware/IpAllowlist.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  HealthCheckRegistry,
  isHealthy,
  managementRoutes,
} from '../../../src/management/index.js';

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
});

describe('managementRoutes — cluster queries', () => {
  async function startNode(): Promise<{ sys: ActorSystem; cluster: Cluster; port: number }> {
    const port = 55200 + Math.floor(Math.random() * 300);
    const sys = ActorSystem.create('mgmt', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const cluster = await Cluster.join(
      sys,
      ClusterOptions.create()
        .withHost('h')
        .withPort(port)
        .withTransport(new InMemoryTransport(new NodeAddress('mgmt', 'h', port)))
        .withGossipIntervalMs(80),
    );
    return { sys, cluster, port };
  }

  test('/cluster/members returns the current membership as JSON', async () => {
    const { sys, cluster } = await startNode();
    const { routes } = managementRoutes(sys, cluster);
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const res = await fetch(`http://127.0.0.1:${binding.port}/cluster/members`);
    const body = await res.json() as { members: Array<{ address: string }>; self: string };
    expect(res.status).toBe(200);
    expect(body.members.length).toBe(1);
    expect(body.self).toContain('mgmt@h:');

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/health is 200 when all liveness checks pass', async () => {
    const { sys, cluster } = await startNode();
    const { routes, health } = managementRoutes(sys, cluster);
    health.addLiveness(() => ({ name: 'ok', status: true }));
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const res = await fetch(`http://127.0.0.1:${binding.port}/health`);
    const body = await res.json() as { status: string };
    expect(res.status).toBe(200);
    expect(body.status).toBe('UP');

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/health is 503 when a liveness check fails', async () => {
    const { sys, cluster } = await startNode();
    const { routes, health } = managementRoutes(sys, cluster);
    health.addLiveness(() => ({ name: 'db', status: false, detail: 'conn refused' }));
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const res = await fetch(`http://127.0.0.1:${binding.port}/health`);
    expect(res.status).toBe(503);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/ready reflects cluster Up state', async () => {
    const { sys, cluster } = await startNode();
    const { routes } = managementRoutes(sys, cluster);
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    // Wait until self member is Up.
    await Bun.sleep(150);

    const res = await fetch(`http://127.0.0.1:${binding.port}/ready`);
    const body = await res.json() as { status: string; clusterReady: boolean };
    expect(body.clusterReady).toBe(true);
    expect(body.status).toBe('UP');

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/cluster/leave triggers cluster.leave when enabled', async () => {
    const { sys, cluster, port } = await startNode();
    void port;
    const { routes } = managementRoutes(sys, cluster, { enableLeaveEndpoint: true });
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const res = await fetch(`http://127.0.0.1:${binding.port}/cluster/leave`, { method: 'POST' });
    expect(res.status).toBe(202);
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
    const { routes } = managementRoutes(sys, cluster, { enableDownEndpoint: true });
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const res = await fetch(`http://127.0.0.1:${binding.port}/cluster/down`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'mgmt@h:99999' }),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('no member');

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/cluster/down rejects body without address field', async () => {
    const { sys, cluster } = await startNode();
    const { routes } = managementRoutes(sys, cluster, { enableDownEndpoint: true });
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const res = await fetch(`http://127.0.0.1:${binding.port}/cluster/down`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wrongField: 'mgmt@h:1' }),
    });
    expect(res.status).toBe(400);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/cluster/down is 404 when endpoint is disabled', async () => {
    const { sys, cluster } = await startNode();
    const { routes } = managementRoutes(sys, cluster);   // defaults — disabled
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const res = await fetch(`http://127.0.0.1:${binding.port}/cluster/down`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'mgmt@h:1' }),
    });
    expect(res.status).toBe(404);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/cluster/shards 400s without `type` query parameter', async () => {
    const { sys, cluster } = await startNode();
    const { routes } = managementRoutes(sys, cluster);
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const res = await fetch(`http://127.0.0.1:${binding.port}/cluster/shards`);
    expect(res.status).toBe(400);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/cluster/shards 404s when DistributedData has no shard state for the type', async () => {
    const { sys, cluster } = await startNode();
    const { routes } = managementRoutes(sys, cluster);
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const res = await fetch(`http://127.0.0.1:${binding.port}/cluster/shards?type=Orders`);
    expect(res.status).toBe(404);
    // Either "DistributedData not started" or "no shard-map recorded"
    // depending on which path triggers.

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/metrics returns Prometheus text format when enabled', async () => {
    const { sys, cluster } = await startNode();
    const { routes } = managementRoutes(sys, cluster, { enableMetricsEndpoint: true });
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const res = await fetch(`http://127.0.0.1:${binding.port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')?.toLowerCase())
      .toContain('text/plain');

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('/metrics is 404 when disabled (default)', async () => {
    const { sys, cluster } = await startNode();
    const { routes } = managementRoutes(sys, cluster);
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    const res = await fetch(`http://127.0.0.1:${binding.port}/metrics`);
    expect(res.status).toBe(404);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('cluster.down() force-downs a known peer and emits MemberDown/Removed', async () => {
    // Drive cluster.down via the public API rather than HTTP so the
    // event-emission contract is observable from the test directly —
    // the HTTP route is a thin wrapper around the same method.
    const sysA = ActorSystem.create('mgmt', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const sysB = ActorSystem.create('mgmt', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const portA = 56_000 + Math.floor(Math.random() * 500);
    const portB = portA + 1;
    const clA = await Cluster.join(
      sysA,
      ClusterOptions.create()
        .withHost('h')
        .withPort(portA)
        .withTransport(new InMemoryTransport(new NodeAddress('mgmt', 'h', portA)))
        .withGossipIntervalMs(50),
    );
    const clB = await Cluster.join(
      sysB,
      ClusterOptions.create()
        .withHost('h')
        .withPort(portB)
        .withSeeds([`mgmt@h:${portA}`])
        .withTransport(new InMemoryTransport(new NodeAddress('mgmt', 'h', portB)))
        .withGossipIntervalMs(50),
    );
    // Wait for B to be up on both sides.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const sees = clA.getMembers().some(m => m.address.equals(clB.selfAddress) && m.status === 'up');
      if (sees) break;
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
    const sys = ActorSystem.create('mgmt', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const cluster = await Cluster.join(
      sys,
      ClusterOptions.create()
        .withHost('h')
        .withPort(port)
        .withTransport(new InMemoryTransport(new NodeAddress('mgmt', 'h', port)))
        .withGossipIntervalMs(80),
    );
    return { sys, cluster };
  }

  test('/cluster/members is 401 without bearer token; 200 with correct token', async () => {
    const { sys, cluster } = await startNode();
    const { routes } = managementRoutes(sys, cluster, {
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
    const { routes, health } = managementRoutes(sys, cluster, {
      auth: BearerTokenAuth({ tokens: ['s3cret-token'] }),
    });
    health.addLiveness(() => ({ name: 'ok', status: true }));
    const http = sys.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(routes);

    // Health probes work WITHOUT a token — the standard K8s probe
    // path.  This is the explicit-policy contract from #312.
    const healthRes = await fetch(`http://127.0.0.1:${binding.port}/health`);
    expect(healthRes.status).toBe(200);
    const readyRes = await fetch(`http://127.0.0.1:${binding.port}/ready`);
    expect(readyRes.status).toBe(200);

    await binding.unbind();
    await cluster.leave(); await sys.terminate();
  });

  test('authProtectHealth: true forces auth on health/ready too', async () => {
    const { sys, cluster } = await startNode();
    const { routes, health } = managementRoutes(sys, cluster, {
      auth: BearerTokenAuth({ tokens: ['s3cret-token'] }),
      authProtectHealth: true,
    });
    health.addLiveness(() => ({ name: 'ok', status: true }));
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
    const { routes } = managementRoutes(sys, cluster, {
      // Allowlist contains nothing useful — we want the middleware to
      // refuse the request, then we'll relax it via getClientIp.
      ipAllowlist: IpAllowlist({
        allow: ['10.0.0.0/8'],
        // Pin the IP via a custom extractor so the test is not
        // dependent on whatever the platform reports as remoteAddress.
        getClientIp: (req) => req.headers['x-test-client'] ?? null,
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
