import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Nobody } from '../../../../src/ActorRef.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { ClusterSharding } from '../../../../src/cluster/sharding/ClusterSharding.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { RemoteActorRef } from '../../../../src/cluster/RemoteActorRef.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

/**
 * Kept as a name so every call site here stays unchanged; the body forwards to
 * the shared helper (#418), which names the awaited state in its timeout
 * message instead of only the elapsed budget.
 */
const waitFor = (
  predicate: () => boolean,
  timeoutMs = 5_000,
  label = 'the awaited cross-node state',
): Promise<void> => awaitCondition(predicate, { timeoutMs, intervalMs: 25, label });

type Node = {
  readonly sys: ActorSystem;
  readonly cluster: Cluster;
};

async function startNode(
  systemName: string,
  port: number,
  seeds: string[] = [],
  roles: string[] = [],
): Promise<Node> {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(systemName, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withRoles(roles)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(sys, clusterOptions);
  return { sys, cluster };
}

async function stop(n: Node): Promise<void> {
  await n.cluster.leave();
  await n.sys.terminate();
}

/**
 * End-to-end tests that force user-payload refs to cross the wire both ways:
 *   - sender-side: user message with embedded ref → JSON wire frame
 *   - receiver-side: WireActorRef → real ActorRef (Local or Remote)
 *   - re-tell via the decoded ref → round-trip back to the original owner
 *
 * We pin all shards to node A via a role filter so every ask from node B
 * deterministically crosses to A.  The probe lives on node B; when node A's
 * entity replies via the ref, that reply MUST travel back over the wire —
 * which only works if the ref was serialised correctly on the way in.
 */
describe('ActorRef serialisation across cluster nodes', () => {
  test('a LocalActorRef embedded in the body is reconstructed as a usable RemoteActorRef on the other side', async () => {
    type Command = { id: string; replyTo: ActorRef<string> };

    class Echo extends Actor<Command> {
      override onReceive(m: Command): void {
        m.replyTo.tell(`pong:${m.id}`);
      }
    }

    const received: string[] = [];
    class Probe extends Actor<string> {
      override onReceive(m: string): void { received.push(m); }
    }

    const sysName = 'ref-xnode';
    // Node A carries role "hoster" — sharding will place every shard there.
    const nodeA = await startNode(sysName, 58_001, [],                     ['hoster']);
    const nodeB = await startNode(sysName, 58_002, [`${sysName}@h:58001`], []);

    await waitFor(() => nodeA.cluster.upMembers().length === 2);

    // Both nodes register the sharded type with `role: 'hoster'` so shards
    // can ONLY be allocated to node A (which carries that role).
    const aShardingOptions = StartShardingOptions.create<Command>()
      .withTypeName('echo')
      .withRole('hoster')
      .withEntityActor(Echo)
      .withExtractEntityId((m) => m.id)
      .withNumShards(16);
    nodeA.cluster.sharding.start<Command>(aShardingOptions);
    const bShardingOptions = StartShardingOptions.create<Command>()
      .withTypeName('echo')
      .withRole('hoster')
      .withEntityActor(Echo)
      .withExtractEntityId((m) => m.id)
      .withNumShards(16);
    const bRegion = nodeB.cluster.sharding.start<Command>(bShardingOptions);

    // Probe lives on node B — its LocalActorRef is therefore OWNED by B.
    const probeOnB = nodeB.sys.spawn(Probe, 'probe');

    // Give sharding a moment to allocate initial shards (the first ask from
    // the non-hoster node otherwise races the coordinator).
    await sleep(300);

    // Send from node B — every shard lives on A, so every ShardEnvelope
    // goes over the wire with `replyTo` encoded as a WireActorRef tagged
    // with B's selfAddress.
    const N = 20;
    for (let i = 0; i < N; i++) {
      bRegion.tell({ id: `e-${i}`, replyTo: probeOnB });
    }

    // Each reply travels: A (Echo) → WireActorRef decoded into a
    // RemoteActorRef(B) → _sendEnvelope to B → Cluster.handleEnvelope on B
    // resolves the target path locally → probeOnB.tell(`pong:...`).
    await waitFor(() => received.length >= N, 8_000);
    expect(received).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect(received).toContain(`pong:e-${i}`);
    }

    await stop(nodeA);
    await stop(nodeB);
  });

  test('already-remote refs in the body keep their original target on the other side', async () => {
    type Command = { stashRef: ActorRef<string> };

    // This actor doesn't care about the ref — it just captures what it saw.
    const seen: Array<ActorRef<string>> = [];
    class Capturer extends Actor<Command> {
      override onReceive(m: Command): void { seen.push(m.stashRef); }
    }

    const sysName = 'ref-remote';
    const nodeA = await startNode(sysName, 58_101, [],                     ['hoster']);
    const nodeB = await startNode(sysName, 58_102, [`${sysName}@h:58101`], []);

    await waitFor(() => nodeA.cluster.upMembers().length === 2);

    const aShardingOptions = StartShardingOptions.create<Command>()
      .withTypeName('cap')
      .withRole('hoster')
      .withEntityActor(Capturer)
      .withExtractEntityId(() => 'only')
      .withNumShards(4);
    nodeA.cluster.sharding.start<Command>(aShardingOptions);
    const bShardingOptions = StartShardingOptions.create<Command>()
      .withTypeName('cap')
      .withRole('hoster')
      .withEntityActor(Capturer)
      .withExtractEntityId(() => 'only')
      .withNumShards(4);
    const bRegion = nodeB.cluster.sharding.start<Command>(bShardingOptions);

    // Give sharding a moment to allocate initial shards — the tell from the
    // non-hoster node otherwise races the coordinator.  Nothing is asserted on
    // the wait itself; `waitFor(seen.length >= 1)` below is the real signal, so
    // an allocation still in flight is absorbed rather than misread.
    await sleep(300);

    // Forge a RemoteActorRef pointing at some OTHER (fake) third node and
    // send it as part of the payload.  The receiver on A must reconstruct a
    // RemoteActorRef with the SAME target (not back to B the sender).
    const fake = new RemoteActorRef(
      new NodeAddress('other', 'elsewhere', 9999),
      'actor-ts://other/user/stashed',
      nodeB.cluster,
    );
    bRegion.tell({ stashRef: fake });

    await waitFor(() => seen.length >= 1, 5_000);
    const decoded = seen[0]!;
    expect(decoded).toBeInstanceOf(RemoteActorRef);
    const ref = decoded as RemoteActorRef;
    expect(ref.targetNode.host).toBe('elsewhere');
    expect(ref.targetNode.port).toBe(9999);
    expect(ref.targetPath).toBe('actor-ts://other/user/stashed');

    await stop(nodeA);
    await stop(nodeB);
  });

  test('Nobody in the body round-trips back to Nobody', async () => {
    type Command = { attempt: ActorRef<string> };
    const observed: { nobody: boolean } = { nobody: false };

    class Checker extends Actor<Command> {
      override onReceive(m: Command): void {
        observed.nobody = m.attempt.path.systemName === '<nobody>';
      }
    }

    const sysName = 'ref-nobody';
    const nodeA = await startNode(sysName, 58_201, [],                     ['hoster']);
    const nodeB = await startNode(sysName, 58_202, [`${sysName}@h:58201`], []);

    await waitFor(() => nodeA.cluster.upMembers().length === 2);

    const aShardingOptions = StartShardingOptions.create<Command>()
      .withTypeName('checker')
      .withRole('hoster')
      .withEntityActor(Checker)
      .withExtractEntityId(() => 'only')
      .withNumShards(4);
    nodeA.cluster.sharding.start<Command>(aShardingOptions);
    const bShardingOptions = StartShardingOptions.create<Command>()
      .withTypeName('checker')
      .withRole('hoster')
      .withEntityActor(Checker)
      .withExtractEntityId(() => 'only')
      .withNumShards(4);
    const bRegion = nodeB.cluster.sharding.start<Command>(bShardingOptions);

    // Same initial-allocation warm-up as above; `waitFor(observed.nobody)`
    // carries the real budget, so this only keeps the tell from racing the
    // coordinator.
    await sleep(300);
    bRegion.tell({ attempt: Nobody });

    await waitFor(() => observed.nobody, 3_000);
    expect(observed.nobody).toBe(true);

    await stop(nodeA);
    await stop(nodeB);
  });

  /**
   * #517 — every test above passes a *spawned* actor as `replyTo`, which has a
   * real resolvable path.  The ref `ask` synthesises does not: it used to be a
   * root path, and a root renders without its own name, so the reply travelled
   * back addressed to the bare system root and was dropped.  `ask` is what the
   * docs recommend for confirming a cross-node `tell`, so this is the shape a
   * reader is most likely to write.
   */
  describe('ask() across nodes (#517)', () => {
    type Command = { kind: 'ping'; id: string; replyTo: ActorRef<string> };

    class Echo extends Actor<Command> {
      override onReceive(m: Command): void { m.replyTo.tell(`pong:${m.id}`); }
    }

    test('resolves with the remote actor’s reply', async () => {
      const sysName = 'ref-ask';
      const nodeA = await startNode(sysName, 58_301, []);
      const nodeB = await startNode(sysName, 58_302, [`${sysName}@h:58301`]);
      try {
        await waitFor(() => nodeB.cluster.upMembers().length === 2);

        const echo = nodeA.sys.spawn(Echo, 'echo');
        const remote = new RemoteActorRef<Command>(
          nodeA.cluster.selfAddress,
          echo.path.toString(),
          nodeB.cluster,
        );

        expect(await remote.ask<string>({ kind: 'ping', id: 'solo' }, 3_000)).toBe('pong:solo');
      } finally {
        await stop(nodeA);
        await stop(nodeB);
      }
    });

    /**
     * The registration is keyed by the ref's path, so the path has to be
     * unique per ask.  A root path is not: it renders as the bare system root
     * for *every* ask, so two in flight at once share one key and the second
     * silently evicts the first — which then never resolves.
     */
    test('two asks in flight at once each get their own reply', async () => {
      const sysName = 'ref-ask-concurrent';
      const nodeA = await startNode(sysName, 58_321, []);
      const nodeB = await startNode(sysName, 58_322, [`${sysName}@h:58321`]);
      try {
        await waitFor(() => nodeB.cluster.upMembers().length === 2);

        const echo = nodeA.sys.spawn(Echo, 'echo');
        const remote = new RemoteActorRef<Command>(
          nodeA.cluster.selfAddress,
          echo.path.toString(),
          nodeB.cluster,
        );

        const replies = await Promise.all([
          remote.ask<string>({ kind: 'ping', id: 'first' }, 3_000),
          remote.ask<string>({ kind: 'ping', id: 'second' }, 3_000),
        ]);

        expect(replies).toEqual(['pong:first', 'pong:second']);
      } finally {
        await stop(nodeA);
        await stop(nodeB);
      }
    });

    test('still times out — and names the target — when nothing answers', async () => {
      const sysName = 'ref-ask-timeout';
      const nodeA = await startNode(sysName, 58_311, []);
      const nodeB = await startNode(sysName, 58_312, [`${sysName}@h:58311`]);
      try {
        await waitFor(() => nodeB.cluster.upMembers().length === 2);

        const remote = new RemoteActorRef<Command>(
          nodeA.cluster.selfAddress,
          `actor-ts://${sysName}/user/not-there`,
          nodeB.cluster,
        );

        await expect(remote.ask<string>({ kind: 'ping', id: 'x' }, 150)).rejects.toThrow(
          /Ask timed out after 150ms waiting for reply from actor-ts:\/\/ref-ask-timeout\/user\/not-there/,
        );
      } finally {
        await stop(nodeA);
        await stop(nodeB);
      }
    });
  });
});
