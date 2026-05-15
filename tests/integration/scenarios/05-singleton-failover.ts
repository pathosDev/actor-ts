/**
 * Scenario 05 — Cluster Singleton failover.
 *
 * Exactly one `CounterSingleton` actor lives in the cluster at any
 * time, hosted by the cluster leader.  Every node has a local
 * `ClusterSingletonProxy` so callers from any node route to the
 * same instance.  This scenario:
 *
 *   1. Verifies every node's proxy reports the SAME host node
 *      (the leader) for the singleton.
 *   2. Increments via several nodes' proxies.  The local-only
 *      counter sums to the total increments — proves messages
 *      route through to the leader regardless of caller node.
 *   3. Forces the host node to gracefully leave via `/test/leave`.
 *   4. Verifies a DIFFERENT node now hosts the singleton.
 *
 * Note on state: the new singleton instance starts fresh (counter=0)
 * — the cluster-singleton primitive does not persist state across
 * failover.  Persistence is a separate concern (see persistence/
 * docs).  The integration assertion is "failover happens", not
 * "state continues".
 *
 * Caveat: this scenario REDUCES the cluster size by one — it
 * should run near the end of the suite.  Subsequent scenarios that
 * need full membership won't have it; this is acknowledged at the
 * top of `controller.ts`.
 */

import { sleep, waitFor, type Scenario } from './types.js';

interface WhoResponse {
  readonly host: string;
  readonly value: number;
}

async function who(host: string, controlPort: number): Promise<WhoResponse> {
  const res = await fetch(`http://${host}:${controlPort}/test/singleton/who`);
  if (!res.ok) throw new Error(`/test/singleton/who on ${host} → ${res.status}: ${await res.text()}`);
  return await res.json() as WhoResponse;
}

async function inc(host: string, controlPort: number): Promise<void> {
  const res = await fetch(`http://${host}:${controlPort}/test/singleton/inc`, { method: 'POST' });
  if (!res.ok) throw new Error(`/test/singleton/inc on ${host} → ${res.status}: ${await res.text()}`);
}

async function leave(host: string, controlPort: number): Promise<void> {
  const res = await fetch(`http://${host}:${controlPort}/test/leave`, { method: 'POST' });
  if (!res.ok) throw new Error(`/test/leave on ${host} → ${res.status}: ${await res.text()}`);
}

export const scenario: Scenario = {
  name: '05-singleton-failover',
  async run(ctx) {
    // 1. Wait for every node's proxy to report a SAME host —
    //    proxies route to whichever node the cluster currently
    //    considers leader.
    console.log('[05] waiting for singleton to settle on a leader...');
    let initialHost: string | null = null;
    await waitFor(
      'every node\'s proxy reports the same singleton host',
      async () => {
        const responses = await Promise.all(ctx.nodes.map((h) =>
          who(h, ctx.controlPort).catch(() => null)));
        if (responses.some((r) => r === null)) return false;
        const hosts = new Set(responses.map((r) => r!.host));
        if (hosts.size !== 1) return false;
        initialHost = [...hosts][0]!;
        return true;
      },
      15_000,
      300,
    );
    console.log(`[05] singleton currently hosted by: ${initialHost}`);

    // 2. Increment via proxies on several different nodes.  Each
    //    proxy forwards to the leader, so the singleton's counter
    //    monotonically increases regardless of which proxy was hit.
    console.log('[05] incrementing 7 times via mixed proxies...');
    const senders = [ctx.nodes[0]!, ctx.nodes[1]!, ctx.nodes[2]!, ctx.nodes[3]!, ctx.nodes[4]!, ctx.nodes[0]!, ctx.nodes[1]!];
    for (const s of senders) await inc(s, ctx.controlPort);
    // Allow async fan-in.
    await sleep(500);

    // Read value back from any node; must equal 7 (counter+initial 0).
    const afterIncs = await who(ctx.nodes[0]!, ctx.controlPort);
    if (afterIncs.value !== 7) {
      throw new Error(`[05] expected singleton.value === 7 after 7 increments, got ${afterIncs.value}`);
    }
    console.log(`[05] singleton counter = ${afterIncs.value} on host ${afterIncs.host}`);

    // 3. Force the host node to leave gracefully.
    if (!initialHost) throw new Error('[05] no initial host recorded');
    console.log(`[05] graceful-leave on ${initialHost}...`);
    await leave(initialHost, ctx.controlPort);

    // 4. Wait for failover: some OTHER node now hosts.  Filter the
    //    pollee list to exclude the leaving node — its endpoints
    //    will start refusing after a brief window.
    const remainingNodes = ctx.nodes.filter((n) => n !== initialHost);
    console.log(`[05] waiting for failover (polling ${remainingNodes.length} remaining nodes)...`);
    let newHost: string | null = null;
    await waitFor(
      'a different node hosts the singleton after failover',
      async () => {
        const responses = await Promise.all(remainingNodes.map((h) =>
          who(h, ctx.controlPort).catch(() => null)));
        const liveResponses = responses.filter((r) => r !== null);
        if (liveResponses.length === 0) return false;
        const hosts = new Set(liveResponses.map((r) => r!.host));
        if (hosts.size !== 1) return false;          // not converged yet
        const candidate = [...hosts][0]!;
        if (candidate === initialHost) return false; // still old host (gossip not propagated)
        newHost = candidate;
        return true;
      },
      30_000,
      500,
    );
    console.log(`[05] failover completed — new host: ${newHost}`);

    // Sanity: counter on the new instance starts fresh.  We don't
    // assert exactly 0 because a passing message between the leave
    // and the proxy switching could land on the new instance —
    // but the value must be SMALL (much less than the 7 we counted
    // before failover).
    const afterFailover = await who(remainingNodes[0]!, ctx.controlPort);
    if (afterFailover.value >= 7) {
      throw new Error(`[05] expected new singleton's counter to reset, got ${afterFailover.value}`);
    }
    console.log(`[05] new singleton's counter: ${afterFailover.value} (fresh as expected)`);
  },
};
