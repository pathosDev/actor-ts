import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import {
  CLUSTER_MEMBERSHIP_CHECK_NAME,
  CLUSTER_TRANSPORT_CHECK_NAME,
} from '../../../src/cluster/ClusterHealthChecks.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { grpcHealthCheckImplementation } from '../../../src/io/broker/GrpcServerActor.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  healthChecksOf,
  isHealthy,
  managementRoutes,
} from '../../../src/management/index.js';

/**
 * A node that has left the cluster must not report READY (#655 regression).
 *
 * `Cluster.leave()` used to take the cluster's two readiness checks back out
 * of the registry.  Nothing else had put a readiness check there, so
 * `checkReadiness()` came back empty, `results.every(…)` was vacuously true
 * on `[]`, and `/ready` answered **200 with an empty check list** — a node
 * that had deliberately gone out of service still telling a load balancer to
 * send it traffic, which is the exact inverse of what a readiness probe is
 * for.
 *
 * Two properties are pinned here, and the second is why the first is not
 * enough on its own:
 *
 *   1. leaving makes every probe answer NOT READY — `/ready`, and the gRPC
 *      `grpc.health.v1.Health` service that reads the same registry;
 *   2. "no checks registered" is a **decision**, not the accident of
 *      `every` on an empty array.  The rule survives only because nothing in
 *      the framework empties the registry on its way out of service.
 */

type ReadinessBody = {
  status: string;
  clusterReady: boolean;
  checks: Array<{ name: string; status: boolean; detail?: string }>;
};

function silentSystem(name: string): ActorSystem {
  return ActorSystem.create(name, ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off));
}

/**
 * A seedless single-node cluster: `selfElection: 'immediate'` promotes it to
 * `up` without a peer, so readiness is green before the test does anything.
 */
async function joinSoloCluster(system: ActorSystem, port: number): Promise<Cluster> {
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withGossipIntervalMs(40)
    .withTransport(new InMemoryTransport(new NodeAddress(system.name, 'h', port)));
  return Cluster.join(system, clusterOptions);
}

/** Poll `/ready` until it reports `expected`, or give up and return the last body. */
async function readyWhen(
  port: number,
  expected: number,
): Promise<{ status: number; body: ReadinessBody }> {
  const deadline = Date.now() + 5_000;
  let response = await fetch(`http://127.0.0.1:${port}/ready`);
  let body = await response.json() as ReadinessBody;
  while (Date.now() < deadline && response.status !== expected) {
    // The poll cadence of the loop above, not a wait: `/ready` has to be asked
    // again each turn, and the caller tolerates the deadline expiring.
    await Bun.sleep(20);
    response = await fetch(`http://127.0.0.1:${port}/ready`);
    body = await response.json() as ReadinessBody;
  }
  return { status: response.status, body };
}

describe('a node that left the cluster is not ready (#655)', () => {
  test('/ready answers 503 after leave, and names the check that says so', async () => {
    const system = silentSystem('left-http');
    const cluster = await joinSoloCluster(system, 57_100 + Math.floor(Math.random() * 90));
    const http = system.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(managementRoutes(system, cluster));

    // Baseline: an admitted single-node cluster is ready, and the framework's
    // checks are the ones saying so.  Without this the later assertion could
    // pass for the wrong reason.
    const before = await readyWhen(binding.port, 200);
    expect(before.status).toBe(200);
    expect(before.body.clusterReady).toBe(true);
    expect(before.body.checks.map((c) => c.name).sort())
      .toEqual([CLUSTER_MEMBERSHIP_CHECK_NAME, CLUSTER_TRANSPORT_CHECK_NAME].sort());

    await cluster.leave();

    const response = await fetch(`http://127.0.0.1:${binding.port}/ready`);
    const body = await response.json() as ReadinessBody;
    expect(response.status).toBe(503);
    expect(body.status).toBe('DOWN');
    expect(body.clusterReady).toBe(false);
    // The check list must still be there.  An empty one is the shape of the
    // bug: it reads as "nothing is failing" at every consumer.
    expect(body.checks.length).toBeGreaterThan(0);
    const membership = body.checks.find((c) => c.name === CLUSTER_MEMBERSHIP_CHECK_NAME);
    expect(membership?.status).toBe(false);
    expect(membership?.detail).toContain('leaving');

    // Liveness is untouched: leaving is not something a restart repairs, and
    // the process is still perfectly able to answer.
    const liveness = await fetch(`http://127.0.0.1:${binding.port}/health`);
    expect(liveness.status).toBe(200);

    await binding.unbind();
    await system.terminate();
  });

  test('the gRPC health service answers NOT_SERVING after leave', async () => {
    // Same registry, so the two probes cannot disagree about what "ready"
    // means — the reason the registry is per-system in the first place.
    const system = silentSystem('left-grpc');
    const cluster = await joinSoloCluster(system, 57_300 + Math.floor(Math.random() * 90));
    const health = healthChecksOf(system);
    const check = grpcHealthCheckImplementation(health, 'sensor.v1', 'SensorService');

    const serving = await new Promise<unknown>((resolve) => {
      check.Check({ request: { service: '' } }, (_error, response) => resolve(response));
    });
    expect(serving).toEqual({ status: 'SERVING' });

    await cluster.leave();

    const afterLeave = await new Promise<unknown>((resolve) => {
      check.Check({ request: { service: '' } }, (_error, response) => resolve(response));
    });
    expect(afterLeave).toEqual({ status: 'NOT_SERVING' });

    await system.terminate();
  });

  // The property the fix must not break in buying the one above: keeping the
  // checks past `leave()` would otherwise pin a re-joined process to 503
  // forever, because the dead incarnation's view of itself stays `leaving`.
  test('re-joining replaces the dead incarnation\'s checks rather than adding to them', async () => {
    const system = silentSystem('rejoin');
    const port = 57_700 + Math.floor(Math.random() * 90);
    const first = await joinSoloCluster(system, port);
    await first.leave();

    const second = await joinSoloCluster(system, port);
    const http = system.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(managementRoutes(system, second));

    const { status, body } = await readyWhen(binding.port, 200);
    expect(body.checks.map((c) => c.name).sort())
      .toEqual([CLUSTER_MEMBERSHIP_CHECK_NAME, CLUSTER_TRANSPORT_CHECK_NAME].sort());
    expect(status).toBe(200);
    expect(body.clusterReady).toBe(true);

    await binding.unbind();
    await second.leave();
    await system.terminate();
  });
});

describe('"no readiness checks" is a decision, not a vacuous truth (#655)', () => {
  // Stated as a rule of its own so that the case it exists to serve — a
  // plain, cluster-free actor system that registered nothing — cannot be
  // confused with the case it must never cover, a registry that went empty
  // because something took checks out on its way down.
  test('an empty result set is healthy', () => {
    expect(isHealthy([])).toBe(true);
  });

  test('a single failing result is not, however many pass beside it', () => {
    expect(isHealthy([{ name: 'a', status: true }, { name: 'b', status: false }])).toBe(false);
    expect(isHealthy([{ name: 'a', status: true }])).toBe(true);
  });

  test('a cluster-free system answers /ready 200 with an empty check list', async () => {
    const system = silentSystem('no-cluster');
    const http = system.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(managementRoutes(system, null));

    const response = await fetch(`http://127.0.0.1:${binding.port}/ready`);
    const body = await response.json() as ReadinessBody;
    expect(response.status).toBe(200);
    expect(body.checks).toEqual([]);
    expect(body.clusterReady).toBe(true);

    await binding.unbind();
    await system.terminate();
  });
});
