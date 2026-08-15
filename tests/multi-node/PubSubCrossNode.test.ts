/**
 * Multi-node test: DistributedPubSub fan-out across three nodes.
 *
 * Scenario:
 *   - Spin up roles a, b, c with the harness.
 *   - On node B and node C, subscribe a probe to the same topic.
 *   - From node A, publish.
 *   - Both B's probe and C's probe must receive the message.
 *
 * This is the canonical "PubSub-cross-node" test from the original
 * multi-node-spec spec — and the place where any cluster-wide gossip
 * regression first shows up.
 */
import { describe, expect, test } from 'bun:test';
import {
  DistributedPubSubId,
  DistributedPubSubOptions,
  Publish,
  Subscribe,
} from '../../src/cluster/pubsub/index.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import { TestProbe } from '../../src/testkit/TestProbe.js';
import { awaitCondition } from '../util/AwaitCondition.js';

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

describe('multi-node PubSub', () => {
  test('publish from one node reaches subscribers on every other node', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      // Wait for all three to converge so that pubsub gossip can spread.
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      // Stand up a mediator on each node.  start() is idempotent per cluster.
      const pubsubOptions = DistributedPubSubOptions.create()
        .withGossipIntervalMs(80);
      const medA = spec.systemFor('a').extension(DistributedPubSubId)
        .start(spec.clusterFor('a'), pubsubOptions);
      const medB = spec.systemFor('b').extension(DistributedPubSubId)
        .start(spec.clusterFor('b'), pubsubOptions);
      const medC = spec.systemFor('c').extension(DistributedPubSubId)
        .start(spec.clusterFor('c'), pubsubOptions);

      const probeB = new TestProbe(spec.systemFor('b'));
      const probeC = new TestProbe(spec.systemFor('c'));

      medB.tell(new Subscribe('orders', probeB));
      medC.tell(new Subscribe('orders', probeC));

      // A publish that lands before A has merged *both* subscriptions is
      // dropped for good — nothing retries it — so the 400 ms this replaces
      // was not a settle but a bet, and losing it failed the assertions below
      // as though fan-out were broken.  Republishing until both probes hold a
      // message makes the propagation observable; `expectMessage` then reads
      // the first one, and every copy carries the same payload, so a
      // duplicate cannot change what it sees.
      //
      // A weaker condition was available and rejected: `GetTopics` on A
      // reports the topic as soon as *one* peer's gossip has merged, which is
      // precisely the half-propagated state this is trying to exclude.
      await awaitCondition(
        () => {
          medA.tell(new Publish('orders', { sku: 'XYZ-1' }));
          return probeB.hasMessage() && probeC.hasMessage();
        },
        {
          timeoutMs: 10_000,
          intervalMs: 50,
          label: 'a publish from A reached the subscribers on B and C',
        },
      );

      await probeB.expectMessage({ sku: 'XYZ-1' }, 1_500);
      await probeC.expectMessage({ sku: 'XYZ-1' }, 1_500);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 20_000);

  test('only subscribed nodes receive — non-subscriber stays quiet', async () => {
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

      const pubsubOptions = DistributedPubSubOptions.create()
        .withGossipIntervalMs(80);
      const medA = spec.systemFor('a').extension(DistributedPubSubId)
        .start(spec.clusterFor('a'), pubsubOptions);
      const medB = spec.systemFor('b').extension(DistributedPubSubId)
        .start(spec.clusterFor('b'), pubsubOptions);
      // We deliberately don't start C's pubsub mediator subscribe — we just
      // want to assert that only the explicit subscriber on B fires.
      spec.systemFor('c').extension(DistributedPubSubId)
        .start(spec.clusterFor('c'), pubsubOptions);

      const probeB = new TestProbe(spec.systemFor('b'));
      const probeC = new TestProbe(spec.systemFor('c'));

      medB.tell(new Subscribe('news', probeB));
      // Probe C is *not* subscribed to 'news'.

      // Same republish-until-observed wait as above.  It does not weaken the
      // negative half: C is not subscribed, so no number of publishes on
      // 'news' may reach it, and `expectNoMessage` still says so.
      await awaitCondition(
        () => {
          medA.tell(new Publish('news', 'breaking'));
          return probeB.hasMessage();
        },
        {
          timeoutMs: 10_000,
          intervalMs: 50,
          label: 'a publish from A reached the subscriber on B',
        },
      );

      await probeB.expectMessage('breaking', 1_500);
      await probeC.expectNoMessage(150);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 20_000);
});
