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
    for (const snapshot of initial) {
      console.log(`[03] post-init: ${snapshot.host} sees ${snapshot.listing.count} ref(s)`);
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

    // Cross-check: every node's listing should reference all of the
    // OTHER nodes (as `RemoteActorRef.toString()` shapes prefixed
    // with `<systemName>@<host>:<port>`) plus exactly one local ref
    // (no host prefix).  This catches the failure mode where a node
    // sees 5 refs but they're all from the same peer (a gossip
    // leak / counter mis-attribution) — the count alone wouldn't
    // distinguish that from healthy convergence.
    const allListings = await Promise.all(ctx.nodes.map(async (h) => ({
      host: h,
      refs: (await listing(h, ctx.controlPort)).refs,
    })));
    for (const { host, refs } of allListings) {
      const local = refs.filter((r) => !r.includes('@'));
      const remote = refs.filter((r) => r.includes('@'));
      if (local.length !== 1) {
        throw new Error(`[03] ${host} should have exactly 1 local ref, has ${local.length}: ${JSON.stringify(refs)}`);
      }
      // Every OTHER node should appear once in the remote set.
      const remoteHosts = new Set(
        remote.map((r) => {
          // RemoteActorRef.toString() format: `<sys>@<host>:<port>actor-ts://...`
          const at = r.indexOf('@');
          const colon = r.indexOf(':', at);
          return at >= 0 && colon > at ? r.slice(at + 1, colon) : '<unknown>';
        }),
      );
      for (const peer of ctx.nodes) {
        if (peer === host) continue;
        if (!remoteHosts.has(peer)) {
          throw new Error(`[03] ${host} is missing a remote ref for peer ${peer}; saw remote hosts: ${[...remoteHosts].join(',')}`);
        }
      }
    }
    console.log(`[03] all ${expected} nodes converged on the same ${expected}-worker pool (1 local + ${expected - 1} remotes each)`);

    // 3. Partition test — only if we have >=5 nodes for a clean 2:3 split.
    if (ctx.nodes.length < 5) {
      console.log('[03] skipping partition variant — need >=5 nodes');
      return;
    }
    const [nodeA, nodeB, nodeC, nodeD, nodeE] = ctx.nodes;
    const left = [nodeA!, nodeB!];
    const right = [nodeC!, nodeD!, nodeE!];

    console.log(`[03] partitioning {${left.join(',')}} from {${right.join(',')}}...`);
    const partitionCalls: Promise<Response>[] = [];
    for (const leftNode of left) {
      for (const rightNode of right) {
        partitionCalls.push(
          fetch(`http://${leftNode}:${ctx.controlPort}/test/partition?peer=${rightNode}`, { method: 'POST' }),
          fetch(`http://${rightNode}:${ctx.controlPort}/test/partition?peer=${leftNode}`, { method: 'POST' }),
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
    for (const leftNode of left) {
      for (const rightNode of right) {
        healCalls.push(
          fetch(`http://${leftNode}:${ctx.controlPort}/test/heal?peer=${rightNode}`, { method: 'POST' }),
          fetch(`http://${rightNode}:${ctx.controlPort}/test/heal?peer=${leftNode}`, { method: 'POST' }),
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
