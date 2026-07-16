/**
 * Scenario 06 — Cluster Sharding rebalance after a node leaves.
 *
 *   1. Warm up 30 entities with distinct IDs by hitting
 *      `/test/sharding/who` for each.  Records each entity's host.
 *   2. Verifies entities are spread across MULTIPLE hosts (a single-
 *      host distribution would mean the hash is broken or the
 *      coordinator only allocated to one region).
 *   3. Picks a host that owns several entities, leaves it gracefully.
 *   4. Re-queries the entities that were on the departed host.  Each
 *      must now report a DIFFERENT (live) host — verifies the
 *      coordinator handed off the shards after `MemberRemoved`.
 *
 * Caveat: this is the second destructive scenario in the run order
 * (scenario 05 leaves the leader first).  06 picks any live node
 * that holds entities and works with the remaining cluster size.
 */

import { clusterLiveNodes, sleep, waitFor, type Scenario } from './types.js';

const NUM_ENTITIES = 30;
const ENTITY_IDS = Array.from({ length: NUM_ENTITIES }, (_, i) => `e-${i + 1}`);

interface WhoResponse {
  readonly entityId: string;
  readonly host: string;
  readonly value: number;
}

async function whoFromAny(
  liveHosts: ReadonlyArray<string>,
  controlPort: number,
  entityId: string,
): Promise<WhoResponse> {
  // Try each live host until one returns successfully.  After a
  // node has left, requests via its sibling routes still work — but
  // not via the departed node itself.
  let lastErr: unknown = null;
  for (const h of liveHosts) {
    try {
      const response = await fetch(`http://${h}:${controlPort}/test/sharding/who?id=${encodeURIComponent(entityId)}`);
      if (response.ok) return await response.json() as WhoResponse;
      lastErr = new Error(`HTTP ${response.status} from ${h}: ${await response.text()}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`whoFromAny(${entityId}) failed against all ${liveHosts.length} hosts: ${(lastErr as Error)?.message}`);
}

async function leaveCmd(host: string, controlPort: number): Promise<void> {
  const response = await fetch(`http://${host}:${controlPort}/test/leave`, { method: 'POST' });
  if (!response.ok) throw new Error(`/test/leave on ${host} → ${response.status}`);
}


export const scenario: Scenario = {
  name: '06-sharding-rebalance',
  async run(context) {
    const live = await clusterLiveNodes(context.nodes, context.controlPort);
    if (live.length < 3) {
      console.log(`[06] skipping — need >=3 live nodes for a meaningful rebalance, have ${live.length}`);
      return;
    }
    console.log(`[06] running with ${live.length} live nodes: ${live.join(', ')}`);

    // 1. Warm up 30 entities — each /who triggers entity spawn on
    //    its owning shard.  Use a single proxy node to avoid
    //    parallel-fan-in confusion in the entity-spawn path.
    console.log(`[06] warming up ${NUM_ENTITIES} entities...`);
    const idToHost = new Map<string, string>();
    for (const id of ENTITY_IDS) {
      const owner = await whoFromAny(live, context.controlPort, id);
      idToHost.set(id, owner.host);
    }

    // 2. Distribution check — every live node should host at least
    //    one entity.  Tolerate one node owning zero if numShards=32
    //    happens to hash all 30 IDs around it (unlikely but possible).
    const distribution = new Map<string, number>();
    for (const host of idToHost.values()) {
      distribution.set(host, (distribution.get(host) ?? 0) + 1);
    }
    const hostsWithEntities = [...distribution.keys()];
    console.log(`[06] entity distribution: ${[...distribution.entries()].map(([h, n]) => `${h}=${n}`).join(', ')}`);
    if (hostsWithEntities.length < 2) {
      throw new Error(`[06] expected entities spread over >=2 hosts, found only on: ${hostsWithEntities.join(', ')}`);
    }

    // 3. Pick a host that owns the MOST entities — leaving that
    //    maximises the rebalance signal we're testing.
    const [victim] = [...distribution.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const entitiesOnVictim = ENTITY_IDS.filter((id) => idToHost.get(id) === victim);
    console.log(`[06] victim node ${victim} owns ${entitiesOnVictim.length} entities; leaving it...`);
    await leaveCmd(victim, context.controlPort);

    // 4. Wait for the cluster to remove the victim from membership.
    const stillLive = live.filter((h) => h !== victim);
    await waitFor(
      `cluster removes departed ${victim}`,
      async () => {
        const post = await clusterLiveNodes(stillLive, context.controlPort);
        return post.length === stillLive.length;
      },
      10_000,
      300,
    );
    // Give the sharding coordinator a moment to re-allocate.
    // Default rebalance kicks in on MemberRemoved which propagates
    // via gossip after the failure-detector flips the member to
    // `down`.  ~3 seconds is generous.
    await sleep(3_000);

    // 5. Re-query the entities that were on the victim.  Each must
    //    now report a DIFFERENT (live) host.
    console.log(`[06] verifying ${entitiesOnVictim.length} relocated entities...`);
    let stillOnVictim = 0;
    let relocated = 0;
    const newHosts = new Set<string>();
    for (const id of entitiesOnVictim) {
      const owner = await whoFromAny(stillLive, context.controlPort, id);
      if (owner.host === victim) {
        stillOnVictim++;
      } else {
        relocated++;
        newHosts.add(owner.host);
      }
    }
    if (stillOnVictim > 0) {
      throw new Error(`[06] ${stillOnVictim} of ${entitiesOnVictim.length} entities still report ${victim} as host after rebalance`);
    }
    console.log(`[06] all ${relocated} ex-victim entities relocated to ${newHosts.size} surviving hosts: ${[...newHosts].join(', ')}`);

    // Note: the entity's `value` counter on the new host starts
    // fresh (sharded entities aren't persistent unless backed by
    // PersistentActor + journal — that's #311 territory).  We
    // don't assert on value here.
  },
};
