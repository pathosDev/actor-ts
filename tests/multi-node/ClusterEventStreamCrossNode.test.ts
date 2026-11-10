/**
 * Multi-node test: `cluster.eventStream` fan-out across three nodes — and the
 * node-local scope of `system.eventStream`, bound as a test rather than left
 * as prose (#1397).
 *
 * The third case is the one worth keeping honest about: it asserts that the
 * *local* bus does **not** cross a node boundary.  A claim about what a system
 * does not do is exactly the kind that rots silently, because nothing fails
 * when it stops being true — a future change that quietly made the local
 * stream cluster-wide would break no other test in this repository.
 */
import { describe, expect, test } from 'bun:test';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import { TestProbe } from '../../src/testkit/TestProbe.js';
import { awaitCondition } from '../util/AwaitCondition.js';

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

/** An order, in the `kind`-discriminated form that needs no registration. */
type OrderPlacedEvent = { readonly kind: 'order-placed'; readonly sku: string };

const ORDER: OrderPlacedEvent = { kind: 'order-placed', sku: 'XYZ-1' };

describe('multi-node cluster event stream', () => {
  test('a publish on one node reaches subscribers on every other node', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      const probeB = new TestProbe(spec.systemFor('b'));
      const probeC = new TestProbe(spec.systemFor('c'));

      spec.clusterFor('b').eventStream.subscribe(probeB, 'order-placed');
      spec.clusterFor('c').eventStream.subscribe(probeC, 'order-placed');

      // Republished until both probes hold something, for the same reason
      // `PubSubCrossNode` does it: a publish that lands before A has merged
      // both topic claims is dropped for good, so a fixed settle would be a
      // bet rather than a wait.  Every copy carries the same payload, so a
      // duplicate cannot change what the assertions below read.
      await awaitCondition(
        () => {
          spec.clusterFor('a').eventStream.publish(ORDER);
          return probeB.hasMessage() && probeC.hasMessage();
        },
        {
          timeoutMs: 10_000,
          intervalMs: 50,
          label: 'a publish from A reached the cluster-stream subscribers on B and C',
        },
      );

      await probeB.expectMessage(ORDER, 1_500);
      await probeC.expectMessage(ORDER, 1_500);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 20_000);

  test('a node that did not subscribe stays quiet', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      const probeB = new TestProbe(spec.systemFor('b'));
      const probeC = new TestProbe(spec.systemFor('c'));

      // Only B subscribes.  C stands up its stream all the same, so what the
      // assertion proves is that C was not delivered to — not merely that C
      // had no machinery to be delivered through.
      spec.clusterFor('b').eventStream.subscribe(probeB, 'order-placed');
      spec.clusterFor('c').eventStream.subscribe(probeC, 'something-else');

      await awaitCondition(
        () => {
          spec.clusterFor('a').eventStream.publish(ORDER);
          return probeB.hasMessage();
        },
        {
          timeoutMs: 10_000,
          intervalMs: 50,
          label: 'a publish from A reached the cluster-stream subscriber on B',
        },
      );

      await probeB.expectMessage(ORDER, 1_500);
      await probeC.expectNoMessage(500);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 20_000);

  test('the node-local event stream does not cross a node boundary', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      const probeA = new TestProbe(spec.systemFor('a'));
      const probeB = new TestProbe(spec.systemFor('b'));
      const probeC = new TestProbe(spec.systemFor('c'));

      spec.systemFor('a').eventStream.subscribe(probeA, 'order-placed');
      spec.systemFor('b').eventStream.subscribe(probeB, 'order-placed');
      spec.systemFor('c').eventStream.subscribe(probeC, 'order-placed');

      spec.systemFor('a').eventStream.publish(ORDER);

      // The publishing node's own subscriber gets it synchronously — which is
      // what makes the two silences below mean "not delivered" rather than
      // "not published yet".
      await probeA.expectMessage(ORDER, 1_500);
      await probeB.expectNoMessage(500);
      await probeC.expectNoMessage(500);

      // And the cluster bus on B is not a back door into it either: nothing
      // bridges the local stream unless somebody asks for it.
      const bridged = new TestProbe(spec.systemFor('b'));
      spec.clusterFor('b').eventStream.subscribe(bridged, 'order-placed');
      spec.systemFor('a').eventStream.publish(ORDER);
      await bridged.expectNoMessage(500);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 20_000);

  test('bridge carries a locally published event across nodes', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      const localA = new TestProbe(spec.systemFor('a'));
      const probeB = new TestProbe(spec.systemFor('b'));

      spec.systemFor('a').eventStream.subscribe(localA, 'order-placed');
      spec.clusterFor('b').eventStream.subscribe(probeB, 'order-placed');
      spec.clusterFor('a').eventStream.bridge('order-placed');

      await awaitCondition(
        () => {
          spec.systemFor('a').eventStream.publish(ORDER);
          return probeB.hasMessage();
        },
        {
          timeoutMs: 10_000,
          intervalMs: 50,
          label: 'a bridged local publish on A reached the cluster subscriber on B',
        },
      );

      await probeB.expectMessage(ORDER, 1_500);
      // The bridge mirrors; it does not divert.  A's own local subscriber is
      // still served, which is the property that lets an existing deployment
      // turn one on without auditing what already listens.
      expect(localA.hasMessage()).toBe(true);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 20_000);
});
