/**
 * Scenario 16 — a framework readiness check gates `/ready` (#655).
 *
 * Isolates one node from *every* peer with iptables drops, so its cluster
 * transport ends up with no handshaked connection while its membership view
 * still lists four peers it expects to reach.  The framework's
 * `cluster-transport` readiness check goes red and `/ready` answers 503 —
 * a load balancer takes the pod out of rotation, which is the whole point:
 * before #655 the endpoint aggregated an empty list and answered 200
 * unconditionally.
 *
 * Three things are asserted, and the second is what makes the first mean
 * anything:
 *   1. the isolated node's `/ready` flips to 503 and names the failing check;
 *   2. every *other* node stays 200 — the check is "cut off from the whole
 *      cluster", not "something somewhere is partitioned", so a partial
 *      partition must not empty the load balancer;
 *   3. `/health` on the isolated node stays 200 throughout — liveness must
 *      not depend on a peer, or this partition would have restarted the pod
 *      instead of draining it.
 *
 * Healing puts it back to 200.  Non-destructive: nothing leaves the cluster.
 *
 * Requires at least 3 nodes — with two, isolating one leaves a single peer
 * on the other side and the assertions stop distinguishing 1 from 2.
 */

import { waitFor, type Scenario } from './Types.js';

type ReadinessBody = {
  status: string;
  clusterReady: boolean;
  checks: Array<{ name: string; status: boolean; detail?: string }>;
};

/** GET a probe endpoint; probes are anonymous, so no bearer token. */
async function probe(
  host: string,
  managementPort: number,
  endpoint: '/health' | '/ready',
): Promise<{ status: number; body: ReadinessBody }> {
  const response = await fetch(`http://${host}:${managementPort}${endpoint}`, {
    signal: AbortSignal.timeout(3_000),
  });
  return { status: response.status, body: await response.json() as ReadinessBody };
}

export const scenario: Scenario = {
  name: '16-readiness-gates',
  async run(context) {
    if (context.nodes.length < 3) {
      console.log(`[16] skipping — need >=3 nodes, have ${context.nodes.length}`);
      return;
    }
    const isolated = context.nodes[0]!;
    const rest = context.nodes.slice(1);

    // 1. Pre-flight: every node is ready, and the framework checks are the
    //    ones answering — an empty `checks` array would make every later
    //    assertion vacuous, which is exactly the bug this scenario covers.
    console.log('[16] pre-flight: every node ready with framework checks registered...');
    await Promise.all(context.nodes.map(async (host) => {
      await waitFor(
        `${host} is ready with a non-empty check list`,
        async () => {
          const { status, body } = await probe(host, context.mgmtPort, '/ready');
          return status === 200 && body.checks.length > 0 && body.checks.every((c) => c.status);
        },
        30_000,
        500,
      );
    }));

    // 2. Cut `isolated` off from every peer, both directions.
    console.log(`[16] isolating ${isolated} from {${rest.join(',')}}...`);
    const partitionCalls: Promise<Response>[] = [];
    for (const peer of rest) {
      partitionCalls.push(
        fetch(`http://${isolated}:${context.controlPort}/test/partition?peer=${peer}`, { method: 'POST' }),
        fetch(`http://${peer}:${context.controlPort}/test/partition?peer=${isolated}`, { method: 'POST' }),
      );
    }
    for (const response of await Promise.all(partitionCalls)) {
      if (!response.ok) throw new Error(`[16] partition call failed: ${response.status}`);
    }

    try {
      // 3. The isolated node stops being ready, and says which check failed.
      console.log(`[16] waiting for ${isolated} /ready to flip to 503...`);
      await waitFor(
        `${isolated} reports 503 on /ready`,
        async () => {
          const { status, body } = await probe(isolated, context.mgmtPort, '/ready');
          if (status !== 503) return false;
          const transport = body.checks.find((c) => c.name === 'cluster-transport');
          if (transport === undefined) {
            throw new Error(`[16] /ready is 503 but carries no cluster-transport check: ${JSON.stringify(body)}`);
          }
          return transport.status === false;
        },
        30_000,
        500,
      );
      console.log(`[16] ${isolated} correctly out of rotation`);

      // 4. Liveness is unmoved.  A failing liveness probe restarts the pod,
      //    and no restart heals someone else's network.
      {
        const { status, body } = await probe(isolated, context.mgmtPort, '/health');
        if (status !== 200) {
          throw new Error(`[16] /health on the isolated node must stay 200, got ${status}: ${JSON.stringify(body)}`);
        }
      }

      // 5. The peers each lost exactly one connection and keep the rest, so
      //    none of them is isolated — they must all still be ready.  This is
      //    the assertion that stops the check from being "any partition
      //    empties the load balancer".
      console.log(`[16] confirming the other ${rest.length} node(s) stay ready...`);
      for (const host of rest) {
        const { status, body } = await probe(host, context.mgmtPort, '/ready');
        if (status !== 200) {
          throw new Error(`[16] ${host} lost one peer and must stay ready, got ${status}: ${JSON.stringify(body)}`);
        }
      }
    } finally {
      // 6. Heal unconditionally — a scenario that throws mid-partition must
      //    not leave iptables rules behind for scenario 17 to trip over.
      console.log('[16] healing...');
      const healCalls: Promise<Response>[] = [];
      for (const peer of rest) {
        healCalls.push(
          fetch(`http://${isolated}:${context.controlPort}/test/heal?peer=${peer}`, { method: 'POST' }),
          fetch(`http://${peer}:${context.controlPort}/test/heal?peer=${isolated}`, { method: 'POST' }),
        );
      }
      for (const response of await Promise.all(healCalls)) {
        if (!response.ok) throw new Error(`[16] heal call failed: ${response.status}`);
      }
    }

    // 7. Reconnecting puts it back in rotation.
    console.log(`[16] waiting for ${isolated} to become ready again...`);
    await waitFor(
      `${isolated} reports 200 on /ready after heal`,
      async () => (await probe(isolated, context.mgmtPort, '/ready')).status === 200,
      30_000,
      500,
    );
    console.log('[16] readiness recovered after heal');
  },
};
