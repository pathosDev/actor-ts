/**
 * Scenario 11 — Event-Sourcing + recovery via journal replay.
 *
 * Verifies the full PersistentActor lifecycle over a real-network
 * cluster node:
 *
 *   1. Spawn a `PersistentCounter` (implicit, on first /inc).
 *   2. Send 5 increments → count = 5.  Triggers a snapshot at
 *      seq=3 (the `everyNEvents(3)` policy from the actor) plus
 *      2 more events on top.
 *   3. PoisonPill the actor — instance stops; journal entries stay
 *      in memory inside the node-runner process.
 *   4. Send another /inc — implicitly re-spawns the actor → which
 *      triggers `preStart` → `recover()` → loads the snapshot at
 *      seq=3, replays events 4, 5 → state = 5 → then processes the
 *      pending /inc → state = 6.
 *   5. /state → verify count = 6.
 *   6. PoisonPill again, then /state.  This time NO new /inc
 *      before /state, so the replayed state must be exactly 6 (no
 *      additional inc) — proves the snapshot-load + event-replay
 *      roundtrip is deterministic.
 *
 * Acceptance: counts come back as expected after each respawn.
 */

import { clusterLiveNodes, sleep, type Scenario } from './types.js';

const ID = 'integration-persistent-counter';

interface StateResponse { readonly id: string; readonly count: number }

async function inc(host: string, controlPort: number, id: string): Promise<void> {
  const response = await fetch(`http://${host}:${controlPort}/test/persistence/inc?id=${encodeURIComponent(id)}`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error(`/test/persistence/inc on ${host} → ${response.status}: ${await response.text()}`);
}

async function getState(host: string, controlPort: number, id: string): Promise<number> {
  const response = await fetch(`http://${host}:${controlPort}/test/persistence/state?id=${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`/test/persistence/state on ${host} → ${response.status}: ${await response.text()}`);
  const body = await response.json() as StateResponse;
  return body.count;
}

async function killCounter(host: string, controlPort: number, id: string): Promise<void> {
  const response = await fetch(`http://${host}:${controlPort}/test/persistence/kill?id=${encodeURIComponent(id)}`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error(`/test/persistence/kill on ${host} → ${response.status}: ${await response.text()}`);
}

export const scenario: Scenario = {
  name: '11-persistence-recovery',
  async run(context) {
    const live = await clusterLiveNodes(context.nodes, context.controlPort);
    if (live.length === 0) {
      console.log('[11] skipping — no live cluster nodes');
      return;
    }
    // Pin to one node for the whole scenario.  The PersistentCounter
    // is local-only here — the InMemoryJournal lives in this node's
    // process, so a different node would see an EMPTY journal and
    // start from count=0.  (Cross-node persistence would require a
    // shared backend like Cassandra; see #71.)
    const target = live[0]!;
    console.log(`[11] targeting node ${target} for the entire scenario`);

    // 1. 5 increments → state = 5 (with snapshot at seq=3).
    console.log('[11] firing 5 increments...');
    for (let i = 0; i < 5; i++) await inc(target, context.controlPort, ID);
    // Brief settle so the persist() callbacks finish before we read.
    await sleep(200);
    let count = await getState(target, context.controlPort, ID);
    if (count !== 5) {
      throw new Error(`[11] after 5 incs, expected count=5, got ${count}`);
    }
    console.log(`[11] state = 5 confirmed`);

    // 2. PoisonPill.  Instance stops; journal stays.
    console.log('[11] killing actor (PoisonPill)...');
    await killCounter(target, context.controlPort, ID);
    // Give the dispatcher a moment to fully terminate the cell.
    await sleep(200);

    // 3. /inc after kill → respawn + replay + new inc.
    //    Expected: snapshot at seq=3 (state=3), replay events 4, 5
    //    (state=5), then process the new inc (state=6).
    console.log('[11] sending /inc — implicitly respawns the actor, expecting count to climb to 6...');
    await inc(target, context.controlPort, ID);
    await sleep(300);  // give recovery time

    count = await getState(target, context.controlPort, ID);
    if (count !== 6) {
      throw new Error(`[11] after respawn + 1 inc, expected count=6 (5 replayed + 1 new), got ${count}`);
    }
    console.log(`[11] state = 6 confirmed after first respawn`);

    // 4. PoisonPill again — pure recovery (no new inc this time).
    console.log('[11] killing actor again, then /state (pure recovery, no new inc)...');
    await killCounter(target, context.controlPort, ID);
    await sleep(200);
    count = await getState(target, context.controlPort, ID);
    if (count !== 6) {
      throw new Error(`[11] after second respawn (no new inc), expected count=6, got ${count}`);
    }
    console.log('[11] state = 6 confirmed after pure-recovery respawn');
  },
};
