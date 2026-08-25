/**
 * #1355 — the readiness surface on `Cluster`.
 *
 * Starts with the observables the readiness API is built from:
 * `selfMember()` (the node's own record, tombstone included, which
 * `getMembers()` deliberately hides) and `selfElected` (formed-vs-joined —
 * the mechanism #943 asks callers to be able to see, and the one #1087's
 * integration test binds to).  The `awaitReady` / `isReady` cases share the
 * same fixtures.
 *
 * Nodes run on the in-memory transport with fast gossip (50 ms), so the one
 * cross-node wait settles well inside its 4 s budget; the failure detector's
 * thresholds are pushed past the test's lifetime because reachability is not
 * under test here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const HOST = '10.0.164.1';

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

/** The private surface the tombstone test drives — bookkeeping-safe writes. */
interface ClusterInternals {
  setMember(member: Member): void;
}

const internals = (cluster: Cluster): ClusterInternals =>
  cluster as unknown as ClusterInternals;

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

async function startNode(args: {
  readonly systemName: string;
  readonly port: number;
  readonly seeds?: ReadonlyArray<string>;
}): Promise<NodeHandle> {
  const address = new NodeAddress(args.systemName, HOST, args.port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(args.systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(args.port)
    .withTransport(new InMemoryTransport(address))
    .withSeeds([...(args.seeds ?? [])])
    .withGossipIntervalMs(50)
    .withSeedRetryIntervalMs(80)
    .withFailureDetector({
      heartbeatIntervalMs: 60_000,
      unreachableAfterMs: 60_000,
      downAfterMs: 120_000,
    });
  const cluster = await Cluster.join(system, clusterOptions);
  const handle = { system, cluster, address };
  nodes.push(handle);
  return handle;
}

/** A seed nobody answers — the address is never registered with the transport. */
const deadSeed = (systemName: string): string => `${systemName}@${HOST}:65001`;

describe('selfMember()', () => {
  test('reports the joining record while seed contact is still pending', async () => {
    const node = await startNode({
      systemName: 'self-view-joining',
      port: 9_401,
      seeds: [deadSeed('self-view-joining')],
    });
    expect(node.cluster.selfMember()?.status).toBe('joining');
    expect(node.cluster.selfElected).toBe(false);
  });

  test('does not filter a removed self, unlike getMembers()', async () => {
    const node = await startNode({ systemName: 'self-view-removed', port: 9_402 });
    const me = node.cluster.selfMember();
    expect(me?.status).toBe('up');
    internals(node.cluster).setMember(me!.withRemoved(Date.now()));
    expect(node.cluster.getMembers().some((m) => m.address.equals(node.address))).toBe(false);
    expect(node.cluster.selfMember()?.status).toBe('removed');
  });
});

describe('selfElected', () => {
  test('a node with no seeds elects itself and says so', async () => {
    const node = await startNode({ systemName: 'self-elected-solo', port: 9_403 });
    expect(node.cluster.selfMember()?.status).toBe('up');
    expect(node.cluster.selfElected).toBe(true);
  });

  test('a node promoted by an existing cluster reports false', async () => {
    const seedNode = await startNode({ systemName: 'self-elected-join', port: 9_404 });
    const joiner = await startNode({
      systemName: 'self-elected-join',
      port: 9_405,
      seeds: [seedNode.address.toString()],
    });
    await awaitCondition(
      () => joiner.cluster.selfMember()?.status === 'up',
      { timeoutMs: 4_000, label: 'the seed node promoted the joiner' },
    );
    expect(joiner.cluster.selfElected).toBe(false);
    expect(seedNode.cluster.selfElected).toBe(true);
  });
});
