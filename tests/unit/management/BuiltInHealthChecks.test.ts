import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import {
  CLUSTER_MEMBERSHIP_CHECK_NAME,
  CLUSTER_TRANSPORT_CHECK_NAME,
  selfIsFullMember,
  transportReachesCluster,
} from '../../../src/cluster/ClusterHealthChecks.js';
import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  ACTOR_SYSTEM_LIVENESS_CHECK_NAME,
  healthChecksOf,
  managementRoutes,
} from '../../../src/management/index.js';

/**
 * The framework-owned health checks (#655).
 *
 * The predicates are tested as pure functions on purpose.  `/ready`'s only
 * unit-testable transport is `InMemoryTransport`, whose `peers()` reports
 * every transport registered in the process regardless of whether anything
 * is connected — so a connectivity assertion driven through it proves
 * nothing about the check.  `TcpTransport.peers()` counts only
 * handshake-completed connections and is the one that actually empties
 * under a partition, which is why the wiring is proved end-to-end in
 * `tests/integration/scenarios/16-readiness-gates.ts` instead.
 */

const self = new NodeAddress('sys', 'self-host', 2551);
const peerA = new NodeAddress('sys', 'peer-a', 2551);
const peerB = new NodeAddress('sys', 'peer-b', 2551);

function member(address: NodeAddress, status: MemberStatus): Member {
  return new Member(address, status, 1, new Set<string>());
}

describe('selfIsFullMember — the membership readiness predicate', () => {
  test('an up self passes', () => {
    expect(selfIsFullMember([member(self, 'up')], self)).toBe(true);
  });

  test('a joining self does not — it holds nothing yet', () => {
    expect(selfIsFullMember([member(self, 'joining')], self)).toBe(false);
  });

  // Weakly-up exists *because* convergence was not reached, so the cluster
  // has not agreed this node holds anything.
  test('a weakly-up self does not', () => {
    expect(selfIsFullMember([member(self, 'weakly-up')], self)).toBe(false);
  });

  test('a leaving self does not', () => {
    expect(selfIsFullMember([member(self, 'leaving')], self)).toBe(false);
  });

  test('a self missing from its own view does not', () => {
    expect(selfIsFullMember([member(peerA, 'up')], self)).toBe(false);
  });

  test('an up peer cannot stand in for an absent self', () => {
    expect(selfIsFullMember([member(self, 'joining'), member(peerA, 'up')], self)).toBe(false);
  });
});

describe('transportReachesCluster — the isolation readiness predicate', () => {
  test('a single-node cluster expects nobody and passes with no connections', () => {
    expect(transportReachesCluster([member(self, 'up')], self, [])).toBe(true);
  });

  test('an expected peer with no connection at all fails', () => {
    expect(transportReachesCluster([member(self, 'up'), member(peerA, 'up')], self, [])).toBe(false);
  });

  test('one live connection is enough — this is total isolation, not full reachability', () => {
    const members = [member(self, 'up'), member(peerA, 'up'), member(peerB, 'up')];
    expect(transportReachesCluster(members, self, [peerA])).toBe(true);
  });

  // The whole point of counting unreachable members: excluding them would
  // turn the check green a few seconds into every partition, which is
  // exactly when the answer matters.
  test('an unreachable peer still counts as expected', () => {
    expect(transportReachesCluster([member(self, 'up'), member(peerA, 'unreachable')], self, []))
      .toBe(false);
  });

  test('a downed peer does not — the survivor is legitimately alone', () => {
    expect(transportReachesCluster([member(self, 'up'), member(peerA, 'down')], self, []))
      .toBe(true);
  });

  test('a removed peer does not either', () => {
    expect(transportReachesCluster([member(self, 'up'), member(peerA, 'removed')], self, []))
      .toBe(true);
  });

  test('self is never counted as a peer it should be connected to', () => {
    expect(transportReachesCluster([member(self, 'up')], self, [])).toBe(true);
  });
});

describe('healthChecksOf — the per-system registry (#655)', () => {
  async function startNode(port: number): Promise<{ system: ActorSystem; cluster: Cluster }> {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('checks', systemOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      .withTransport(new InMemoryTransport(new NodeAddress('checks', 'h', port)))
      .withGossipIntervalMs(80);
    const cluster = await Cluster.join(system, clusterOptions);
    return { system, cluster };
  }

  test('the same instance comes back every time', () => {
    const system = ActorSystem.create('checks-identity', ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off));
    expect(healthChecksOf(system)).toBe(healthChecksOf(system));
  });

  test('a system with no cluster still carries the framework liveness check', async () => {
    const system = ActorSystem.create('checks-local', ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off));
    const liveness = await healthChecksOf(system).checkLiveness();
    expect(liveness.map((r) => r.name)).toEqual([ACTOR_SYSTEM_LIVENESS_CHECK_NAME]);
    expect(liveness[0]!.status).toBe(true);
    // …and no readiness check, because nothing that owns a readiness
    // signal started.
    expect(await healthChecksOf(system).checkReadiness()).toEqual([]);
    await system.terminate();
  });

  test('a terminated system reports liveness DOWN', async () => {
    const system = ActorSystem.create('checks-dead', ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off));
    const health = healthChecksOf(system);
    await system.terminate();
    const liveness = await health.checkLiveness();
    expect(liveness[0]!.status).toBe(false);
    expect(liveness[0]!.detail).toContain('terminated');
  });

  // The seam the issue is about: the checks exist because `Cluster.join`
  // put them there, not because anyone built a route tree.
  test('Cluster.join registers its readiness checks without any management route', async () => {
    const { system, cluster } = await startNode(55_900 + Math.floor(Math.random() * 90));
    const readiness = await healthChecksOf(system).checkReadiness();
    expect(readiness.map((r) => r.name).sort())
      .toEqual([CLUSTER_MEMBERSHIP_CHECK_NAME, CLUSTER_TRANSPORT_CHECK_NAME].sort());
    await cluster.leave(); await system.terminate();
  });

  test('leaving takes them back out again', async () => {
    const { system, cluster } = await startNode(56_100 + Math.floor(Math.random() * 90));
    await cluster.leave();
    expect(await healthChecksOf(system).checkReadiness()).toEqual([]);
    await system.terminate();
  });

  // A node still in `joining` is running fine but holds nothing, so the
  // membership check is the one that keeps traffic off it.
  test('the membership check is DOWN while self has not been admitted', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('checks-joining', systemOptions);
    const port = 56_300 + Math.floor(Math.random() * 90);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      // A seed that will never answer keeps self in `joining`: self-election
      // is what would otherwise promote it immediately.
      .withSeeds([`checks-joining@h:${port + 1000}`])
      .withSelfElection('never')
      .withGossipIntervalMs(80)
      .withTransport(new InMemoryTransport(new NodeAddress('checks-joining', 'h', port)));
    const cluster = await Cluster.join(system, clusterOptions);

    const readiness = await healthChecksOf(system).checkReadiness();
    const membership = readiness.find((r) => r.name === CLUSTER_MEMBERSHIP_CHECK_NAME);
    expect(membership?.status).toBe(false);
    expect(membership?.detail).toContain('joining');

    await cluster.leave(); await system.terminate();
  });
});

/**
 * A transport that gossips normally but reports no connections — what a
 * `TcpTransport` looks like once a partition has dropped its handshaked
 * sockets, minus the timing.
 *
 * `InMemoryTransport.peers()` cannot express that state: it answers from
 * the process-global registry, so it lists every transport alive in the
 * test run whether or not anything is connected.  Overriding just that one
 * method is what lets the check be observed failing through the real HTTP
 * endpoint, deterministically, without Docker and without a sleep.
 */
class DisconnectedTransport extends InMemoryTransport {
  override peers(): NodeAddress[] {
    return [];
  }
}

describe('/ready gates on the transport check end-to-end (#655)', () => {
  test('a node that sees a peer but has no connection to it answers 503', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('isolated', systemOptions);
    const port = 56_500 + Math.floor(Math.random() * 90);
    const peerPort = port + 1;
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      .withGossipIntervalMs(40)
      .withTransport(new DisconnectedTransport(new NodeAddress('isolated', 'h', port)));
    const cluster = await Cluster.join(system, clusterOptions);

    // A second node, so the first has a peer it expects to reach.  Its own
    // transport is ordinary — only the node under test reports no
    // connections.
    const peerSystem = ActorSystem.create('isolated', ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off));
    const peerOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(peerPort)
      .withSeeds([`isolated@h:${port}`])
      .withGossipIntervalMs(40)
      .withTransport(new InMemoryTransport(new NodeAddress('isolated', 'h', peerPort)));
    const peerCluster = await Cluster.join(peerSystem, peerOptions);

    const http = system.extension(HttpExtensionId);
    const binding = await http.newServerAt('127.0.0.1', 0).bind(managementRoutes(system, cluster));

    // Poll rather than sleep: the assertion is "once the peer is in the
    // member view", and gossip decides when that is.
    const deadline = Date.now() + 5_000;
    let response = await fetch(`http://127.0.0.1:${binding.port}/ready`);
    while (Date.now() < deadline && cluster.getMembers().length < 2) {
      await Bun.sleep(20);
      response = await fetch(`http://127.0.0.1:${binding.port}/ready`);
    }
    expect(cluster.getMembers().length).toBe(2);

    const body = await response.json() as {
      status: string;
      clusterReady: boolean;
      checks: Array<{ name: string; status: boolean; detail?: string }>;
    };
    expect(response.status).toBe(503);
    expect(body.status).toBe('DOWN');
    // Membership is fine — this node is `up`.  Only connectivity failed,
    // which is exactly the distinction the two checks exist to draw.
    expect(body.clusterReady).toBe(true);
    const transport = body.checks.find((c) => c.name === CLUSTER_TRANSPORT_CHECK_NAME);
    expect(transport?.status).toBe(false);
    expect(transport?.detail).toContain('no transport connection');

    // Liveness is unmoved: a partition is not something a restart fixes.
    const liveness = await fetch(`http://127.0.0.1:${binding.port}/health`);
    expect(liveness.status).toBe(200);

    await binding.unbind();
    await cluster.leave(); await peerCluster.leave();
    await system.terminate(); await peerSystem.terminate();
  });
});
