/**
 * #1426 — under `failure-detector.auto-down = off` the survivor of a crash is
 * ready again at `down-after`, as it is under the shipped default.
 *
 * The framework-owned `cluster-transport` readiness check fails when this node
 * expects at least one peer and can reach none of them.  Under the default the
 * crashed peer is removed at `down-after`, so a lone survivor expects nobody
 * and passes.  Under the opt-out the crashed peer is parked at `unreachable`
 * instead, and a parked peer used to count as expected — so the survivor of a
 * two-node cluster failed readiness for good and dropped out of its load
 * balancer until an operator removed the dead node.  A peer parked past
 * `down-after` is not expected any more; one that is unreachable but not yet
 * past `down-after` still is, so a short blip reads exactly as it did.
 *
 * Two real nodes on the in-memory transport, in real time: crash one, read the
 * survivor's readiness while the peer is only unreachable, and again once the
 * survivor has parked it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { CLUSTER_TRANSPORT_CHECK_NAME } from '../../../src/cluster/ClusterHealthChecks.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel } from '../../../src/Logger.js';
import type { HealthCheckResult } from '../../../src/management/HealthCheck.js';
import { healthChecksOf } from '../../../src/management/HealthCheckExtension.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

type LiveNode = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
  readonly transport: InMemoryTransport;
  readonly log: RecordingLogger;
};

/**
 * `down-after` wide enough that the window between `unreachable` (200 ms) and
 * the parking is a span a reader cannot miss, and short enough that the test
 * still sees the parking inside one awaited budget.
 */
const DOWN_AFTER_MS = 2_000;

let nodes: LiveNode[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

async function startNode(systemName: string, port: number, seeds: string[]): Promise<LiveNode> {
  const address = new NodeAddress(systemName, 'h', port);
  const log = new RecordingLogger(LogLevel.Warn);
  const systemOptions = ActorSystemOptions.create().withLogger(log).withLogLevel(LogLevel.Warn);
  const system = ActorSystem.create(systemName, systemOptions);
  const transport = new InMemoryTransport(address);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(transport)
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: DOWN_AFTER_MS })
    .withFailureDetectorAutoDown(false)
    .withGossipIntervalMs(40);
  const cluster = await Cluster.join(system, clusterOptions);
  const node: LiveNode = { system, cluster, address, transport, log };
  nodes.push(node);
  return node;
}

/** A crash: the transport goes first, so not even the shutdown's leave frame gets out. */
async function crash(node: LiveNode): Promise<void> {
  await node.transport.shutdown();
  await node.system.terminate();
  nodes = nodes.filter((candidate) => candidate !== node);
}

async function transportReadiness(node: LiveNode): Promise<HealthCheckResult | undefined> {
  const results = await healthChecksOf(node.system).checkReadiness();
  return results.find((result) => result.name === CLUSTER_TRANSPORT_CHECK_NAME);
}

const statusIn = (viewer: LiveNode, subject: NodeAddress): string | undefined =>
  viewer.cluster.getMembers().find((member) => member.address.equals(subject))?.status;

describe('cluster-transport readiness under auto-down = off (#1426)', () => {
  test('the survivor of a two-node crash is not ready while the peer is only unreachable, and ready once it is parked', async () => {
    const survivor = await startNode('parked-readiness', 47_401, []);
    const crashed = await startNode('parked-readiness', 47_402, [survivor.address.toString()]);
    await awaitCondition(
      () => survivor.cluster.upMembers().length === 2 && crashed.cluster.upMembers().length === 2,
      { timeoutMs: 4_000, label: 'both nodes up in both views' },
    );
    expect((await transportReadiness(survivor))?.status).toBe(true);

    await crash(crashed);
    await awaitCondition(() => statusIn(survivor, crashed.address) === 'unreachable', {
      timeoutMs: 1_500, label: 'the survivor saw the crashed node go unreachable',
    });
    // Before down-after: a peer that may still come back is expected, so the
    // node that can reach none of its peers is out of rotation — the reading a
    // short blip has always had.
    const beforeDownAfter = await transportReadiness(survivor);
    expect(beforeDownAfter?.status).toBe(false);
    expect(survivor.log.records.some((record) => record.message.includes('parked at unreachable'))).toBe(false);

    await awaitCondition(
      () => survivor.log.records.some((record) =>
        record.message.includes('parked at unreachable') && record.message.includes(crashed.address.toString())),
      { timeoutMs: 4_000, label: 'the survivor parked the crashed node past down-after' },
    );
    // Parked, not removed: the peer is still a member, and the survivor is
    // ready because a parked peer is not one it expects to reach.
    expect(statusIn(survivor, crashed.address)).toBe('unreachable');
    const afterDownAfter = await transportReadiness(survivor);
    expect(afterDownAfter?.status, afterDownAfter?.detail).toBe(true);
  }, 15_000);
});
