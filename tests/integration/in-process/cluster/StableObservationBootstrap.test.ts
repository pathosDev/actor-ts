import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { bootstrapCluster } from '../../../../src/cluster/ClusterBootstrap.js';
import type { BootstrappedCluster } from '../../../../src/cluster/ClusterBootstrap.js';
import { ClusterBootstrapOptions } from '../../../../src/cluster/ClusterBootstrapOptions.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { StableObservation } from '../../../../src/cluster/bootstrap/StableObservation.js';
import { ConfigSeedProvider } from '../../../../src/discovery/ConfigSeedProvider.js';
import { ConfigSeedProviderOptions } from '../../../../src/discovery/ConfigSeedProviderOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/**
 * The stable-observation bootstrap (#148), exercised end to end against real
 * `Cluster` instances over the in-memory transport.
 *
 * The property under test is the one the unit suite cannot reach: that the
 * election's output, fed into `ClusterOptions.selfElection`, produces exactly
 * one cluster — and, crucially, that the node the election picks does *not*
 * form one when a cluster already exists.
 */

const quietSystem = (name: string): ActorSystem => ActorSystem.create(
  name,
  ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
);

/** Tight timings so a cold start converges inside a test's budget. */
const fastCluster = (options: ReturnType<typeof ClusterOptions.create>): typeof options => options
  .withGossipIntervalMs(50)
  .withSeedRetryIntervalMs(80)
  .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 1_000, downAfterMs: 2_000 });

function seedProviderOf(systemName: string, seeds: string[]): ConfigSeedProvider {
  const seedOptions = ConfigSeedProviderOptions.create()
    .withSeeds(seeds)
    .withSystemName(systemName);
  return new ConfigSeedProvider(seedOptions);
}

describe('Cluster bootstrap — stable observation', () => {
  test('symmetric seed lists converge on a single cluster', async () => {
    // Every node lists every node — the seed layout the docs recommend for
    // production, and the one that deadlocks without an election: `Cluster`
    // filters self out of its own seed list, so no node is left with the
    // empty list that `'immediate'` self-election needs, and nothing is ever
    // promoted.
    const name = 'stable-symmetric';
    const ports = [56001, 56002, 56003];
    const everyone = ports.map((port) => `${name}@h:${port}`);

    const systems = ports.map(() => quietSystem(name));
    const clusters: Cluster[] = [];
    for (const [index, port] of ports.entries()) {
      const selfAddress = new NodeAddress(name, 'h', port);
      const observation = new StableObservation({
        seedProvider: seedProviderOf(name, [...everyone]),
        selfAddress,
        pollIntervalMs: 5,
        stableMarginMs: 0,
        maxWaitMs: 2_000,
        selfElectionGraceMs: 250,
      });
      const targets = await observation.resolveJoinTargets();
      // Only the lowest-addressed node may ever form a cluster on its own.
      expect(targets.isInitialSeed).toBe(port === ports[0]);
      expect(targets.seeds).toHaveLength(2);

      const clusterOptions = fastCluster(ClusterOptions.create()
        .withHost('h')
        .withPort(port)
        .withSeeds(targets.seeds.map((address) => address.toString()))
        .withSelfElection(targets.selfElection)
        .withTransport(new InMemoryTransport(selfAddress)));
      clusters.push(await Cluster.join(systems[index]!, clusterOptions));
    }

    await awaitCondition(
      () => clusters.every((cluster) => cluster.upMembers().length === 3),
      { timeoutMs: 4_000, intervalMs: 20, label: 'all three nodes see the same 3-member cluster' },
    );

    // One cluster, and every node agrees on which node leads it.
    const leaders = clusters.map((cluster) => cluster.leader().fold(
      () => 'none',
      (member) => member.address.toString(),
    ));
    expect(new Set(leaders)).toEqual(new Set([`${name}@h:${ports[0]}`]));

    for (const cluster of clusters) await cluster.leave();
    for (const system of systems) await system.terminate();
  }, 20_000);

  test('the elected node joins an existing cluster instead of forming a rival', async () => {
    // The case a naive "lowest address becomes the seed" gets wrong: the
    // newcomer sorts first, so it wins the election against a cluster that is
    // already running.  Because self-election is deferred rather than
    // immediate, the running cluster promotes it long before the grace
    // elapses — proven here by a grace far longer than the wait.
    const name = 'stable-scale-up';
    const existingPorts = [56102, 56103];
    const newcomerPort = 56101;

    const existingSystems = existingPorts.map(() => quietSystem(name));
    const existing: Cluster[] = [];
    for (const [index, port] of existingPorts.entries()) {
      const clusterOptions = fastCluster(ClusterOptions.create()
        .withHost('h')
        .withPort(port)
        .withSeeds(index === 0 ? [] : [`${name}@h:${existingPorts[0]}`])
        .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port))));
      existing.push(await Cluster.join(existingSystems[index]!, clusterOptions));
    }
    await awaitCondition(
      () => existing.every((cluster) => cluster.upMembers().length === 2),
      { timeoutMs: 4_000, intervalMs: 20, label: 'the two-node cluster is up' },
    );

    const newcomerAddress = new NodeAddress(name, 'h', newcomerPort);
    const observation = new StableObservation({
      seedProvider: seedProviderOf(name, [...existingPorts, newcomerPort].map((p) => `${name}@h:${p}`)),
      selfAddress: newcomerAddress,
      pollIntervalMs: 5,
      stableMarginMs: 0,
      maxWaitMs: 2_000,
      // Ten seconds: far beyond the wait below, so reaching `up` inside it can
      // only have come from the existing cluster's leader.
      selfElectionGraceMs: 10_000,
    });
    const targets = await observation.resolveJoinTargets();
    expect(targets.isInitialSeed).toBe(true);
    // Bind the DEFERRAL, not just the win: a regression to 'immediate' is a
    // no-op on this join path (non-empty seeds), so the counts below would
    // still reach 3 and the title's claim would go unproven (#1087).
    expect(targets.selfElection).toBe(10_000);

    const newcomerSystem = quietSystem(name);
    const newcomerOptions = fastCluster(ClusterOptions.create()
      .withHost('h')
      .withPort(newcomerPort)
      .withSeeds(targets.seeds.map((address) => address.toString()))
      .withSelfElection(targets.selfElection)
      .withTransport(new InMemoryTransport(newcomerAddress)));
    const newcomer = await Cluster.join(newcomerSystem, newcomerOptions);

    await awaitCondition(
      () => newcomer.upMembers().length === 3,
      { timeoutMs: 3_000, intervalMs: 20, label: 'the newcomer was promoted by the existing cluster' },
    );
    await awaitCondition(
      () => existing.every((cluster) => cluster.upMembers().length === 3),
      { timeoutMs: 3_000, intervalMs: 20, label: 'the existing cluster absorbed the newcomer' },
    );
    // The mechanism, not the merge: selfElect() provably never fired — the
    // newcomer reached `up` through the running cluster's leader.  A rival
    // cluster that gossip later merged would reach the same counts with
    // `selfElected === true`, which is exactly the blind spot #1087 names.
    expect(newcomer.selfElected).toBe(false);

    await newcomer.leave();
    await newcomerSystem.terminate();
    for (const cluster of existing) await cluster.leave();
    for (const system of existingSystems) await system.terminate();
  }, 20_000);

  test("'never' keeps an isolated node out of the cluster it cannot reach", async () => {
    // Two isolated nodes with identical, unreachable seed lists: one is told
    // it lost the election, the other that it won.  The winner's promotion is
    // the clock — once it is up, enough time has passed that a 'never' node
    // would have self-elected too, had it been allowed to.
    const name = 'stable-never';
    const loserSystem = quietSystem(name);
    const loserOptions = fastCluster(ClusterOptions.create()
      .withHost('h')
      .withPort(56201)
      .withSeeds([`${name}@h:56299`])
      .withSelfElection('never')
      .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', 56201))));
    const loser = await Cluster.join(loserSystem, loserOptions);

    const winnerSystem = quietSystem(name);
    const winnerOptions = fastCluster(ClusterOptions.create()
      .withHost('h')
      .withPort(56202)
      .withSeeds([`${name}@h:56298`])
      .withSelfElection(120)
      .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', 56202))));
    const winner = await Cluster.join(winnerSystem, winnerOptions);

    await awaitCondition(
      () => winner.upMembers().length === 1,
      { timeoutMs: 4_000, intervalMs: 20, label: 'the deferred node self-elected once its grace expired' },
    );

    const self = loser.getMembers().find((member) => member.address.equals(loser.selfAddress));
    expect(self?.status).toBe('joining');
    expect(loser.upMembers()).toHaveLength(0);
    // The two policies, told apart by the mechanism observable: the winner
    // founded (its grace expired and selfElect fired), the loser never did.
    expect(winner.selfElected).toBe(true);
    expect(loser.selfElected).toBe(false);

    await loser.leave();
    await winner.leave();
    await loserSystem.terminate();
    await winnerSystem.terminate();
  }, 20_000);

  test("'immediate' still self-elects only on an empty seed list", async () => {
    // The default, unchanged: an empty seed list means "I am the first node",
    // a non-empty one means "wait to be let in".
    const name = 'stable-immediate';
    const firstSystem = quietSystem(name);
    const firstOptions = fastCluster(ClusterOptions.create()
      .withHost('h')
      .withPort(56301)
      .withSeeds([])
      .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', 56301))));
    const first = await Cluster.join(firstSystem, firstOptions);

    await awaitCondition(
      () => first.upMembers().length === 1,
      { timeoutMs: 2_000, intervalMs: 10, label: 'the seedless node self-elected' },
    );

    const secondSystem = quietSystem(name);
    const secondOptions = fastCluster(ClusterOptions.create()
      .withHost('h')
      .withPort(56302)
      .withSeeds([`${name}@h:56301`])
      .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', 56302))));
    const second = await Cluster.join(secondSystem, secondOptions);

    await awaitCondition(
      () => second.upMembers().length === 2,
      { timeoutMs: 4_000, intervalMs: 20, label: 'the seeded node joined through the first' },
    );

    await second.leave();
    await first.leave();
    await secondSystem.terminate();
    await firstSystem.terminate();
  }, 20_000);
});

describe('bootstrapCluster — stableObservation', () => {
  test('wires the election for three nodes given the same seed list', async () => {
    const name = 'stable-boot';
    const ports = [56401, 56402, 56403];
    const everyone = ports.map((port) => `${name}@h:${port}`);
    const tuning = {
      pollIntervalMs: 5,
      stableMarginMs: 0,
      maxWaitMs: 2_000,
      selfElectionGraceMs: 250,
    };

    const started: BootstrappedCluster[] = [];
    for (const port of ports) {
      const bootstrapOptions = ClusterBootstrapOptions.create(name)
        .withHost('h')
        .withPort(port)
        .withSeeds([...everyone])
        .withStableObservation(tuning)
        .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
        .withReceptionist(false)
        .withShutdownOnSignals(false)
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withGossipIntervalMs(50);
      started.push(await bootstrapCluster(bootstrapOptions));
    }

    // The elected node's `SelfUp` is not due until its grace has elapsed, so a
    // flat 5 s `awaitReady` default would have returned a node still in
    // `joining` and called it ready.  It resolves only after the election.
    expect(started[0]!.cluster.upMembers().length).toBeGreaterThan(0);

    await awaitCondition(
      () => started.every(({ cluster }) => cluster.upMembers().length === 3),
      { timeoutMs: 6_000, intervalMs: 20, label: 'all three bootstrapped nodes joined one cluster' },
    );

    // Exactly one founder — the elected lowest address; the other two were
    // promoted into its cluster.  Everyone reports ready (#1087, end to end).
    expect(started.map(({ cluster }) => cluster.selfElected)).toEqual([true, false, false]);
    expect(started.map((node) => node.formedNewCluster)).toEqual([true, false, false]);
    expect(started.every(({ cluster }) => cluster.isReady())).toBe(true);

    for (const { shutdown } of started) await shutdown();
  }, 30_000);

  test('refuses to elect on a wildcard advertised host', async () => {
    // A bind address is not an identity: ordered on it, every node sorts first
    // (#944).  The phase says so instead of running a meaningless election.
    //
    // The wildcard has to be named as the *advertised* host to get here.  A
    // bare `withHost('0.0.0.0')` no longer reaches this guard at all —
    // `resolveAdvertisedHost` turns it into a dialable address before the
    // election ever sees it, which is the other half of the same fix.
    const name = 'stable-wildcard';
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('0.0.0.0')
      .withAdvertisedHost('0.0.0.0')
      .withPort(56501)
      .withSeeds([`${name}@h:56502`])
      .withStableObservation(true)
      .withTransport(new InMemoryTransport(new NodeAddress(name, '0.0.0.0', 56501)))
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);

    await expect(bootstrapCluster(bootstrapOptions)).rejects.toThrow(/wildcard bind address/);
  }, 20_000);
});
