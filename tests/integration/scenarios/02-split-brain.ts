/**
 * Scenario 02 — 2:3 partition, majority survives.
 *
 * Splits the cluster into a {node-a, node-b} side and a
 * {node-c, node-d, node-e} side via iptables drops inside each
 * container.  The default downing strategy keeps the majority
 * (KeepMajority), so the {c, d, e} side should converge to a
 * 3-member view while {a, b} either down themselves or see only
 * the other side as Unreachable.
 *
 * After verification, heal the partition and assert that the
 * 5-member view is reachable again (modulo any nodes that ended
 * up in the `down`/`removed` state on the loser side — for the
 * default KeepMajority strategy the loser side stays `up` but
 * sees its peers as Unreachable; the cluster doesn't auto-down
 * here, that's the LeaseMajority / SBR story).
 *
 * Requires at least 5 nodes — skips with a warning otherwise.
 */

import { membersFrom, upCountFrom, waitFor, type Scenario } from './types.js';

export const scenario: Scenario = {
  name: '02-split-brain-2-vs-3',
  async run(context) {
    if (context.nodes.length < 5) {
      console.log(`[02] skipping — need >=5 nodes, have ${context.nodes.length}`);
      return;
    }
    const [nodeA, nodeB, nodeC, nodeD, nodeE] = context.nodes;
    const left = [nodeA!, nodeB!];
    const right = [nodeC!, nodeD!, nodeE!];

    // 1. Pre-flight: confirm the cluster is converged before we partition.
    await Promise.all(context.nodes.map(async (host) => {
      await waitFor(
        `${host} sees ${context.nodes.length} up (pre-partition)`,
        async () => (await upCountFrom(host, context.controlPort)) === context.nodes.length,
        15_000,
        200,
      );
    }));

    // 2. Apply the partition: every node on the left side drops
    //    every node on the right (and vice versa).  Symmetric so
    //    no half-open weirdness.
    console.log(`[02] partitioning {${left.join(',')}} from {${right.join(',')}}...`);
    const partitionCalls: Promise<Response>[] = [];
    for (const leftNode of left) {
      for (const rightNode of right) {
        partitionCalls.push(
          fetch(`http://${leftNode}:${context.controlPort}/test/partition?peer=${rightNode}`, { method: 'POST' }),
          fetch(`http://${rightNode}:${context.controlPort}/test/partition?peer=${leftNode}`, { method: 'POST' }),
        );
      }
    }
    const responses = await Promise.all(partitionCalls);
    for (const response of responses) {
      if (!response.ok) throw new Error(`[02] partition call failed: ${response.status}`);
    }

    // 3. Wait for the majority side to see exactly its three members
    //    as `up` and the other two as `unreachable` (or absent).
    //    The failure detector at unreachableAfterMs=1500 means we
    //    should converge within ~3-5 seconds.
    console.log('[02] waiting for majority side to converge on 3 up + 2 unreachable...');
    await Promise.all(right.map(async (host) => {
      await waitFor(
        `${host} sees 3 up, 2 unreachable`,
        async () => {
          const members = await membersFrom(host, context.controlPort);
          const up = members.filter((m) => m.status === 'up').length;
          const unreachable = members.filter((m) => m.status === 'unreachable').length;
          return up === 3 && unreachable === 2;
        },
        20_000,
        300,
      );
    }));
    console.log('[02] majority side converged on partition view');

    // 4. The minority side ({a, b}) should also see the partition —
    //    each sees the OTHER side (3 nodes) as unreachable.  This is
    //    where with a downing strategy plugged in they'd down
    //    themselves; with the default no-op downing they just stay
    //    in the partitioned-but-alive state.
    await Promise.all(left.map(async (host) => {
      await waitFor(
        `${host} sees the 3 majority peers as unreachable`,
        async () => {
          const members = await membersFrom(host, context.controlPort);
          const unreachable = members.filter((m) => m.status === 'unreachable').length;
          return unreachable === 3;
        },
        20_000,
        300,
      );
    }));
    console.log('[02] minority side correctly sees majority as unreachable');

    // 5. Heal the partition: remove the iptables drops on every node.
    console.log('[02] healing partition...');
    const healCalls: Promise<Response>[] = [];
    for (const leftNode of left) {
      for (const rightNode of right) {
        healCalls.push(
          fetch(`http://${leftNode}:${context.controlPort}/test/heal?peer=${rightNode}`, { method: 'POST' }),
          fetch(`http://${rightNode}:${context.controlPort}/test/heal?peer=${leftNode}`, { method: 'POST' }),
        );
      }
    }
    const healResponses = await Promise.all(healCalls);
    for (const response of healResponses) {
      if (!response.ok) throw new Error(`[02] heal call failed: ${response.status}`);
    }

    // 6. After heal: every node should converge BACK to a 5-member
    //    'up' view.  Modulo nodes that have transitioned to
    //    `removed` via downing — for the default no-op downing
    //    strategy that doesn't happen, all 5 should rejoin.
    console.log('[02] waiting for cluster to re-converge on 5 up...');
    await Promise.all(context.nodes.map(async (host) => {
      await waitFor(
        `${host} re-converges on 5 up after heal`,
        async () => (await upCountFrom(host, context.controlPort)) === context.nodes.length,
        30_000,
        300,
      );
    }));
    console.log('[02] cluster re-converged on full membership after heal');
  },
};
