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
  SubscribeAcknowledgment,
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

/**
 * A pub/sub gossip interval longer than the case that uses it can run, so
 * nothing it observes is owed to the periodic anti-entropy round.  The
 * membership gossip stays fast — it is the mediator, not the cluster, whose
 * timing is under test.
 */
const NO_ANTI_ENTROPY_MS = 600_000;

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

  /**
   * #1193 — the mediator that starts *last* used to hear from nobody.
   *
   * The two cases above start every mediator before any of them subscribes,
   * which happens to be the one order the old code converged in.  A node
   * under `tests/integration/` does the opposite: it joins its cluster in its
   * startup path and only afterwards starts the extension that registers the
   * pub/sub wire hook.  Each mediator therefore announced itself to peers that
   * were not yet listening, and a frame `Cluster` cannot route is dropped
   * without a trace — so the one that started first collected everybody and
   * the one that started last collected nobody.  A broadcast from the latter
   * reached only its own subscriber.
   *
   * That is the asymmetry `12-pubsub-fanout` reported: its first burst is
   * published from the node listed first and always arrived, its second from
   * the next one along and stalled on one subscriber at a time.  The scenario
   * then waits 15 s, which is fifteen anti-entropy rounds — enough that the
   * gap usually closed, and did not on roughly one hosted run in four.
   *
   * Publishing from the *last* mediator is what makes this an assertion
   * rather than a sample: that is the node with the empty registry every
   * time, instead of whichever one a container start-up race produced.
   */
  test('a publish from the mediator that started last reaches the earlier ones (#1193)', async () => {
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
        .withGossipIntervalMs(NO_ANTI_ENTROPY_MS);
      const probeA = new TestProbe(spec.systemFor('a'));
      const probeB = new TestProbe(spec.systemFor('b'));
      const probeC = new TestProbe(spec.systemFor('c'));

      // Strictly one at a time: each mediator is subscribed and has said so
      // before the next one exists.  Awaiting the acknowledgment is what
      // makes the order an order rather than three calls in a row.
      const medA = spec.systemFor('a').extension(DistributedPubSubId)
        .start(spec.clusterFor('a'), pubsubOptions);
      medA.tell(new Subscribe('orders', probeA, probeA));
      await probeA.expectMessageType(SubscribeAcknowledgment, 2_000);

      const medB = spec.systemFor('b').extension(DistributedPubSubId)
        .start(spec.clusterFor('b'), pubsubOptions);
      medB.tell(new Subscribe('orders', probeB, probeB));
      await probeB.expectMessageType(SubscribeAcknowledgment, 2_000);

      const medC = spec.systemFor('c').extension(DistributedPubSubId)
        .start(spec.clusterFor('c'), pubsubOptions);
      medC.tell(new Subscribe('orders', probeC, probeC));
      await probeC.expectMessageType(SubscribeAcknowledgment, 2_000);

      // Republish while waiting, for the reason the first case in this file
      // gives: a publish that lands before the registry has merged is dropped
      // for good.  It cannot mask the defect — at a 600 s gossip interval the
      // old code had no path that ever filled C's registry, so no number of
      // publishes would have arrived.
      await awaitCondition(
        () => {
          medC.tell(new Publish('orders', { sku: 'XYZ-1' }));
          return probeA.hasMessage() && probeB.hasMessage();
        },
        {
          timeoutMs: 10_000,
          intervalMs: 50,
          label: 'a publish from the last-started mediator reached A and B',
        },
      );

      await probeA.expectMessage({ sku: 'XYZ-1' }, 1_500);
      await probeB.expectMessage({ sku: 'XYZ-1' }, 1_500);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);
});
