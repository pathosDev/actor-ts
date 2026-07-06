import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { Nobody } from '../../../../src/ActorRef.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { Cluster, ClusterOptions } from '../../../../src/cluster/Cluster.js';
import { ClusterSharding, StartShardingOptions } from '../../../../src/cluster/sharding/ClusterSharding.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { RemoteActorRef } from '../../../../src/cluster/RemoteActorRef.js';
import { Props } from '../../../../src/Props.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(25);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface Node {
  readonly sys: ActorSystem;
  readonly cluster: Cluster;
}

async function startNode(
  systemName: string,
  port: number,
  seeds: string[] = [],
  roles: string[] = [],
): Promise<Node> {
  const sys = ActorSystem.create(systemName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const cluster = await Cluster.join(
    sys,
    ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      .withSeeds(seeds)
      .withRoles(roles)
      .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
      .withGossipIntervalMs(30),
  );
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
    type Cmd = { id: string; replyTo: ActorRef<string> };

    class Echo extends Actor<Cmd> {
      override onReceive(m: Cmd): void {
        m.replyTo.tell(`pong:${m.id}`);
      }
    }

    const received: string[] = [];
    class Probe extends Actor<string> {
      override onReceive(m: string): void { received.push(m); }
    }

    const sysName = 'ref-xnode';
    // Node A carries role "hoster" — sharding will place every shard there.
    const a = await startNode(sysName, 58_001, [],                     ['hoster']);
    const b = await startNode(sysName, 58_002, [`${sysName}@h:58001`], []);

    await waitFor(() => a.cluster.upMembers().length === 2);

    // Both nodes register the sharded type with `role: 'hoster'` so shards
    // can ONLY be allocated to node A (which carries that role).
    a.cluster.sharding.start<Cmd>(
      StartShardingOptions.create<Cmd>()
        .withTypeName('echo')
        .withRole('hoster')
        .withEntityProps(Props.create(() => new Echo()))
        .withExtractEntityId((m) => m.id)
        .withNumShards(16),
    );
    const bRegion = b.cluster.sharding.start<Cmd>(
      StartShardingOptions.create<Cmd>()
        .withTypeName('echo')
        .withRole('hoster')
        .withEntityProps(Props.create(() => new Echo()))
        .withExtractEntityId((m) => m.id)
        .withNumShards(16),
    );

    // Probe lives on node B — its LocalActorRef is therefore OWNED by B.
    const probeOnB = b.sys.spawn(Props.create(() => new Probe()), 'probe');

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

    await stop(a);
    await stop(b);
  });

  test('already-remote refs in the body keep their original target on the other side', async () => {
    type Cmd = { stashRef: ActorRef<string> };

    // This actor doesn't care about the ref — it just captures what it saw.
    const seen: Array<ActorRef<string>> = [];
    class Capturer extends Actor<Cmd> {
      override onReceive(m: Cmd): void { seen.push(m.stashRef); }
    }

    const sysName = 'ref-remote';
    const a = await startNode(sysName, 58_101, [],                     ['hoster']);
    const b = await startNode(sysName, 58_102, [`${sysName}@h:58101`], []);

    await waitFor(() => a.cluster.upMembers().length === 2);

    a.cluster.sharding.start<Cmd>(
      StartShardingOptions.create<Cmd>()
        .withTypeName('cap')
        .withRole('hoster')
        .withEntityProps(Props.create(() => new Capturer()))
        .withExtractEntityId(() => 'only')
        .withNumShards(4),
    );
    const bRegion = b.cluster.sharding.start<Cmd>(
      StartShardingOptions.create<Cmd>()
        .withTypeName('cap')
        .withRole('hoster')
        .withEntityProps(Props.create(() => new Capturer()))
        .withExtractEntityId(() => 'only')
        .withNumShards(4),
    );

    await sleep(300);

    // Forge a RemoteActorRef pointing at some OTHER (fake) third node and
    // send it as part of the payload.  The receiver on A must reconstruct a
    // RemoteActorRef with the SAME target (not back to B the sender).
    const fake = new RemoteActorRef(
      new NodeAddress('other', 'elsewhere', 9999),
      'actor-ts://other/user/stashed',
      b.cluster,
    );
    bRegion.tell({ stashRef: fake });

    await waitFor(() => seen.length >= 1, 5_000);
    const decoded = seen[0]!;
    expect(decoded).toBeInstanceOf(RemoteActorRef);
    const r = decoded as RemoteActorRef;
    expect(r.targetNode.host).toBe('elsewhere');
    expect(r.targetNode.port).toBe(9999);
    expect(r.targetPath).toBe('actor-ts://other/user/stashed');

    await stop(a);
    await stop(b);
  });

  test('Nobody in the body round-trips back to Nobody', async () => {
    type Cmd = { attempt: ActorRef<string> };
    const observed: { nobody: boolean } = { nobody: false };

    class Checker extends Actor<Cmd> {
      override onReceive(m: Cmd): void {
        observed.nobody = m.attempt.path.systemName === '<nobody>';
      }
    }

    const sysName = 'ref-nobody';
    const a = await startNode(sysName, 58_201, [],                     ['hoster']);
    const b = await startNode(sysName, 58_202, [`${sysName}@h:58201`], []);

    await waitFor(() => a.cluster.upMembers().length === 2);

    a.cluster.sharding.start<Cmd>(
      StartShardingOptions.create<Cmd>()
        .withTypeName('checker')
        .withRole('hoster')
        .withEntityProps(Props.create(() => new Checker()))
        .withExtractEntityId(() => 'only')
        .withNumShards(4),
    );
    const bRegion = b.cluster.sharding.start<Cmd>(
      StartShardingOptions.create<Cmd>()
        .withTypeName('checker')
        .withRole('hoster')
        .withEntityProps(Props.create(() => new Checker()))
        .withExtractEntityId(() => 'only')
        .withNumShards(4),
    );

    await sleep(300);
    bRegion.tell({ attempt: Nobody });

    await waitFor(() => observed.nobody, 3_000);
    expect(observed.nobody).toBe(true);

    await stop(a);
    await stop(b);
  });
});
