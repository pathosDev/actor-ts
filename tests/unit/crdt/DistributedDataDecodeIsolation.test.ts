/**
 * A malformed peer value is dropped, not escalated (#699, #721).
 *
 * `decodeCrdt` validates and therefore throws.  Every call site is a wire
 * handler, so an exception out of one is an actor failure — twelve of them
 * exhausted DistributedData's restart budget and terminated it for the life of
 * the process, taking every unsettled read and write promise with it.  The
 * validation landed without the catch, which made the reachable throw paths
 * more numerous rather than fewer.
 *
 * Same forging harness as `DistributedDataAuthority.test.ts`: a plain
 * `InMemoryTransport` under its own address, speaking the wire directly.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DistributedDataId, GCounter } from '../../../src/crdt/index.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];
const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => {})));
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function startNode(name: string, port: number): Promise<Cluster> {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return cluster;
}

async function attacker(name: string, port: number): Promise<InMemoryTransport> {
  const transport = new InMemoryTransport(new NodeAddress(name, 'h', port));
  transport.setHandler(() => {});
  await transport.start();
  transports.push(transport);
  return transport;
}

describe('DistributedData decode isolation', () => {
  test('twelve malformed gossip entries do not kill the replica (#699)', async () => {
    const victim = await startNode('decode-victim', 48_201);
    const data = victim.system.extension(DistributedDataId).start(victim);
    await sleep(80);

    const evil = await attacker('decode-evil', 48_202);
    // Twelve is the number that used to exhaust the restart budget.
    for (let round = 0; round < 12; round++) {
      evil.send(victim.selfAddress, {
        kind: 'ddata-gossip',
        from: new NodeAddress('decode-evil', 'h', 48_202).toJSON(),
        entries: { [`bad-${round}`]: { kind: 'NotACrdtKind', nonsense: round } },
      } as unknown as WireMessage);
    }
    await sleep(300);

    // The replica is still alive, and still merges a well-formed value from
    // the same peer — so the drop is per value rather than a quarantine of the
    // sender.  Before the catch the actor had been terminated by the twelfth
    // frame and this merge never happened.
    evil.send(victim.selfAddress, {
      kind: 'ddata-gossip',
      from: new NodeAddress('decode-evil', 'h', 48_202).toJSON(),
      entries: { good: GCounter.empty().increment('decode-evil', 7).toJSON() },
    } as unknown as WireMessage);
    await sleep(200);

    expect(data.get<GCounter>('good')?.value()).toBe(7);
  });

  test('a malformed entry does not cost the other entries of the same frame (#699)', async () => {
    const victim = await startNode('decode-victim2', 48_211);
    const data = victim.system.extension(DistributedDataId).start(victim);
    await sleep(80);

    const evil = await attacker('decode-evil2', 48_212);
    // One frame, one bad entry between two good ones.  They are independent
    // CRDTs that merely travel together.
    evil.send(victim.selfAddress, {
      kind: 'ddata-gossip',
      from: new NodeAddress('decode-evil2', 'h', 48_212).toJSON(),
      entries: {
        first: GCounter.empty().increment('decode-evil2', 3).toJSON(),
        broken: { kind: 'GCounter', state: 'not-an-object' },
        last: GCounter.empty().increment('decode-evil2', 5).toJSON(),
      },
    } as unknown as WireMessage);
    await sleep(250);

    expect(data.get<GCounter>('first')?.value()).toBe(3);
    expect(data.get<GCounter>('last')?.value()).toBe(5);
  });
});
