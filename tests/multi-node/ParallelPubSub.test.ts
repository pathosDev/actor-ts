/**
 * End-to-end test for `ParallelMultiNodeSpec` using a real actor
 * scenario — proves the harness can drive worker-thread cluster
 * tests with the same shape as the in-process variant.
 *
 * Uses the `ParallelPubSubScenario.ts` module: each worker hosts
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
import { awaitCondition, sleep } from '../util/AwaitCondition.js';

// Quarantined on GitHub's hosted runners (ACTOR_TS_SKIP_FLAKY_MNS=1) —
// Bun there cannot respawn functional worker threads after the first
// worker-thread test (workers spawn + handshake, then never run);
// reproducible only on the hosted runners.  Runs locally + in Docker.
// #538 tracks the quarantine: `.github/workflows/nightly-flakes.yml` runs
// this suite nightly with the flag OFF, and 14 consecutive green nights are
// what removes this line.
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
      scenarioModule: new URL('./internal/ParallelPubSubScenario.ts', import.meta.url),
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
      await sleep(500);

      // Publish from a.
      await spec.runIn('a', 'publish', { topic: 'orders', message: { sku: 'XYZ-1' } });

      // Poll `buffered`, which counts without consuming, then drain once.
      // Polling `drain` — as this loop used to — is destructive: the round in
      // which b had the message and c did not *emptied b's probe*, and every
      // later round then read b as empty, so the loop could only ever succeed
      // when both messages happened to land inside one 80 ms window.
      //
      // `>= 1` rather than `=== 1` on purpose (#418): exactly one publish
      // happens, so the drain below still binds the count — but a poll that
      // demanded the exact number would return on the arrival that reaches it
      // and could never have seen a surplus.
      await awaitCondition(
        async () => await spec.runIn<number>('b', 'buffered', { topic: 'orders' }) >= 1
          && await spec.runIn<number>('c', 'buffered', { topic: 'orders' }) >= 1,
        { timeoutMs: 3_000, intervalMs: 80, label: 'both subscribers buffered the published message' },
      );
      const bMessages = await spec.runIn<unknown[]>('b', 'drain', { topic: 'orders' });
      const cMessages = await spec.runIn<unknown[]>('c', 'drain', { topic: 'orders' });
      expect(bMessages).toEqual([{ sku: 'XYZ-1' }]);
      expect(cMessages).toEqual([{ sku: 'XYZ-1' }]);
    } finally {
      await spec.stop();
    }
  }, 60_000);
});
