/**
 * Scenario 01 — membership convergence.
 *
 * The smoke test for the whole integration setup: every node sees
 * every other node as `up` within the convergence budget.  If this
 * fails, none of the more interesting partition scenarios are worth
 * running — there's something wrong with the network, the seed
 * configuration, or the cluster bootstrap.
 */

import { upCountFrom, waitFor, type Scenario } from './types.js';

export const scenario: Scenario = {
  name: '01-membership-convergence',
  async run(ctx) {
    const expected = ctx.nodes.length;
    console.log(`[01] waiting for every node to see ${expected} 'up' members...`);

    // Each node has its own convergence deadline — we don't want to
    // wait sequentially.  Parallel polling with one shared deadline.
    await Promise.all(ctx.nodes.map(async (host) => {
      await waitFor(
        `${host} sees ${expected} up`,
        async () => (await upCountFrom(host, ctx.controlPort)) === expected,
        20_000,
        200,
      );
    }));

    // Cross-check: every node's view contains the EXACT same set of
    // addresses (modulo their own self-address).  A node could see
    // `expected` up members while missing a peer that joined late
    // and replaced an earlier-down member — that would be a real
    // bug we'd want to surface.
    const addrSets: Array<Set<string>> = await Promise.all(ctx.nodes.map(async (host) => {
      const res = await fetch(`http://${host}:${ctx.controlPort}/test/members`);
      const body = await res.json() as { members: Array<{ address: string }> };
      return new Set(body.members.map((m) => m.address));
    }));
    const reference = addrSets[0]!;
    for (let i = 1; i < addrSets.length; i++) {
      const other = addrSets[i]!;
      if (other.size !== reference.size) {
        throw new Error(`[01] address-set size mismatch: ${ctx.nodes[0]}=${reference.size}, ${ctx.nodes[i]}=${other.size}`);
      }
      for (const a of reference) {
        if (!other.has(a)) {
          throw new Error(`[01] ${ctx.nodes[i]} is missing peer ${a} that ${ctx.nodes[0]} sees`);
        }
      }
    }
    console.log(`[01] all ${expected} nodes converged on the same ${reference.size}-member view`);
  },
};
