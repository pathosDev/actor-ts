/**
 * Scenario 14 — mailbox overflow accounting, in both directions (#313, #1148).
 *
 * What this scenario is really for is the chain
 * `BoundedMailbox.onDrop` -> `actor_mailbox_dropped_total` -> `/metrics`,
 * with its `{class, path, reason}` labels intact.  That chain survived
 * #1148; only its trigger moved, from the default mailbox to an explicit
 * `withMailboxCapacity(...)`.
 *
 * So the scenario now asserts two things that used to be one:
 *
 *   1. A sink spawned with an explicit 10 000 bound still drops, and the
 *      drops still reach the metric with labels.  A burst of 15 000 should
 *      overflow by ~5 000; the threshold allows 10 % headroom for whatever
 *      drained mid-burst.
 *   2. A sink on the DEFAULT mailbox drops exactly nothing, no matter how
 *      far past the old ceiling the burst goes.  This is the #1148 property,
 *      and it is the half a unit test cannot cover convincingly — it needs a
 *      real node, a real dispatcher and the real metrics endpoint.
 *
 * Catches:
 *   - `BoundedMailbox.onDrop` no longer wired in `ActorCell` — half 1 reads
 *     zero drops.
 *   - The metric registry or the exporter breaking — half 1 sees no lines.
 *   - The default silently going bounded again — half 2 sees drops, which
 *     is #310 coming back by accident.
 *   - `withMailboxCapacity` silently ceasing to bound — half 1 reads zero.
 */

import { clusterLiveNodes, sleep, type Scenario } from './types.js';

type DroppedResponse = {
  readonly total: number;
  readonly lines: ReadonlyArray<string>;
};

type SinkMailbox = 'bounded' | 'default';

async function getDropped(host: string, controlPort: number): Promise<DroppedResponse> {
  const response = await fetch(`http://${host}:${controlPort}/test/backpressure/dropped`);
  if (!response.ok) throw new Error(`/test/backpressure/dropped on ${host} → ${response.status}`);
  return await response.json() as DroppedResponse;
}

async function bombard(
  host: string,
  controlPort: number,
  n: number,
  sleepMs: number,
  mailbox: SinkMailbox,
): Promise<void> {
  const response = await fetch(
    `http://${host}:${controlPort}/test/backpressure/bombard?n=${n}&sleepMs=${sleepMs}&mailbox=${mailbox}`,
    { method: 'POST' },
  );
  if (!response.ok) throw new Error(`/test/backpressure/bombard on ${host} → ${response.status}: ${await response.text()}`);
}

/** Drops attributable to one burst — baseline taken immediately before it. */
async function dropsFrom(
  host: string,
  controlPort: number,
  n: number,
  mailbox: SinkMailbox,
): Promise<{ delta: number; lines: ReadonlyArray<string> }> {
  const baseline = await getDropped(host, controlPort);
  await bombard(host, controlPort, n, 50, mailbox);
  // Drops happen synchronously inside `enqueue()`, but the counter
  // increments inside the noop / promclient adapter, which may batch.
  await sleep(500);
  const after = await getDropped(host, controlPort);
  return { delta: after.total - baseline.total, lines: after.lines };
}

export const scenario: Scenario = {
  name: '14-backpressure',
  async run(context) {
    const live = await clusterLiveNodes(context.nodes, context.controlPort);
    if (live.length === 0) {
      console.log('[14] skipping — no live cluster nodes');
      return;
    }
    const target = live[0]!;

    const SEND = 15_000;
    const CAPACITY = 10_000;          // the bounded sink's explicit capacity
    const OVERFLOW = SEND - CAPACITY;

    // ---- 1. an explicitly bounded mailbox still drops, and still counts ----

    console.log(`[14] bombarding ${target} (bounded sink) with ${SEND} → expect ~${OVERFLOW} drops...`);
    const bounded = await dropsFrom(target, context.controlPort, SEND, 'bounded');
    console.log(`[14] bounded sink: delta=${bounded.delta}, metric lines=${bounded.lines.length}`);
    for (const line of bounded.lines.slice(-3)) console.log(`[14]   ${line}`);

    const MIN_EXPECTED = Math.floor(OVERFLOW * 0.9);
    if (bounded.delta < MIN_EXPECTED) {
      throw new Error(
        `[14] expected at least ${MIN_EXPECTED} drops from the bounded sink, observed ${bounded.delta}.  `
        + 'Likely regression: withMailboxCapacity no longer bounds the mailbox, OR '
        + 'the BoundedMailbox.onDrop callback is no longer wired to the metric.',
      );
    }
    if (bounded.lines.length === 0) {
      throw new Error(
        '[14] no `actor_mailbox_dropped_total{...}` lines emitted by /metrics — '
        + 'metric not registered with labels (class/path/reason).',
      );
    }

    // ---- 2. the default mailbox drops nothing, however far past the ceiling ----

    console.log(`[14] bombarding ${target} (default sink) with ${SEND} → expect 0 drops...`);
    const dflt = await dropsFrom(target, context.controlPort, SEND, 'default');
    console.log(`[14] default sink: delta=${dflt.delta}`);

    if (dflt.delta !== 0) {
      throw new Error(
        `[14] the default mailbox dropped ${dflt.delta} messages; it must drop none.  `
        + 'Likely regression: the default mailbox is bounded again — #1148 made it '
        + 'unbounded, and #310 is not coming back by accident.',
      );
    }

    console.log(
      `[14] verified: ${bounded.delta} drops counted with labels intact on the bounded sink, `
      + 'and none at all on the default one',
    );
  },
};
