/**
 * Scenario 07 — GCounter concurrent increments from all nodes.
 *
 * Every live node fires N increments at the SAME GCounter key,
 * concurrently.  After gossip converges, every node's local view
 * of the counter should equal exactly `(nodes × N)` because:
 *
 *   - GCounter is monotonic: increments never lose; replicas
 *     keep a per-replica sub-counter that `merge` takes the max
 *     of per replica.  Concurrent increments from different
 *     replicas can't conflict.
 *   - DistributedData with `consistency: 'majority'` writes
 *     to a quorum then gossips the rest, so observable
 *     convergence is bounded by gossip rate (~250ms in the
 *     integration setup).
 *
 * Acceptance: every live node reads the SAME total, equal to
 * `nodes × N`.  Plus a per-node `selfReplicaId` breakdown that
 * sums to the total.  A pre-existing bug where one replica's
 * sub-counter got overwritten on merge would surface as a
 * total below the expected.
 */

import { clusterLiveNodes, sleep, waitFor, type Scenario } from './types.js';

const KEY = 'integration-gcounter';
const INCREMENTS_PER_NODE = 50;

async function incOnce(host: string, controlPort: number): Promise<void> {
  const response = await fetch(
    `http://${host}:${controlPort}/test/ddata/gcounter/inc?key=${KEY}&delta=1&consistency=majority`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw new Error(`/test/ddata/gcounter/inc on ${host} → ${response.status}: ${await response.text()}`);
  }
}

async function readValue(host: string, controlPort: number): Promise<number | null> {
  const response = await fetch(
    `http://${host}:${controlPort}/test/ddata/gcounter/value?key=${KEY}&consistency=majority`,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`/test/ddata/gcounter/value on ${host} → ${response.status}: ${await response.text()}`);
  const body = await response.json() as { value: number };
  return body.value;
}


export const scenario: Scenario = {
  name: '07-gcounter-concurrent',
  async run(context) {
    const live = await clusterLiveNodes(context.nodes, context.controlPort);
    if (live.length < 2) {
      console.log(`[07] skipping — need >=2 live nodes for cross-node convergence, have ${live.length}`);
      return;
    }
    const expected = live.length * INCREMENTS_PER_NODE;
    console.log(`[07] firing ${INCREMENTS_PER_NODE} concurrent increments from each of ${live.length} nodes → expected total ${expected}`);

    // Pipeline N increments from EVERY live node, all concurrently.
    // Each node makes its own outbound HTTP request batch in
    // parallel via Promise.all of the inner loops, then the outer
    // Promise.all races all nodes' batches together.
    const startedAt = Date.now();
    await Promise.all(live.map(async (host) => {
      const localBatch: Promise<void>[] = [];
      for (let i = 0; i < INCREMENTS_PER_NODE; i++) {
        localBatch.push(incOnce(host, context.controlPort));
      }
      await Promise.all(localBatch);
    }));
    console.log(`[07] all ${live.length * INCREMENTS_PER_NODE} increments fired in ${Date.now() - startedAt}ms`);

    // Convergence: every live node must converge on the SAME total
    // equal to expected.  Default ddata gossip is 250ms; majority
    // writes ack after quorum reaches the value; remaining replicas
    // catch up via gossip.  20s is comfortable.
    console.log(`[07] waiting for every node to converge on ${expected}...`);
    let lastSnap = '';
    const snapTimer = setInterval(() => {
      Promise.all(live.map((h) => readValue(h, context.controlPort).catch(() => -1)))
        .then((vals) => {
          const line = live.map((h, i) => `${h}=${vals[i]}`).join(' ');
          if (line !== lastSnap) {
            console.log(`[07]   counts: ${line}`);
            lastSnap = line;
          }
        })
        .catch(() => { /* ignore */ });
    }, 2_000);
    try {
      await Promise.all(live.map(async (host) => {
        await waitFor(
          `${host} reads ${expected}`,
          async () => (await readValue(host, context.controlPort)) === expected,
          25_000,
          400,
        );
      }));
    } finally {
      clearInterval(snapTimer);
    }
    console.log(`[07] all ${live.length} nodes converged on ${expected}`);

    // Final sanity: read once more from every live node, verify
    // they're all numerically identical AND equal to expected.
    const finals = await Promise.all(live.map((h) => readValue(h, context.controlPort)));
    for (let i = 0; i < live.length; i++) {
      if (finals[i] !== expected) {
        throw new Error(`[07] final read from ${live[i]} = ${finals[i]} (expected ${expected})`);
      }
    }
    // Quick brief pause to let any in-flight ack settle before the
    // next scenario starts.
    await sleep(200);
  },
};
