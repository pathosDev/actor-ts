/**
 * Scenario 14 — Bounded mailbox + drop-head + metric verification (#310).
 *
 * The default mailbox shipped with #310 is `BoundedMailbox(10_000,
 * 'drop-head')`.  When an actor's mailbox fills up, the OLDEST
 * messages get evicted to make room for the new ones, and the
 * `actor_mailbox_dropped_total` counter ticks for each eviction.
 *
 * Test sequence:
 *
 *   1. Snapshot the baseline `actor_mailbox_dropped_total` total
 *      on the target node (may be > 0 from earlier-suite noise).
 *   2. POST /test/backpressure/bombard?n=15000&sleepMs=50 — sends
 *      15 000 messages to a deliberately-slow actor whose default
 *      mailbox holds at most 10 000.  At least 5 000 should be
 *      dropped (the overflow).
 *   3. After a brief pause (so the metric has fully updated),
 *      GET /test/backpressure/dropped → verify the total grew by
 *      at least 4 500 (we allow a 10% headroom for any in-flight
 *      drain that happened before the burst finished).
 *
 * Acceptance: drops occurred AND were counted by the metric.
 * Catches:
 *   - A regression that broke the `BoundedMailbox.onDrop` callback
 *     wiring in `ActorCell` — dropped count would stay zero.
 *   - A regression that broke the metric registry — bombard would
 *     work but the metric line would be missing.
 *   - A regression that switched the default back to unbounded —
 *     no drops would happen because the mailbox would just grow.
 */

import { clusterLiveNodes, sleep, type Scenario } from './types.js';

interface DroppedResponse {
  readonly total: number;
  readonly lines: ReadonlyArray<string>;
}

async function getDropped(host: string, controlPort: number): Promise<DroppedResponse> {
  const res = await fetch(`http://${host}:${controlPort}/test/backpressure/dropped`);
  if (!res.ok) throw new Error(`/test/backpressure/dropped on ${host} → ${res.status}`);
  return await res.json() as DroppedResponse;
}

async function bombard(host: string, controlPort: number, n: number, sleepMs: number): Promise<void> {
  const res = await fetch(
    `http://${host}:${controlPort}/test/backpressure/bombard?n=${n}&sleepMs=${sleepMs}`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`/test/backpressure/bombard on ${host} → ${res.status}: ${await res.text()}`);
}

export const scenario: Scenario = {
  name: '14-backpressure',
  async run(ctx) {
    const live = await clusterLiveNodes(ctx.nodes, ctx.controlPort);
    if (live.length === 0) {
      console.log('[14] skipping — no live cluster nodes');
      return;
    }
    const target = live[0]!;

    const baseline = await getDropped(target, ctx.controlPort);
    console.log(`[14] baseline actor_mailbox_dropped_total on ${target} = ${baseline.total}`);

    const SEND = 15_000;
    const OVERFLOW = SEND - 10_000;   // default mailbox capacity from #310 = 10_000
    console.log(`[14] bombarding ${target} with ${SEND} messages → expect ~${OVERFLOW} drops...`);
    await bombard(target, ctx.controlPort, SEND, 50);

    // Drops happen synchronously inside `enqueue()`, but the
    // metrics counter increments inside the noop / promclient
    // adapter which may batch.  Give it a moment to settle.
    await sleep(500);

    const after = await getDropped(target, ctx.controlPort);
    const delta = after.total - baseline.total;
    console.log(`[14] post-bombard actor_mailbox_dropped_total = ${after.total} (delta=${delta})`);
    console.log(`[14] dropped-metric lines visible: ${after.lines.length}`);
    for (const line of after.lines.slice(-3)) {
      console.log(`[14]   ${line}`);
    }

    // Threshold: 4_500 = 90% of expected 5_000.  A regression to
    // unbounded would yield delta=0; we want a strong signal.
    const MIN_EXPECTED = Math.floor(OVERFLOW * 0.9);
    if (delta < MIN_EXPECTED) {
      throw new Error(
        `[14] expected at least ${MIN_EXPECTED} drops, observed ${delta}.  `
        + `Likely regression: default mailbox is no longer bounded, OR `
        + `BoundedMailbox.onDrop callback is no longer wired to the metric.`,
      );
    }
    if (after.lines.length === 0) {
      throw new Error(
        '[14] no `actor_mailbox_dropped_total{...}` lines emitted by /metrics — '
        + 'metric not registered with labels (class/path/reason).',
      );
    }
    console.log(`[14] verified: ${delta} drops counted via the metric, with labels intact`);
  },
};
