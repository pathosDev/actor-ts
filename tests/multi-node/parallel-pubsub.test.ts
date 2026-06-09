/**
 * End-to-end test for `ParallelMultiNodeSpec` using a real actor
 * scenario — proves the harness can drive worker-thread cluster
 * tests with the same shape as the in-process variant.
 *
 * Uses the `parallel-pubsub-scenario.ts` module: each worker hosts
 * a `DistributedPubSub` mediator + a per-topic `TestProbe`.  The
 * harness drives `subscribe` / `publish` / `drain` via `runIn`.
 *
 * This is the worker-thread analogue of
 * `tests/multi-node/pubsub-cross-node.test.ts` — the in-process
 * test stays as the canonical reference; this one proves the
 * worker-thread harness reaches the same semantics with real OS
 * threads in play.
 */
import { describe, expect, test } from 'bun:test';
import { ParallelMultiNodeSpec } from '../../src/testkit/ParallelMultiNodeSpec.js';

// Quarantined on GitHub's hosted runners (ACTOR_TS_SKIP_FLAKY_MNS=1) —
// Bun there cannot respawn functional worker threads after the first
// worker-thread test (workers spawn + handshake, then never run);
// reproducible only on the hosted runners.  Runs locally + in Docker.
// See the [CI] tracking issue.
const describeMns = process.env.ACTOR_TS_SKIP_FLAKY_MNS === '1' ? describe.skip : describe;

const TIGHT_FD = {
  heartbeatIntervalMs: 100,
  unreachableAfterMs: 500,
  downAfterMs: 5_000,
} as const;

describeMns('ParallelMultiNodeSpec — DistributedPubSub e2e', () => {
  test('publish from a reaches subscribers on b and c, across worker threads', async () => {
    const spec = new ParallelMultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 100,
      scenarioModule: new URL('./internal/parallel-pubsub-scenario.ts', import.meta.url),
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      // Subscribe on b and c.
      await spec.runIn('b', 'subscribe', { topic: 'orders' });
      await spec.runIn('c', 'subscribe', { topic: 'orders' });

      // PubSub gossip needs ~2 rounds to propagate the subscriptions
      // across all three mediators.  At 100 ms gossip × 5 rounds we
      // have 99% confidence the subscriber-set is stable.
      await Bun.sleep(500);

      // Publish from a.
      await spec.runIn('a', 'publish', { topic: 'orders', message: { sku: 'XYZ-1' } });

      // Drain probes — each side should have received the published
      // message.
      const deadline = Date.now() + 3_000;
      let bMsgs: unknown[] = [];
      let cMsgs: unknown[] = [];
      while (Date.now() < deadline) {
        bMsgs = await spec.runIn<unknown[]>('b', 'drain', { topic: 'orders' });
        cMsgs = await spec.runIn<unknown[]>('c', 'drain', { topic: 'orders' });
        if (bMsgs.length > 0 && cMsgs.length > 0) break;
        await Bun.sleep(80);
      }
      expect(bMsgs).toEqual([{ sku: 'XYZ-1' }]);
      expect(cMsgs).toEqual([{ sku: 'XYZ-1' }]);
    } finally {
      await spec.stop();
    }
  }, 60_000);
});
