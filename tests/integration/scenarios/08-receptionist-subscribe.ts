/**
 * Scenario 08 — Receptionist `Subscribe` continuous-listing updates.
 *
 * Scenario 03 exercised the one-shot `Find` API.  This one verifies
 * the OTHER half of the Receptionist contract: a long-lived
 * Subscribe gets:
 *
 *   1. An immediate Listing with the current set on Subscribe.
 *   2. A new Listing every time the set changes — register,
 *      deregister, cluster gossip pushing a new remote contribution.
 *
 * Setup (already wired in node-runner + control-routes): every node
 * has a long-running `ContinuousSubscriber` that's been subscribed
 * to the `workers` key since node startup.  By the time scenarios
 * begin, each subscriber has seen at least one Listing.
 *
 * Test sequence:
 *
 *   1. Confirm every node's subscriber sees the current count.
 *   2. Trigger an extra registration on node-a via
 *      `/test/receptionist/register-extra`.  Wait until every
 *      subscriber across the cluster observes the count going up
 *      by one (gossip-propagation latency).
 *   3. Deregister via `/test/receptionist/deregister-extra` and
 *      wait for the count to drop back.
 *   4. Assert that the `updates` counter on each subscriber
 *      monotonically increased — proves notifications fire on
 *      every change, not just on initial Subscribe.
 */

import { waitFor, type Scenario } from './types.js';

interface SubscribedResponse {
  readonly refs: ReadonlyArray<string>;
  readonly count: number;
  readonly updates: number;
}

async function subscribed(host: string, controlPort: number): Promise<SubscribedResponse> {
  const res = await fetch(`http://${host}:${controlPort}/test/receptionist/subscribed`);
  if (!res.ok) throw new Error(`/test/receptionist/subscribed on ${host} → ${res.status}`);
  return await res.json() as SubscribedResponse;
}

async function registerExtra(host: string, controlPort: number): Promise<void> {
  const res = await fetch(`http://${host}:${controlPort}/test/receptionist/register-extra`, { method: 'POST' });
  if (!res.ok) throw new Error(`/test/receptionist/register-extra on ${host} → ${res.status}`);
}

async function deregisterExtra(host: string, controlPort: number): Promise<void> {
  const res = await fetch(`http://${host}:${controlPort}/test/receptionist/deregister-extra`, { method: 'POST' });
  if (!res.ok) throw new Error(`/test/receptionist/deregister-extra on ${host} → ${res.status}`);
}

async function liveNodes(allNodes: ReadonlyArray<string>, controlPort: number): Promise<string[]> {
  const checks = await Promise.all(allNodes.map(async (h) => {
    try {
      const res = await fetch(`http://${h}:${controlPort}/test/ping`, {
        signal: AbortSignal.timeout(1_000),
      });
      return res.ok ? h : null;
    } catch {
      return null;
    }
  }));
  return checks.filter((h): h is string => h !== null);
}

export const scenario: Scenario = {
  name: '08-receptionist-subscribe',
  async run(ctx) {
    const live = await liveNodes(ctx.nodes, ctx.controlPort);
    if (live.length < 2) {
      console.log(`[08] skipping — need >=2 live nodes for cross-node Subscribe propagation, have ${live.length}`);
      return;
    }

    // 1. Wait until every node's subscriber has seen the baseline
    //    `live.length`-worker pool (initial Listing on Subscribe +
    //    any cluster-gossip-arrived remotes).
    console.log(`[08] waiting for every subscriber to observe baseline ${live.length} workers...`);
    await Promise.all(live.map(async (host) => {
      await waitFor(
        `${host} subscriber sees ${live.length} workers`,
        async () => (await subscribed(host, ctx.controlPort)).count === live.length,
        15_000,
        300,
      );
    }));

    // Snapshot the updates counter on every subscriber — we'll
    // verify it monotonically increases on each change.
    const baseline = new Map<string, number>();
    for (const host of live) {
      const s = await subscribed(host, ctx.controlPort);
      baseline.set(host, s.updates);
    }
    console.log(`[08] baseline updates per subscriber: ${[...baseline.entries()].map(([h, u]) => `${h}=${u}`).join(', ')}`);

    // 2. Register an extra worker on node-a.  Every subscriber
    //    (including node-a's, which sees it as a local register;
    //    and the others, which see it via gossip) must observe
    //    count = baseline + 1.
    const trigger = live[0]!;
    const expectedAfterAdd = live.length + 1;
    console.log(`[08] registering extra worker on ${trigger}, expecting every subscriber to see ${expectedAfterAdd}...`);
    await registerExtra(trigger, ctx.controlPort);
    await Promise.all(live.map(async (host) => {
      await waitFor(
        `${host} subscriber sees ${expectedAfterAdd}`,
        async () => (await subscribed(host, ctx.controlPort)).count === expectedAfterAdd,
        15_000,
        300,
      );
    }));
    console.log(`[08] all ${live.length} subscribers observed +1`);

    // 3. Deregister.  Count returns to baseline.
    console.log(`[08] deregistering extra worker on ${trigger}, expecting every subscriber back to ${live.length}...`);
    await deregisterExtra(trigger, ctx.controlPort);
    await Promise.all(live.map(async (host) => {
      await waitFor(
        `${host} subscriber back to ${live.length}`,
        async () => (await subscribed(host, ctx.controlPort)).count === live.length,
        15_000,
        300,
      );
    }));

    // 4. Verify updates monotonically increased on every subscriber.
    //    Each saw at least 2 NEW updates (the register and the
    //    deregister); could be more if gossip caused intermediate
    //    re-syncs.
    for (const host of live) {
      const s = await subscribed(host, ctx.controlPort);
      const base = baseline.get(host)!;
      if (s.updates <= base) {
        throw new Error(`[08] ${host} subscriber updates did not increase: baseline=${base}, now=${s.updates}`);
      }
      if (s.updates < base + 2) {
        // Looser than "exactly +2" because gossip can yield extra
        // identical-set updates that the subscriber still counts.
        // But +1 would mean a change was missed.  Require ≥2.
        throw new Error(`[08] ${host} subscriber received only ${s.updates - base} updates for 2 changes`);
      }
    }
    console.log('[08] every subscriber saw >=2 new updates (register + deregister)');
  },
};
