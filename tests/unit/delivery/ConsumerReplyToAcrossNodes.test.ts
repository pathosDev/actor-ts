/**
 * Where a consumer's acknowledgment goes when the delivery came from another
 * node.
 *
 * `ConsumerController.sendAcknowledgment` and `delivery/ack-semantics.mdx`
 * used to argue that a forged `replyTo` could reach nothing its writer could
 * not reach already, because an `ActorRef` had no wire representation.  It
 * has one: `cluster/RefCodec.ts` carries a ref inside a message body as an
 * address marker, and the receiving node decodes the marker back into a live
 * ref.  So a peer that can send to a consumer under `/user` decides where that
 * consumer's acknowledgment goes, an actor on the consumer's own node
 * included.  This file pins that behaviour, which the corrected text now
 * describes, so a change to it shows up here and not only as prose that went
 * stale — and pins its bound: since #1572 a same-node marker goes through the
 * trust checks an envelope's own target does, so a `replyTo` naming a
 * `/system` actor decodes to `Nobody` and the acknowledgment reaches nothing.
 *
 * Two nodes on `InMemoryTransport`, both controllers spawned under `/user`:
 * the facade's controllers live under `/system/delivery/`, which a node
 * refuses from a peer, so only hand-spawned ones are reachable across nodes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { RemoteActorRef } from '../../../src/cluster/RemoteActorRef.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { ConsumerController } from '../../../src/delivery/index.js';
import type { Acknowledgment, Delivery } from '../../../src/delivery/index.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

/** Records everything it is told, so an arrival is assertable. */
class Recorder extends Actor<unknown> {
  constructor(private readonly seen: unknown[]) { super(); }

  override onReceive(message: unknown): void { this.seen.push(message); }
}

type Node = { readonly system: ActorSystem; readonly cluster: Cluster; readonly address: NodeAddress };

async function startNode(systemName: string, port: number, seeds: readonly string[] = []): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  systems.push(system);
  const address = new NodeAddress(systemName, 'h', port);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([...seeds])
    .withTransport(new InMemoryTransport(address))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return { system, cluster, address };
}

describe('ConsumerController — a replyTo written by a peer', () => {
  test('crosses the wire as a live ref, and the acknowledgment goes where the peer pointed it', async () => {
    const consumerNode = await startNode('reply-to-wire', 47_521);
    const peer = await startNode('reply-to-wire', 47_522, ['reply-to-wire@h:47521']);
    await awaitCondition(() => consumerNode.cluster.upMembers().length === 2, {
      timeoutMs: 4_000,
      intervalMs: 20,
      label: 'the two-node cluster converged',
    });

    const handled: string[] = [];
    const consumer = consumerNode.system.spawn<Delivery<string>>(
      () => new ConsumerController<string>({ handler: (body) => { handled.push(body); } }),
      'consumer',
    );
    // An actor on the consumer's own node that the peer never sends to: it
    // only names it, inside the delivery.
    const reached: unknown[] = [];
    const listener = consumerNode.system.spawn(() => new Recorder(reached), 'listener');

    const consumerSeenFromPeer = new RemoteActorRef(consumerNode.address, consumer.path.toString(), peer.cluster);
    const listenerSeenFromPeer = new RemoteActorRef(consumerNode.address, listener.path.toString(), peer.cluster);
    consumerSeenFromPeer.tell({
      kind: 'reliable-delivery.delivery',
      producerId: 'written-by-the-peer',
      incarnation: 'incarnation-1',
      seq: 1,
      body: 'from-the-peer',
      replyTo: listenerSeenFromPeer,
    });

    await awaitCondition(() => reached.length === 1, {
      timeoutMs: 4_000,
      intervalMs: 20,
      label: 'the acknowledgment reached the actor the peer named',
    });
    // Admitted as a delivery like any other — the marker arrived as a live ref.
    expect(handled).toEqual(['from-the-peer']);
    // Four fields, every one of them the peer's own writing.
    const acknowledgment = reached[0] as Acknowledgment;
    expect(acknowledgment).toEqual({
      kind: 'reliable-delivery.ack',
      producerId: 'written-by-the-peer',
      incarnation: 'incarnation-1',
      seq: 1,
    });
  });

  test('a replyTo naming a /system actor on the consumer\'s node decodes to Nobody (#1572)', async () => {
    const consumerNode = await startNode('reply-to-system', 47_531);
    const peer = await startNode('reply-to-system', 47_532, ['reply-to-system@h:47531']);
    await awaitCondition(() => consumerNode.cluster.upMembers().length === 2, {
      timeoutMs: 4_000,
      intervalMs: 20,
      label: 'the two-node cluster converged',
    });

    const handled: string[] = [];
    const consumer = consumerNode.system.spawn<Delivery<string>>(
      () => new ConsumerController<string>({ handler: (body) => { handled.push(body); } }),
      'consumer',
    );
    // Where the framework's own actors live — a path no peer may name.
    const reached: unknown[] = [];
    const framework = consumerNode.system._spawnSystemActor(
      () => new Recorder(reached),
      'delivery',
      'pretend-producer',
    );

    const consumerSeenFromPeer = new RemoteActorRef(consumerNode.address, consumer.path.toString(), peer.cluster);
    const frameworkSeenFromPeer = new RemoteActorRef(consumerNode.address, framework.path.toString(), peer.cluster);
    consumerSeenFromPeer.tell({
      kind: 'reliable-delivery.delivery',
      producerId: 'written-by-the-peer',
      incarnation: 'incarnation-1',
      seq: 1,
      body: 'from-the-peer',
      replyTo: frameworkSeenFromPeer,
    });

    // The delivery itself is still admitted: only the field is refused.
    await awaitCondition(() => handled.length === 1, {
      timeoutMs: 4_000,
      intervalMs: 20,
      label: 'the delivery was handled',
    });
    // A follow-up through the same actor proves the mailbox has moved past the
    // acknowledgment, so the empty list below is an absence and not a race.
    framework.tell('probe');
    await awaitCondition(() => reached.length === 1, {
      timeoutMs: 4_000,
      intervalMs: 20,
      label: 'the local probe reached the /system actor',
    });
    expect(handled).toEqual(['from-the-peer']);
    expect(reached).toEqual(['probe']);
  });
});
