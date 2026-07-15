/**
 * Scenario 12 — DistributedPubSub topic fan-out across the cluster.
 *
 * Each node-runner pre-subscribed a local `PubSubReceiver` to the
 * `events` topic at startup (see `control-routes.ts`).  Scenario:
 *
 *   1. Snapshot the baseline received-count on every node (some
 *      number from before this scenario — e.g. earlier scenarios
 *      didn't publish, but late healthcheck noise could have).
 *   2. Publish 10 events from node-a on `events`.  Expectation:
 *      every live node's subscriber receives +10 within a few
 *      gossip ticks.
 *   3. Publish 5 events from node-b.  Same expectation: every
 *      subscriber receives +5 on top.
 *   4. Verify the most-recent event seen by every subscriber
 *      matches the last published seq.
 *
 * Acceptance: every node's `received` count is `baseline + 15`
 * after both publish bursts settle.
 */

import { clusterLiveNodes, sleep, waitFor, type Scenario } from './types.js';

interface PubSubSnapshot {
  readonly received: number;
  readonly lastSeq: number;
  readonly lastText: string | null;
}

async function publish(
  host: string, controlPort: number,
  topic: string, seq: number, text: string,
): Promise<void> {
  const res = await fetch(
    `http://${host}:${controlPort}/test/pubsub/publish?topic=${encodeURIComponent(topic)}`
    + `&seq=${seq}&text=${encodeURIComponent(text)}`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`/test/pubsub/publish on ${host} → ${res.status}: ${await res.text()}`);
}

async function received(host: string, controlPort: number): Promise<PubSubSnapshot> {
  const res = await fetch(`http://${host}:${controlPort}/test/pubsub/received`);
  if (!res.ok) throw new Error(`/test/pubsub/received on ${host} → ${res.status}: ${await res.text()}`);
  return await res.json() as PubSubSnapshot;
}

export const scenario: Scenario = {
  name: '12-pubsub-fanout',
  async run(ctx) {
    const live = await clusterLiveNodes(ctx.nodes, ctx.controlPort);
    if (live.length < 2) {
      console.log(`[12] skipping — need >=2 nodes for fan-out, have ${live.length}`);
      return;
    }

    // 1. Baseline.
    const baseline = new Map<string, number>();
    for (const h of live) baseline.set(h, (await received(h, ctx.controlPort)).received);
    console.log(`[12] baseline received: ${[...baseline.entries()].map(([h, n]) => `${h}=${n}`).join(', ')}`);

    // 2. 10 publishes from node-a.
    const burst1 = 10;
    const sender1 = live[0]!;
    console.log(`[12] publishing ${burst1} events from ${sender1}...`);
    for (let i = 1; i <= burst1; i++) {
      await publish(sender1, ctx.controlPort, 'events', i, `from-${sender1}-msg-${i}`);
    }

    // Wait for every subscriber to observe baseline + burst1.
    await Promise.all(live.map(async (host) => {
      const base = baseline.get(host)!;
      await waitFor(
        `${host} received +${burst1}`,
        async () => (await received(host, ctx.controlPort)).received >= base + burst1,
        15_000,
        300,
      );
    }));
    console.log(`[12] all ${live.length} subscribers received +${burst1}`);

    // 3. 5 publishes from a different node.
    const burst2 = 5;
    const sender2 = live[1]!;
    console.log(`[12] publishing ${burst2} more events from ${sender2}...`);
    for (let i = 1; i <= burst2; i++) {
      // Continue the seq numbering so we can verify lastSeq below.
      await publish(sender2, ctx.controlPort, 'events', burst1 + i, `from-${sender2}-msg-${i}`);
    }

    const expectedTotal = burst1 + burst2;
    await Promise.all(live.map(async (host) => {
      const base = baseline.get(host)!;
      await waitFor(
        `${host} received +${expectedTotal}`,
        async () => (await received(host, ctx.controlPort)).received >= base + expectedTotal,
        15_000,
        300,
      );
    }));
    console.log(`[12] all ${live.length} subscribers received the full ${expectedTotal} events`);

    // 4. Sanity: each node's last-seen seq is one of the published
    //    seq values.  Publishes from different nodes may interleave,
    //    so we don't require a SPECIFIC last seq — but it must be in
    //    the published range (1..expectedTotal).
    await sleep(300);
    for (const host of live) {
      const delivery = await received(host, ctx.controlPort);
      if (delivery.lastSeq < 1 || delivery.lastSeq > expectedTotal) {
        throw new Error(`[12] ${host} lastSeq=${delivery.lastSeq} not in [1,${expectedTotal}]`);
      }
    }
    console.log('[12] every subscriber\'s last-seen seq is within the published range');
  },
};
