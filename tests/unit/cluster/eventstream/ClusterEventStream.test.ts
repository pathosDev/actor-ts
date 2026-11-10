import { afterEach, describe, expect, test } from 'bun:test';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { EventKey } from '../../../../src/EventKey.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { ActorRestarted } from '../../../../src/SystemMessages.js';
import { TestKit } from '../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../src/testkit/TestKitOptions.js';

/**
 * #1397 — `cluster.eventStream`, the cluster-wide counterpart to
 * `system.eventStream`.
 *
 * These cases run on a **single** node, and that is not a weaker version of
 * the cross-node test: a locally published event takes the same path as a
 * peer's, through the mediator's mailbox and back out of the receiver, so
 * everything except the wire hop is exercised here.  The hop itself is
 * `tests/multi-node/ClusterEventStreamCrossNode.test.ts`, which is also where
 * the node-local scope of `system.eventStream` is bound.
 */

type OrderPlacedEvent = { readonly kind: 'order-placed'; readonly sku: string };

const OrderPlacedKey = EventKey.of<OrderPlacedEvent>('order-placed');

/** A class channel — the form that cannot cross the wire without a name. */
class ShipmentEvent {
  constructor(public readonly trackingId: string) {}
  static fromJSON(body: Record<string, unknown>): ShipmentEvent {
    return new ShipmentEvent(String(body.trackingId));
  }
}

/** A subclass, to pin that subscribing to a base collects its registrations. */
class ExpressShipmentEvent extends ShipmentEvent {
  constructor(trackingId: string, public readonly hours: number) { super(trackingId); }
  static override fromJSON(body: Record<string, unknown>): ExpressShipmentEvent {
    return new ExpressShipmentEvent(String(body.trackingId), Number(body.hours));
  }
}

/** A class with neither a decoder argument nor a static `fromJSON`. */
class UndecodableEvent { constructor(public readonly value: string) {} }

type Node = { readonly kit: TestKit; readonly cluster: Cluster };

let started: Node[] = [];

async function startNode(systemName: string, port: number): Promise<Node> {
  const kit = TestKit.create(
    systemName,
    TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
  );
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  const node = { kit, cluster };
  started.push(node);
  return node;
}

afterEach(async () => {
  for (const node of started) {
    await node.cluster.leave();
    await node.kit.system.terminate();
  }
  started = [];
});

describe('ClusterEventStream', () => {
  describe('kind channels', () => {
    test('round-trip without any registration', async () => {
      const node = await startNode('ces-kind', 42_101);
      const probe = node.kit.createTestProbe();

      node.cluster.eventStream.subscribe(probe, 'order-placed');
      node.cluster.eventStream.publish({ kind: 'order-placed', sku: 'XYZ-1' });

      expect(await probe.receiveOne(2_000)).toEqual({ kind: 'order-placed', sku: 'XYZ-1' });
    });

    test('an EventKey names the same channel as its bare string', async () => {
      const node = await startNode('ces-key', 42_102);
      const probe = node.kit.createTestProbe();

      node.cluster.eventStream.subscribe(probe, OrderPlacedKey);
      node.cluster.eventStream.publish({ kind: 'order-placed', sku: 'KEY-1' });

      expect(await probe.receiveOne(2_000)).toEqual({ kind: 'order-placed', sku: 'KEY-1' });
    });

    test('a predicate filters before delivery', async () => {
      const node = await startNode('ces-predicate', 42_103);
      const probe = node.kit.createTestProbe();

      node.cluster.eventStream.subscribe<OrderPlacedEvent>(
        probe, 'order-placed', (event) => event.sku.startsWith('KEEP'),
      );
      node.cluster.eventStream.publish({ kind: 'order-placed', sku: 'DROP-1' });
      node.cluster.eventStream.publish({ kind: 'order-placed', sku: 'KEEP-1' });

      expect(await probe.receiveOne(2_000)).toEqual({ kind: 'order-placed', sku: 'KEEP-1' });
    });

    test('unsubscribe stops delivery', async () => {
      const node = await startNode('ces-unsub', 42_104);
      const probe = node.kit.createTestProbe();

      node.cluster.eventStream.subscribe(probe, 'order-placed');
      node.cluster.eventStream.publish({ kind: 'order-placed', sku: 'FIRST' });
      expect(await probe.receiveOne(2_000)).toEqual({ kind: 'order-placed', sku: 'FIRST' });

      expect(node.cluster.eventStream.unsubscribe(probe, 'order-placed')).toBe(true);
      node.cluster.eventStream.publish({ kind: 'order-placed', sku: 'SECOND' });
      await probe.expectNoMessage(300);
    });
  });

  describe('class channels', () => {
    test('a registered class round-trips and keeps its identity locally', async () => {
      const node = await startNode('ces-class', 42_105);
      const probe = node.kit.createTestProbe();

      node.cluster.eventStream.register('ShipmentEvent', ShipmentEvent);
      node.cluster.eventStream.subscribe(probe, ShipmentEvent);
      node.cluster.eventStream.publish(new ShipmentEvent('TRK-1'));

      const received = await probe.receiveOne(2_000);
      expect(received).toBeInstanceOf(ShipmentEvent);
      expect((received as ShipmentEvent).trackingId).toBe('TRK-1');
    });

    test('subscribing to a base class collects its registered subclasses', async () => {
      const node = await startNode('ces-subclass', 42_106);
      const probe = node.kit.createTestProbe();

      node.cluster.eventStream.register('ExpressShipmentEvent', ExpressShipmentEvent);
      node.cluster.eventStream.subscribe(probe, ShipmentEvent);
      node.cluster.eventStream.publish(new ExpressShipmentEvent('TRK-2', 12));

      const received = await probe.receiveOne(2_000);
      expect(received).toBeInstanceOf(ExpressShipmentEvent);
      expect((received as ExpressShipmentEvent).hours).toBe(12);
    });

    test('subscribing to a class with nothing registered names the remedy', async () => {
      const node = await startNode('ces-unregistered-sub', 42_107);
      const probe = node.kit.createTestProbe();

      expect(() => node.cluster.eventStream.subscribe(probe, ShipmentEvent))
        .toThrow(/ShipmentEvent has nothing registered under it/);
    });

    test('publishing an unregistered, kind-less event names both remedies', async () => {
      const node = await startNode('ces-unregistered-pub', 42_108);

      expect(() => node.cluster.eventStream.publish(new ShipmentEvent('TRK-3')))
        .toThrow(/neither registered nor kind-tagged/);
    });

    test('a class with no decoder is refused at registration', async () => {
      const node = await startNode('ces-nodecoder', 42_109);

      expect(() => node.cluster.eventStream.register('UndecodableEvent', UndecodableEvent))
        .toThrow(/needs a decoder/);
    });

    test('an explicit decoder satisfies a class without fromJSON', async () => {
      const node = await startNode('ces-decoder', 42_110);

      expect(() => node.cluster.eventStream.register(
        'UndecodableEvent',
        UndecodableEvent,
        (body) => new UndecodableEvent(String(body.value)),
      )).not.toThrow();
    });

    test('re-registering a name for a different class is refused', async () => {
      const node = await startNode('ces-collision', 42_111);

      node.cluster.eventStream.register('Shipment', ShipmentEvent);
      expect(() => node.cluster.eventStream.register('Shipment', ExpressShipmentEvent))
        .toThrow(/already registered for a different class/);
    });

    test('an empty name is refused — it would be the topic', async () => {
      const node = await startNode('ces-emptyname', 42_112);

      expect(() => node.cluster.eventStream.register('', ShipmentEvent))
        .toThrow(/must not be empty/);
    });
  });

  describe('bridge', () => {
    test('mirrors the node-local bus without stealing its delivery', async () => {
      const node = await startNode('ces-bridge', 42_113);
      const localProbe = node.kit.createTestProbe();
      const clusterProbe = node.kit.createTestProbe();

      node.kit.system.eventStream.subscribe(localProbe, 'order-placed');
      node.cluster.eventStream.subscribe(clusterProbe, 'order-placed');
      node.cluster.eventStream.bridge('order-placed');

      node.kit.system.eventStream.publish({ kind: 'order-placed', sku: 'BRIDGED' });

      // The existing local subscriber keeps its synchronous delivery ...
      expect(await localProbe.receiveOne(2_000))
        .toEqual({ kind: 'order-placed', sku: 'BRIDGED' });
      // ... and the cluster bus sees the same event.
      expect(await clusterProbe.receiveOne(2_000))
        .toEqual({ kind: 'order-placed', sku: 'BRIDGED' });
    });

    test('the returned function stops the mirroring', async () => {
      const node = await startNode('ces-unbridge', 42_114);
      const clusterProbe = node.kit.createTestProbe();

      node.cluster.eventStream.subscribe(clusterProbe, 'order-placed');
      const stop = node.cluster.eventStream.bridge('order-placed');

      node.kit.system.eventStream.publish({ kind: 'order-placed', sku: 'ONE' });
      expect(await clusterProbe.receiveOne(2_000)).toEqual({ kind: 'order-placed', sku: 'ONE' });

      stop();
      node.kit.system.eventStream.publish({ kind: 'order-placed', sku: 'TWO' });
      await clusterProbe.expectNoMessage(300);
    });

    test('an unroutable bridged event does not restart the bridge', async () => {
      const node = await startNode('ces-bridge-unroutable', 42_116);
      const clusterProbe = node.kit.createTestProbe();
      const restarts = node.kit.createTestProbe();

      // The assertion is on `ActorRestarted`, not on the next event getting
      // through, and that distinction is the whole test: a restart re-creates
      // the actor behind the *same* ref, so its event-stream subscription
      // survives and the next event arrives either way.  Delivery therefore
      // cannot tell a guarded bridge from an unguarded one; only the restart
      // that a thrown `publish` would provoke can.
      node.kit.system.eventStream.subscribe<ActorRestarted>(
        restarts,
        ActorRestarted,
        (event) => event.actor.path.toString().includes('event-stream-bridge'),
      );

      // Only the base is registered.  Bridging it is legal — something *is*
      // registered under the channel — but the channel also matches the
      // subclass, which has no topic of its own to be published to.
      node.cluster.eventStream.register('ShipmentEvent', ShipmentEvent);
      node.cluster.eventStream.subscribe(clusterProbe, ShipmentEvent);
      node.cluster.eventStream.bridge(ShipmentEvent);

      node.kit.system.eventStream.publish(new ExpressShipmentEvent('TRK-BAD', 3));
      node.kit.system.eventStream.publish(new ShipmentEvent('TRK-GOOD'));

      const received = await clusterProbe.receiveOne(2_000);
      expect(received).toBeInstanceOf(ShipmentEvent);
      expect((received as ShipmentEvent).trackingId).toBe('TRK-GOOD');
      await restarts.expectNoMessage(300);
    });
  });

  describe('the two streams are distinct', () => {
    test('publishing on one is not seen by a subscriber of the other', async () => {
      const node = await startNode('ces-distinct', 42_115);
      const localProbe = node.kit.createTestProbe();
      const clusterProbe = node.kit.createTestProbe();

      node.kit.system.eventStream.subscribe(localProbe, 'order-placed');
      node.cluster.eventStream.subscribe(clusterProbe, 'order-placed');

      node.cluster.eventStream.publish({ kind: 'order-placed', sku: 'CLUSTER-ONLY' });

      expect(await clusterProbe.receiveOne(2_000))
        .toEqual({ kind: 'order-placed', sku: 'CLUSTER-ONLY' });
      await localProbe.expectNoMessage(300);
    });
  });
});
