/**
 * #1747 — a joiner hears of its own promotion promptly, whatever the cluster
 * size.
 *
 * `Cluster.bootstrap` waits a flat 5 s for the node to see itself `up`
 * (`DEFAULT_AWAIT_READY_MS`).  The leader promotes a joiner as soon as the
 * joiner's record reaches it, but the joiner used to learn of that only when
 * some informed node happened to pick it as the one random target of a gossip
 * tick — with N members, a 1/(N−1) chance per node per tick.  Eight joiners
 * starting together against a twelve-node cluster were rejected six times in
 * eight, each already listed `up` by the seed within milliseconds, and under
 * `exit-process` a rejection ends the process.  That is the exact shape of the
 * v0.18 upgrade, which the wire-version cut (#823) makes "stop every node,
 * start every node".
 *
 * The leader now pushes its view to a member the moment it promotes it, so the
 * joiner's readiness no longer waits on a lottery.  The assertions are the
 * issue's acceptance criteria, on the default settings: no joiner is rejected,
 * and each is ready in well under one default gossip interval's worth of luck.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { bootstrapCluster } from '../../../src/cluster/ClusterBootstrap.js';
import { ClusterBootstrapOptions } from '../../../src/cluster/ClusterBootstrapOptions.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NoopLogger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const NAME = 'promotion-reaches-joiner';
const HOST = '127.0.0.1';
const FIRST_PORT = 47_610;
const CLUSTER_SIZE = 12;
const JOINERS = 8;

const started: ActorSystem[] = [];

afterEach(async () => {
  const systems = started.splice(0, started.length);
  await Promise.all(systems.map(async (system) => {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }));
});

const transportFor = (port: number) => new InMemoryTransport(new NodeAddress(NAME, HOST, port));
const seed = `${NAME}@${HOST}:${FIRST_PORT}`;

async function formCluster(): Promise<Cluster> {
  const clusters: Cluster[] = [];
  for (let index = 0; index < CLUSTER_SIZE; index++) {
    const port = FIRST_PORT + index;
    const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger());
    const system = ActorSystem.create(NAME, systemOptions);
    started.push(system);
    const clusterOptions = ClusterOptions.create()
      .withHost(HOST)
      .withPort(port)
      .withSeeds(index === 0 ? [] : [seed])
      .withTransport(transportFor(port));
    clusters.push(await Cluster.join(system, clusterOptions));
  }
  const first = clusters[0]!;
  await awaitCondition(
    () => first.upMembers().length === CLUSTER_SIZE,
    { timeoutMs: 30_000, intervalMs: 20, label: 'the seed sees the whole cluster up' },
  );
  return first;
}

describe('#1747 — a bootstrapped joiner hears of its own promotion', () => {
  test(`${JOINERS} joiners started together against ${CLUSTER_SIZE} nodes are all ready on the default budget`, async () => {
    const first = await formCluster();

    const outcomes = await Promise.all(Array.from({ length: JOINERS }, async (_, index) => {
      const port = FIRST_PORT + CLUSTER_SIZE + index;
      const bootstrapOptions = ClusterBootstrapOptions.create(NAME)
        .withHost(HOST)
        .withPort(port)
        .withTransport(transportFor(port))
        .withSeeds([seed])
        .withReceptionist(false)
        .withShutdownOnSignals(false)
        .withLogger(new NoopLogger());
      const startedAt = performance.now();
      try {
        const bootstrapped = await bootstrapCluster(bootstrapOptions);
        started.push(bootstrapped.system);
        return { ready: true, elapsedMs: performance.now() - startedAt };
      } catch (error) {
        return { ready: false, elapsedMs: performance.now() - startedAt, error: (error as Error).name };
      }
    }));

    // No joiner is rejected once the leader has promoted it.
    expect(outcomes.filter((outcome) => !outcome.ready)).toEqual([]);
    // And none is ready by luck at the edge of the budget: the push lands
    // within a gossip round of the promotion, not after a random wait that
    // grew with the member count — the slowest used to take 4958 ms.
    const slowest = Math.max(...outcomes.map((outcome) => outcome.elapsedMs));
    expect(slowest).toBeLessThan(2_500);
    expect(first.upMembers().length).toBe(CLUSTER_SIZE + JOINERS);
  }, 60_000);

  test('every member one promotion round lifts is told, not only the first', async () => {
    // `minimumMembersBeforeUp` holds every joiner until the fourth arrives,
    // then the leader promotes all three in one pass.  The gossip interval is
    // a minute, so a joiner that is not told directly has no other way to
    // hear inside this test's budget.
    const THRESHOLD = 4;
    const base = FIRST_PORT + 100;
    const clusters: Cluster[] = [];
    for (let index = 0; index < THRESHOLD; index++) {
      const port = base + index;
      const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger());
      const system = ActorSystem.create(NAME, systemOptions);
      started.push(system);
      const clusterOptions = ClusterOptions.create()
        .withHost(HOST)
        .withPort(port)
        .withSeeds(index === 0 ? [] : [`${NAME}@${HOST}:${base}`])
        .withMinimumMembersBeforeUp(THRESHOLD)
        .withGossipIntervalMs(60_000)
        .withTransport(transportFor(port));
      clusters.push(await Cluster.join(system, clusterOptions));
    }
    await awaitCondition(
      () => clusters.every((cluster) => cluster.selfMember()?.status === 'up'),
      { timeoutMs: 3_000, intervalMs: 10, label: 'every node promoted in the threshold round sees itself up' },
    );
  }, 30_000);
});
