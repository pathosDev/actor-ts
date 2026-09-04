/**
 * #838 — the acceptance test: a cluster that arbitrates a partition with
 * **no code-side downing setup at all**, only
 * `actor-ts.cluster.split-brain-resolver.active-strategy` in its config.
 *
 * Three nodes rather than two, deliberately: `KeepMajority` downs *both*
 * sides on an exact tie (`KeepMajority.ts`), so a 1-1 split would prove the
 * strategy ran and nothing about which side it picked.
 *
 * **Why this test is not vacuous.**  "The peer is gone" is a state the
 * failure detector reaches on its own — that is the default behaviour, and
 * it is what the control arm below shows.  Two discriminators separate the
 * resolver's verdict from the detector's:
 *
 *   1. **Timing.**  `downAfterMs` is pinned at 4 s, far past every assertion
 *      here, with `unreachableAfterMs` at 200 ms.  The established in-repo
 *      shape — `DowningKeepMajority.test.ts` and `DowningWiring.test.ts`
 *      both do exactly this.  Anything observed inside the window was the
 *      resolver's doing.
 *   2. **Self-down, which the detector cannot do at all.**  Its loop skips
 *      self (`Cluster.failureDetectionTick`), so no elapsed time makes a
 *      node leave its own cluster; `evaluateDowning` self-leaves.  The
 *      minority node's own membership going `leaving`/`removed` is therefore
 *      clock-independent proof that a resolver decided.
 *
 * Since #929 a configured provider also stops the detector evicting at all —
 * it parks the peer at `unreachable` instead — so the control arm is the
 * *unconfigured* one, and the two arms differ in what `getMembers()` holds
 * inside the same window.
 *
 * `Config.parseString`, never `Config.fromObject({'actor-ts.…': …})`: the
 * latter keeps the dotted string as one literal top-level key and `hasPath`
 * would then resolve the nested reference value instead — a test that
 * asserts nothing and passes.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { Config } from '../../../../../src/config/Config.js';
import type { FailureDetectorOptionsType } from '../../../../../src/cluster/FailureDetectorOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

/**
 * Detector timings every arm shares.  `down-after` is out of reach of every
 * assertion in this file, which is the point: what the tests observe cannot
 * be the detector's elapsed-time eviction.
 */
const SLOW_EVICTION: FailureDetectorOptionsType = {
  heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 4_000,
};

type Node = { sys: ActorSystem; cluster: Cluster };

/**
 * A node whose *only* downing input is `config` — there is deliberately no
 * `withDowning(…)` anywhere in this file, which is the whole claim.
 */
async function startNode(
  systemName: string,
  port: number,
  config: Config,
  seeds?: string[],
): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config);
  const sys = ActorSystem.create(systemName, systemOptions);
  let clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector(SLOW_EVICTION)
    .withGossipIntervalMs(80);
  if (seeds !== undefined) clusterOptions = clusterOptions.withSeeds(seeds);
  const cluster = await Cluster.join(sys, clusterOptions);
  return { sys, cluster };
}

async function startThree(
  systemName: string, basePort: number, config: Config,
): Promise<[Node, Node, Node]> {
  const seed = await startNode(systemName, basePort, config);
  const seedAddress = `${systemName}@h:${basePort}`;
  const second = await startNode(systemName, basePort + 1, config, [seedAddress]);
  const third = await startNode(systemName, basePort + 2, config, [seedAddress]);
  await awaitCondition(
    () => [seed, second, third].every((node) => node.cluster.upMembers().length === 3),
    { timeoutMs: 5_000, intervalMs: 25, label: 'all three nodes converged on a 3-member cluster' },
  );
  return [seed, second, third];
}

async function stopAll(nodes: Node[]): Promise<void> {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* may already have left */ }
    await node.sys.terminate();
  }
}

const knows = (node: Node, address: string): boolean =>
  node.cluster.getMembers().some((m) => m.address.toString() === address);

describe('a split-brain resolver selected from config (#838)', () => {
  test('keep-majority downs the minority side, with no code-side downing setup', async () => {
    const systemName = 'sbr-config-majority';
    const config = Config.parseString(
      'actor-ts.cluster.split-brain-resolver.active-strategy = keep-majority',
    );
    const [seed, second, third] = await startThree(systemName, 64_101, config);
    const isolatedAddress = third.cluster.selfAddress.toString();

    // Partition the third node off. Both majority nodes see it fall silent;
    // it sees both of them fall silent.
    await third.cluster.transport.shutdown();

    // Discriminator 1 — the majority side evicts it well inside `down-after`.
    // A detector-driven eviction could not happen before 4 s, and since #929
    // a configured provider stops the detector evicting at all.
    await awaitCondition(
      () => !knows(seed, isolatedAddress) && !knows(second, isolatedAddress),
      { timeoutMs: 2_000, intervalMs: 25, label: 'the majority side removed the isolated node' },
    );
    expect(seed.cluster.upMembers().length).toBe(2);
    expect(second.cluster.upMembers().length).toBe(2);

    // Discriminator 2 — the minority node leaves its *own* cluster, which the
    // failure detector cannot cause at any elapsed time: its loop skips self.
    await awaitCondition(
      () => {
        const self = third.cluster.selfMember();
        return self === undefined || self.status === 'leaving' || self.status === 'removed';
      },
      { timeoutMs: 4_000, intervalMs: 25, label: 'the isolated node self-downed' },
    );

    await stopAll([seed, second]);
    await third.sys.terminate();
  }, 20_000);

  test('the control: with no strategy configured, nothing arbitrates in that window', async () => {
    // The arm that makes the one above mean something.  Identical fixture,
    // identical timings, an empty config — and inside the same window the
    // isolated node is merely `unreachable` on the majority side and still
    // believes it is `up` on its own.  Without this, "the peer is gone" would
    // be a claim about a state the detector produces by itself after 4 s.
    const systemName = 'sbr-config-none';
    const [seed, second, third] = await startThree(systemName, 64_111, Config.empty());
    const isolatedAddress = third.cluster.selfAddress.toString();

    await third.cluster.transport.shutdown();

    await awaitCondition(
      () => seed.cluster.getMembers().some((m) => m.status === 'unreachable'),
      { timeoutMs: 3_000, intervalMs: 25, label: 'the majority side marked the peer unreachable' },
    );

    // Still there — parked at `unreachable`, not evicted, because `down-after`
    // is 4 s away and nothing else is deciding.
    expect(knows(seed, isolatedAddress)).toBe(true);
    expect(seed.cluster.getMembers().find((m) => m.address.toString() === isolatedAddress)!.status)
      .toBe('unreachable');
    // And the isolated node has not left its own cluster: only a resolver
    // ever does that.
    expect(third.cluster.selfMember()!.status).toBe('up');

    await stopAll([seed, second]);
    await third.sys.terminate();
  }, 20_000);

  test('an explicit withDowning still wins over the configured strategy', async () => {
    // The precedence rule, end to end rather than on the merge helper: the
    // file says `keep-majority`, the code hands over a provider that downs
    // nothing, and the isolated node is therefore still known — parked at
    // `unreachable` — inside a window where the configured strategy would
    // long since have evicted it.
    const systemName = 'sbr-config-overridden';
    const config = Config.parseString(
      'actor-ts.cluster.split-brain-resolver.active-strategy = keep-majority',
    );
    let consulted = 0;
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(config);

    const seedSystem = ActorSystem.create(systemName, systemOptions);
    const seedOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(64_121)
      .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', 64_121)))
      .withFailureDetector(SLOW_EVICTION)
      .withGossipIntervalMs(80)
      .withDowning({ decide: () => { consulted++; return new Set<string>(); } });
    const seed: Node = { sys: seedSystem, cluster: await Cluster.join(seedSystem, seedOptions) };
    const seedAddress = `${systemName}@h:64121`;
    const second = await startNode(systemName, 64_122, config, [seedAddress]);
    const third = await startNode(systemName, 64_123, config, [seedAddress]);
    await awaitCondition(
      () => seed.cluster.upMembers().length === 3,
      { timeoutMs: 5_000, intervalMs: 25, label: 'the overridden seed saw all three members' },
    );
    const isolatedAddress = third.cluster.selfAddress.toString();

    await third.cluster.transport.shutdown();
    await awaitCondition(
      () => consulted > 0 && seed.cluster.getMembers().some((m) => m.status === 'unreachable'),
      { timeoutMs: 3_000, intervalMs: 25, label: 'the code-side provider was consulted' },
    );

    expect(knows(seed, isolatedAddress)).toBe(true);
    expect(seed.cluster.getMembers().find((m) => m.address.toString() === isolatedAddress)!.status)
      .toBe('unreachable');

    await stopAll([seed, second]);
    await third.sys.terminate();
  }, 20_000);
});
