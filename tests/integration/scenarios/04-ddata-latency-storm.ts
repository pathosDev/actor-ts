/**
 * Scenario 04 — DistributedData quorum reads/writes during a 50ms
 * outbound latency storm.
 *
 * Setup:
 *   1. From node-a, write `shared-state: initial` with `majority`.
 *   2. Verify every node can read it back at `majority`.
 *   3. Install 50ms egress delay on every node via `tc netem`.
 *   4. From node-c, write `shared-state: updated` (`majority`).
 *      Verify the write still succeeds (just slower).
 *   5. From node-d, read it back (`majority`).
 *   6. Clear the delay.
 *
 * Acceptance: every operation completes within its timeout (5s) and
 * returns the correct value.  Elapsed time during the storm should
 * be measurably higher than at baseline — we log both for diagnostic
 * purposes but don't assert specific timings (CI variance would make
 * that flaky).
 */

import { sleep, waitFor, type Scenario } from './types.js';

const KEY = 'shared-state';

async function write(
  host: string, controlPort: number,
  key: string, value: string, consistency: string = 'majority',
): Promise<{ elapsedMs: number }> {
  const res = await fetch(
    `http://${host}:${controlPort}/test/ddata/write?key=${encodeURIComponent(key)}`
      + `&value=${encodeURIComponent(value)}&consistency=${consistency}`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`ddata write on ${host} → ${res.status}: ${await res.text()}`);
  return await res.json() as { elapsedMs: number };
}

async function read(
  host: string, controlPort: number,
  key: string, consistency: string = 'majority',
): Promise<{ value: string | null; elapsedMs: number; status: number }> {
  const res = await fetch(
    `http://${host}:${controlPort}/test/ddata/read?key=${encodeURIComponent(key)}&consistency=${consistency}`,
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`ddata read on ${host} → ${res.status}: ${await res.text()}`);
  }
  const body = await res.json() as { value?: string | null; elapsedMs: number };
  return { value: body.value ?? null, elapsedMs: body.elapsedMs, status: res.status };
}

export const scenario: Scenario = {
  name: '04-ddata-quorum-latency-storm',
  async run(ctx) {
    if (ctx.nodes.length < 3) {
      console.log(`[04] skipping — need >=3 nodes for majority, have ${ctx.nodes.length}`);
      return;
    }
    const [nodeA, , nodeC, nodeD] = ctx.nodes;

    // 1. Baseline write from node-a, majority consistency.
    console.log(`[04] writing ${KEY}=initial from ${nodeA} (majority, baseline)...`);
    const baselineWrite = await write(nodeA!, ctx.controlPort, KEY, 'initial', 'majority');
    console.log(`[04] baseline write ack in ${baselineWrite.elapsedMs}ms`);

    // 2. Verify every node sees `initial` via majority read.
    console.log('[04] verifying every node reads "initial" via majority...');
    await Promise.all(ctx.nodes.map(async (h) => {
      await waitFor(
        `${h} reads "initial"`,
        async () => {
          const r = await read(h, ctx.controlPort, KEY, 'majority');
          return r.value === 'initial';
        },
        15_000,
        300,
      );
    }));
    const baselineReadMs: number[] = [];
    for (const h of ctx.nodes) {
      const r = await read(h, ctx.controlPort, KEY, 'majority');
      baselineReadMs.push(r.elapsedMs);
    }
    const baselineAvg = Math.round(baselineReadMs.reduce((a, b) => a + b, 0) / baselineReadMs.length);
    console.log(`[04] baseline majority-read avg: ${baselineAvg}ms`);

    // 3. Install 50ms egress delay on every node.
    console.log('[04] installing 50ms egress delay on every node...');
    const delayCalls = ctx.nodes.map((h) =>
      fetch(`http://${h}:${ctx.controlPort}/test/delay?ms=50`, { method: 'POST' }),
    );
    const delayRes = await Promise.all(delayCalls);
    for (const r of delayRes) if (!r.ok) throw new Error(`[04] delay install failed: ${r.status}`);

    // Let the qdisc settle — tc rules sometimes need a moment to
    // take effect.
    await sleep(500);

    try {
      // 4. Write from node-c during the storm.  Majority means
      //    "self + at least floor(N/2)" replicas have to ack — under
      //    50ms delay every leg is ≥50ms but well under the 5s
      //    timeout.
      console.log(`[04] writing ${KEY}=updated from ${nodeC} during 50ms storm...`);
      const stormWrite = await write(nodeC!, ctx.controlPort, KEY, 'updated', 'majority');
      console.log(`[04] storm write ack in ${stormWrite.elapsedMs}ms (vs baseline ${baselineWrite.elapsedMs}ms)`);

      // 5. Read from node-d during the storm — must see 'updated'.
      console.log(`[04] reading from ${nodeD} during 50ms storm (majority)...`);
      await waitFor(
        `${nodeD} reads "updated" during latency storm`,
        async () => {
          const r = await read(nodeD!, ctx.controlPort, KEY, 'majority');
          return r.value === 'updated';
        },
        15_000,
        500,
      );
      const stormRead = await read(nodeD!, ctx.controlPort, KEY, 'majority');
      console.log(`[04] storm majority-read ack in ${stormRead.elapsedMs}ms (vs baseline ~${baselineAvg}ms)`);

      // Diagnostic — measurable slowdown is expected, but we don't
      // assert a hard ratio because CI noise.
      if (stormRead.elapsedMs <= baselineAvg) {
        console.warn(`[04] note: storm read (${stormRead.elapsedMs}ms) was not slower than baseline (${baselineAvg}ms) — netem delay may not be effective`);
      }
    } finally {
      // 6. Always clear the delay so the next scenario starts clean.
      console.log('[04] clearing egress delay on every node...');
      const clearCalls = ctx.nodes.map((h) =>
        fetch(`http://${h}:${ctx.controlPort}/test/delay?ms=0`, { method: 'POST' }),
      );
      await Promise.all(clearCalls);
    }

    // Final sanity check: post-storm, every node sees 'updated'.
    console.log('[04] post-storm: verifying every node reads "updated"...');
    await Promise.all(ctx.nodes.map(async (h) => {
      await waitFor(
        `${h} sees "updated" post-storm`,
        async () => {
          const r = await read(h, ctx.controlPort, KEY, 'majority');
          return r.value === 'updated';
        },
        10_000,
        300,
      );
    }));
    console.log('[04] post-storm convergence verified');
  },
};
