/**
 * Scenario 03 — Receptionist convergence over a 5-node cluster.
 *
 * Each node-runner auto-registers an IdleWorker under the shared
 * `workers` ServiceKey on first hit of `/test/receptionist/listing`.
 * After all 5 nodes have done so, every node's Listing should
 * contain 5 refs (one per node) — proving the cluster's
 * receptionist-gossip path actually converges across real TCP.
 *
 * Variant: partition, verify each side sees only its own
 * registrations, then heal and re-verify the full 5.
 */

import { sleep, waitFor, type Scenario } from './types.js';

interface ListingResponse {
  readonly count: number;
  readonly refs: ReadonlyArray<string>;
}

async function listing(host: string, controlPort: number): Promise<ListingResponse> {
  const res = await fetch(`http://${host}:${controlPort}/test/receptionist/listing`);
  if (!res.ok) throw new Error(`/test/receptionist/listing on ${host} → ${res.status}`);
  return await res.json() as ListingResponse;
}

export const scenario: Scenario = {
  name: '03-receptionist-convergence',
  async run(ctx) {
    const expected = ctx.nodes.length;

    // 1. Trigger lazy-init by hitting the listing endpoint on every
    //    node once.  Each hit auto-registers an IdleWorker into the
    //    local Receptionist.  After this round, every node should
    //    own one local registration; gossip propagates them across.
    const initial = await Promise.all(ctx.nodes.map(async (h) => ({
      host: h,
      listing: await listing(h, ctx.controlPort),
    })));
    for (const r of initial) {
      console.log(`[03] post-init: ${r.host} sees ${r.listing.count} ref(s)`);
    }

    // 2. Wait for every node's Listing to contain all 5 refs.
    //    Receptionist gossip runs at 250ms in this setup so 8s is
    //    generous.
    console.log(`[03] waiting for every node to see ${expected} worker refs...`);
    let lastSnapshot = '';
    const snapshotInterval = setInterval(() => {
      Promise.all(ctx.nodes.map((h) => listing(h, ctx.controlPort).catch(() => ({ count: -1 } as ListingResponse))))
        .then((all) => {
          const line = ctx.nodes.map((h, i) => `${h}=${all[i]!.count}`).join(' ');
          if (line !== lastSnapshot) {
            console.log(`[03]   counts: ${line}`);
            lastSnapshot = line;
          }
        })
        .catch(() => {/* ignore */});
    }, 2_000);
    try {
      await Promise.all(ctx.nodes.map(async (host) => {
        await waitFor(
          `${host} sees ${expected} workers`,
          async () => (await listing(host, ctx.controlPort)).count === expected,
          20_000,
          300,
        );
      }));
    } finally {
      clearInterval(snapshotInterval);
    }

    // Cross-check: every node sees the same SET of paths.
    const sets = await Promise.all(ctx.nodes.map(async (h) => new Set((await listing(h, ctx.controlPort)).refs)));
    const reference = sets[0]!;
    for (let i = 1; i < sets.length; i++) {
      const other = sets[i]!;
      if (other.size !== reference.size) {
        throw new Error(`[03] ${ctx.nodes[i]} sees ${other.size} refs, ${ctx.nodes[0]} sees ${reference.size}`);
      }
      for (const ref of reference) {
        if (!other.has(ref)) {
          throw new Error(`[03] ${ctx.nodes[i]} is missing ref ${ref}`);
        }
      }
    }
    console.log(`[03] all ${expected} nodes converged on the same ${reference.size}-worker pool`);

    // 3. Partition test — only if we have >=5 nodes for a clean 2:3 split.
    if (ctx.nodes.length < 5) {
      console.log('[03] skipping partition variant — need >=5 nodes');
      return;
    }
    const [a, b, c, d, e] = ctx.nodes;
    const left = [a!, b!];
    const right = [c!, d!, e!];

    console.log(`[03] partitioning {${left.join(',')}} from {${right.join(',')}}...`);
    const partitionCalls: Promise<Response>[] = [];
    for (const l of left) {
      for (const r of right) {
        partitionCalls.push(
          fetch(`http://${l}:${ctx.controlPort}/test/partition?peer=${r}`, { method: 'POST' }),
          fetch(`http://${r}:${ctx.controlPort}/test/partition?peer=${l}`, { method: 'POST' }),
        );
      }
    }
    const partRes = await Promise.all(partitionCalls);
    for (const res of partRes) if (!res.ok) throw new Error(`[03] partition failed: ${res.status}`);

    // The Receptionist's `remote` map is purged on `MemberRemoved`.
    // With LeaseMajority off (default), a partition produces
    // `unreachable` but NOT `removed` — so the gossiped remote refs
    // stay in the Listing.  This scenario doesn't assert reduction
    // during partition; it asserts that AFTER heal, the cluster is
    // back to a coherent 5-worker view from every node's perspective.
    // (A future scenario with LeaseMajority enabled would tighten
    // this — that's #142 territory.)

    // Give the failure detector a moment to mark peers unreachable.
    await sleep(3_000);

    // 4. Heal.
    console.log('[03] healing partition...');
    const healCalls: Promise<Response>[] = [];
    for (const l of left) {
      for (const r of right) {
        healCalls.push(
          fetch(`http://${l}:${ctx.controlPort}/test/heal?peer=${r}`, { method: 'POST' }),
          fetch(`http://${r}:${ctx.controlPort}/test/heal?peer=${l}`, { method: 'POST' }),
        );
      }
    }
    const healRes = await Promise.all(healCalls);
    for (const res of healRes) if (!res.ok) throw new Error(`[03] heal failed: ${res.status}`);

    // 5. After heal: every node still sees all 5 workers.  Gossip
    //    has by now re-bridged the two halves.
    console.log('[03] verifying post-heal convergence on full pool...');
    await Promise.all(ctx.nodes.map(async (host) => {
      await waitFor(
        `${host} re-converges on ${expected} workers after heal`,
        async () => (await listing(host, ctx.controlPort)).count === expected,
        30_000,
        500,
      );
    }));
    console.log(`[03] all ${expected} nodes back to the full ${expected}-worker pool`);
  },
};
