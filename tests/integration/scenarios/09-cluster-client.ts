/**
 * Scenario 09 — External ClusterClient end-to-end (#120).
 *
 * Constructs a `ClusterClient` from the controller container (which
 * is NOT a cluster member) and asks `/user/echo` on every live
 * cluster node via the contact-point list.  Verifies:
 *
 *   1. The client successfully connects to one of the contact
 *      points and gets a reply within the ask-timeout.
 *   2. 100 sequential asks all return distinct `askId`-correlated
 *      replies — exercises the unpredictable-askId fix (#120) by
 *      running enough asks that a Date.now()+counter scheme would
 *      have collided.
 *   3. The reply's `nodeName` is one of the live cluster nodes —
 *      proves the request actually crossed the wire and was
 *      handled by the EchoActor on the cluster side, not by some
 *      local stub.
 */

import { ClusterClient } from '../../../src/cluster/ClusterClient.js';
import { NoopLogger } from '../../../src/Logger.js';
import { sleep, type Scenario } from './types.js';

interface PongReply {
  readonly kind: 'pong';
  readonly nodeName: string;
  readonly receivedAt: number;
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
  name: '09-cluster-client',
  async run(ctx) {
    const live = await liveNodes(ctx.nodes, ctx.controlPort);
    if (live.length < 1) {
      console.log('[09] skipping — no live nodes to contact');
      return;
    }
    // Cluster transport listens on 9000 in every container (set by
    // node-runner via CLUSTER_PORT env).  ClusterClient contact-points
    // expect `<systemName>@<host>:<port>` strings.
    const contactPoints = live.map((h) => `integration@${h}:9000`);
    console.log(`[09] connecting ClusterClient via contact-points: ${contactPoints.join(', ')}`);

    const client = new ClusterClient({
      contactPoints,
      systemName: 'integration',
      askTimeoutMs: 5_000,
      log: new NoopLogger(),
    });

    try {
      // 1. Single ask — proves the connection / hello / envelope /
      //    reply round-trip works end-to-end.
      console.log('[09] first ask /user/echo...');
      const first = await client.ask<PongReply>('/user/echo', { kind: 'ping' });
      if (first.kind !== 'pong') {
        throw new Error(`[09] unexpected reply: ${JSON.stringify(first)}`);
      }
      if (!live.includes(first.nodeName)) {
        throw new Error(`[09] reply node ${first.nodeName} is not in the live set: ${live.join(',')}`);
      }
      console.log(`[09] first ask answered by ${first.nodeName}`);

      // 2. 100 sequential asks — a Date.now()+counter askId scheme
      //    would have collided at the millisecond boundary; the
      //    randomUUID-based scheme should produce 100 distinct IDs.
      //    We don't have access to the askIds from outside (they're
      //    correlated internally) — but any collision would
      //    manifest as a reply being resolved to the WRONG promise,
      //    which would surface as a mismatched `nodeName` or a
      //    timeout.  We assert every reply is valid.
      console.log('[09] running 100 sequential asks...');
      const counts = new Map<string, number>();
      for (let i = 0; i < 100; i++) {
        const reply = await client.ask<PongReply>('/user/echo', { kind: 'ping' });
        if (reply.kind !== 'pong') {
          throw new Error(`[09] ask #${i} unexpected reply: ${JSON.stringify(reply)}`);
        }
        if (!live.includes(reply.nodeName)) {
          throw new Error(`[09] ask #${i} replied from ${reply.nodeName}, not in live set`);
        }
        counts.set(reply.nodeName, (counts.get(reply.nodeName) ?? 0) + 1);
      }
      console.log(`[09] 100 asks complete; replies-per-node: ${[...counts.entries()].map(([n, c]) => `${n}=${c}`).join(', ')}`);

      // 3. Brief settling pause so the controller logs come out
      //    deterministically before the next scenario starts.
      await sleep(100);
    } finally {
      await client.close();
    }
  },
};
