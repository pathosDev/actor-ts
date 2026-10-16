import { describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../src/Actor.js';
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
import { StartShardingOptions } from '../../../src/cluster/sharding/StartShardingOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { StartupPhases } from '../../../src/CoordinatedStartup.js';
import { CoordinatedStartupOptions } from '../../../src/CoordinatedStartupOptions.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  ACTOR_SYSTEM_LIVENESS_CHECK_NAME,
  healthChecksOf,
  isHealthy,
  managementRoutes,
  shardRegionCheckName,
  STARTUP_READINESS_CHECK_NAME,
} from '../../../src/management/index.js';
import type { HealthCheckResult } from '../../../src/management/index.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * The framework-owned health checks (#655).
 *
 * The predicates are tested as pure functions on purpose.  `/ready`'s only
 * unit-testable transport is `InMemoryTransport`, whose `peers()` reports
 * every transport registered in the process regardless of whether anything
 * is connected — so a connectivity assertion driven through it proves
 * nothing about the check.
 *
 * `TcpTransport.peers()` does not empty under a partition either, which is
 * the correction to what this header used to claim: it lists every
 * handshake-completed connection until a FIN or an RST arrives, and the
 * partitions worth worrying about produce neither.  See
 * `tests/unit/cluster/SilentPartitionReadiness.test.ts`, which establishes
 * that by execution and covers what the check therefore has to do instead.
 * `tests/integration/scenarios/16-readiness-gates.ts` proves the wiring
 * end-to-end over real sockets and real iptables rules.
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

  // Leaving deliberately does *not* take them back out.  A registry that
  // empties on the way out of service makes "everything passes" and "nothing
  // is reporting any more" the same answer, and the second one is a node that
  // has stopped being able to serve — see
  // `tests/unit/management/ReadinessAfterLeave.test.ts` for the probes.
  test('leaving leaves them registered, reporting DOWN', async () => {
    const { system, cluster } = await startNode(56_100 + Math.floor(Math.random() * 90));
    await cluster.leave();
    const readiness = await healthChecksOf(system).checkReadiness();
    expect(readiness.map((r) => r.name).sort())
      .toEqual([CLUSTER_MEMBERSHIP_CHECK_NAME, CLUSTER_TRANSPORT_CHECK_NAME].sort());
    expect(readiness.find((r) => r.name === CLUSTER_MEMBERSHIP_CHECK_NAME)?.status).toBe(false);
    expect(isHealthy(readiness)).toBe(false);
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
      // The poll cadence of the loop above, not a wait: each turn re-fetches, so
      // `response` ends up being the one taken after the member view converged.
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

/**
 * The shard-region checks `actor-ts.sharding.healthcheck.names` asks for
 * (#1465): one per named type, installed by `Cluster.join` beside the cluster
 * pair and retired with it, so they exist before anything touches
 * `cluster.sharding` — a node that never starts a named type must not report
 * ready.  The shipped `[]` adds nothing, which the exact pair asserted by
 * `Cluster.join registers its readiness checks without any management route`
 * above keeps holding.
 */
describe('the shard-region readiness checks (#1465)', () => {
  type Command = { readonly id: string; readonly kind: 'work' };

  class Entity extends Actor<Command> {
    override onReceive(message: Command): void {
      match(message)
        .with({ kind: 'work' }, () => this.onWork())
        .exhaustive();
    }

    private onWork(): void { /* the entity's existence is all a case needs */ }
  }

  /** A transport that remembers whether `join` ever started it. */
  class StartRecordingTransport extends InMemoryTransport {
    started = false;

    override async start(): Promise<void> {
      this.started = true;
      await super.start();
    }
  }

  const NAMES = `${ConfigKeys.sharding.healthcheck.names} = ["orders", "billing"]`;

  function systemWith(name: string, hocon: string): ActorSystem {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(Config.parseString(hocon));
    return ActorSystem.create(name, systemOptions);
  }

  async function join(system: ActorSystem, port: number, transport?: InMemoryTransport): Promise<Cluster> {
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      .withGossipIntervalMs(40)
      .withTransport(transport ?? new InMemoryTransport(new NodeAddress(system.name, 'h', port)));
    return await Cluster.join(system, clusterOptions);
  }

  function startOrders(cluster: Cluster): void {
    const shardingOptions = StartShardingOptions.create<Command>()
      .withTypeName('orders')
      .withEntityActor(Entity)
      .withExtractEntityId((message) => message.id)
      .withNumShards(8)
      .withPassivationIdleMs(0);
    cluster.sharding.start<Command>(shardingOptions);
  }

  const shardChecks = (readiness: ReadonlyArray<HealthCheckResult>): HealthCheckResult[] =>
    readiness.filter((result) => result.name.startsWith('shard-region:'));

  test('join installs one per named type, failing while no region for it runs', async () => {
    const system = systemWith('shard-checks-installed', NAMES);
    const cluster = await join(system, 56_700 + Math.floor(Math.random() * 90));

    const readiness = await healthChecksOf(system).checkReadiness();
    expect(readiness.map((r) => r.name).sort()).toEqual([
      CLUSTER_MEMBERSHIP_CHECK_NAME,
      CLUSTER_TRANSPORT_CHECK_NAME,
      shardRegionCheckName('billing'),
      shardRegionCheckName('orders'),
    ].sort());
    for (const result of shardChecks(readiness)) {
      expect(result.status).toBe(false);
      expect(result.detail).toContain('is running on this node: it was never started here');
    }
    expect(isHealthy(readiness)).toBe(false);

    await cluster.leave(); await system.terminate();
  }, 20_000);

  test('a named type passes once its region registers, and the other keeps failing', async () => {
    const system = systemWith('shard-checks-pass', NAMES);
    const cluster = await join(system, 56_800 + Math.floor(Math.random() * 90));
    startOrders(cluster);

    const orders = shardRegionCheckName('orders');
    await awaitCondition(async () =>
      (await healthChecksOf(system).checkReadiness()).find((r) => r.name === orders)?.status === true, {
      timeoutMs: 4_000,
      label: 'the orders check passed once its region registered',
    });
    const readiness = await healthChecksOf(system).checkReadiness();
    expect(readiness.find((r) => r.name === shardRegionCheckName('billing'))?.status).toBe(false);
    expect(isHealthy(readiness)).toBe(false);

    await cluster.leave(); await system.terminate();
  }, 20_000);

  test('/ready carries each named result, and answers 200 once every one passes', async () => {
    const system = systemWith('shard-checks-http', `${ConfigKeys.sharding.healthcheck.names} = ["orders"]`);
    const cluster = await join(system, 56_900 + Math.floor(Math.random() * 90));
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(managementRoutes(system, cluster));

    // Membership first, so the only check left failing is the one under test.
    await awaitCondition(() => selfIsFullMember(cluster.getMembers(), cluster.selfAddress), {
      timeoutMs: 4_000,
      label: 'self is up',
    });
    const before = await fetch(`http://127.0.0.1:${binding.port}/ready`);
    const body = await before.json() as { checks: Array<{ name: string; status: boolean; detail?: string }> };
    expect(before.status).toBe(503);
    const orders = body.checks.find((check) => check.name === shardRegionCheckName('orders'));
    expect(orders?.status).toBe(false);
    expect(orders?.detail).toContain("no shard region for 'orders' is running");

    startOrders(cluster);
    await awaitCondition(async () => {
      const response = await fetch(`http://127.0.0.1:${binding.port}/ready`);
      await response.body?.cancel();
      return response.status === 200;
    }, { timeoutMs: 4_000, label: '/ready answered 200 once the orders region registered' });

    await binding.unbind();
    await cluster.leave(); await system.terminate();
  }, 20_000);

  test('leaving leaves them registered, and a second join retires them with the cluster pair', async () => {
    const system = systemWith('shard-checks-rejoin', NAMES);
    const port = 57_000 + Math.floor(Math.random() * 90);
    const first = await join(system, port);
    await first.leave();
    const afterLeave = await healthChecksOf(system).checkReadiness();
    expect(shardChecks(afterLeave).map((r) => r.name).sort())
      .toEqual([shardRegionCheckName('billing'), shardRegionCheckName('orders')]);

    const second = await join(system, port + 1);
    const afterRejoin = await healthChecksOf(system).checkReadiness();
    // One per type, not two: the re-join's undo took the first incarnation's
    // out with the pair, and installed its own.
    expect(afterRejoin.map((r) => r.name).sort()).toEqual([
      CLUSTER_MEMBERSHIP_CHECK_NAME,
      CLUSTER_TRANSPORT_CHECK_NAME,
      shardRegionCheckName('billing'),
      shardRegionCheckName('orders'),
    ].sort());

    await second.leave(); await system.terminate();
  }, 20_000);

  test('a list that cannot be read fails the join before the transport starts', async () => {
    // Read where the cluster is built rather than where the checks are
    // installed: that is the last step of starting, after the transport is
    // bound and every timer armed, and `join` unwinds none of it on a throw.
    const system = systemWith('shard-checks-malformed', `${ConfigKeys.sharding.healthcheck.names} = "orders"`);
    const port = 57_100 + Math.floor(Math.random() * 90);
    const transport = new StartRecordingTransport(new NodeAddress(system.name, 'h', port));

    let failure: unknown;
    try {
      await join(system, port, transport);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConfigError);
    expect(String(failure)).toContain(ConfigKeys.sharding.healthcheck.names);
    expect(transport.started).toBe(false);
    expect(system.cluster.isNone()).toBe(true);
    expect(await healthChecksOf(system).checkReadiness()).toEqual([]);
    await system.terminate();
  }, 20_000);
});

/**
 * The startup graph's readiness check (#1473).
 *
 * Registered only on a system whose graph has tasks — a plain system keeps
 * the empty readiness set the test above pins — and, like the cluster's two,
 * never taken back out: a check that vanished once startup was over would
 * make "ready" and "nothing reporting" the same answer.
 */
describe('the startup readiness check (#1473)', () => {
  type Gate = { readonly promise: Promise<void>; readonly open: () => void };
  const gate = (): Gate => {
    let open: () => void = () => {};
    const promise = new Promise<void>((resolve) => { open = resolve; });
    return { promise, open };
  };

  const systemWithStartup = (name: string, startupOptions: CoordinatedStartupOptions): ActorSystem =>
    ActorSystem.create(name, ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withCoordinatedStartup(startupOptions));

  test('is false while the graph runs, naming the phase, and true once it completes', async () => {
    const started = gate();
    const release = gate();
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      {
        phase: StartupPhases.BeforeSystemReady,
        name: 'warm-cache',
        task: async () => { started.open(); await release.promise; },
      },
    ]);
    const system = systemWithStartup('startup-check-running', startupOptions);
    await started.promise;

    const during = await healthChecksOf(system).checkReadiness();
    expect(during.map((r) => r.name)).toEqual([STARTUP_READINESS_CHECK_NAME]);
    expect(during[0]!.status).toBe(false);
    expect(during[0]!.detail).toContain('"before-system-ready"');
    expect(isHealthy(during)).toBe(false);

    release.open();
    await system.whenReady();
    const after = await healthChecksOf(system).checkReadiness();
    expect(after).toEqual([{ name: STARTUP_READINESS_CHECK_NAME, status: true }]);
    await system.terminate();
  });

  test('is false with the failed task in its detail after a failure, and stays registered', async () => {
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      {
        phase: StartupPhases.PersistenceStart,
        name: 'open-journal',
        task: async () => { throw new Error('connection refused'); },
      },
    ]);
    const system = systemWithStartup('startup-check-failed', startupOptions);
    const health = healthChecksOf(system);
    await system.whenReady().catch(() => {});
    await system.whenTerminated();

    const readiness = await health.checkReadiness();
    expect(readiness.map((r) => r.name)).toEqual([STARTUP_READINESS_CHECK_NAME]);
    expect(readiness[0]!.status).toBe(false);
    expect(readiness[0]!.detail).toContain('"open-journal"');
    expect(readiness[0]!.detail).toContain('connection refused');
  });

  // The registry is built on first use, which is usually long after `create`:
  // a check decided at that moment from "is startup still running" would be
  // missing from every registry asked for once startup was over.
  test('a registry first asked for after startup completed still carries it', async () => {
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      { phase: StartupPhases.PersistenceStart, name: 'open-journal', task: () => {} },
    ]);
    const system = systemWithStartup('startup-check-late', startupOptions);
    await system.whenReady();
    expect(await healthChecksOf(system).checkReadiness())
      .toEqual([{ name: STARTUP_READINESS_CHECK_NAME, status: true }]);
    await system.terminate();
  });

  test('/ready answers 503 while startup runs and 200 once it has completed', async () => {
    const started = gate();
    const release = gate();
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      {
        phase: StartupPhases.PersistenceStart,
        name: 'open-journal',
        task: async () => { started.open(); await release.promise; },
      },
    ]);
    const system = systemWithStartup('startup-check-http', startupOptions);
    const binding = await system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .bind(managementRoutes(system, null));
    await started.promise;

    const during = await fetch(`http://127.0.0.1:${binding.port}/ready`);
    expect(during.status).toBe(503);
    await during.body?.cancel();

    release.open();
    await system.whenReady();
    const after = await fetch(`http://127.0.0.1:${binding.port}/ready`);
    expect(after.status).toBe(200);
    await after.body?.cancel();

    await binding.unbind();
    await system.terminate();
  });
});
