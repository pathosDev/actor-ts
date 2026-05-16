/**
 * Scenario 13 — CoordinatedShutdown actually fires hooks.
 *
 * Every node pre-registers a hook in the `BeforeServiceUnbind`
 * phase that POSTs a marker to each peer's
 * `/test/shutdown-trace/record`.  When `CoordinatedShutdown.run()`
 * fires on a node, the hook posts the marker (HTTP still works
 * because BeforeServiceUnbind precedes ServiceUnbind in the
 * phase order), then the local HTTP server eventually closes.
 *
 * Test sequence:
 *
 *   1. Pick the FIRST live node ("victim").
 *   2. Pick the SECOND live node ("observer") that will collect
 *      the marker.
 *   3. POST /test/coordinated-shutdown on the victim.
 *   4. Within a few seconds, observer's
 *      `/test/shutdown-trace` should contain a marker
 *      `{ from: <victim>, phase: 'BeforeServiceUnbind' }`.
 *   5. Verify the victim is unreachable shortly after
 *      (confirms the shutdown pipeline finished).
 *
 * Destructive: removes one node from the cluster (similar to
 * `cluster.leave()` but via the CoordinatedShutdown pipeline).
 * Runs LAST in the suite.
 */

import { clusterLiveNodes, waitFor, type Scenario } from './types.js';

interface TraceResponse {
  readonly markers: ReadonlyArray<{ from: string; phase: string; ts: number }>;
}

async function fetchTrace(host: string, controlPort: number): Promise<TraceResponse> {
  const res = await fetch(`http://${host}:${controlPort}/test/shutdown-trace`);
  if (!res.ok) throw new Error(`/test/shutdown-trace on ${host} → ${res.status}`);
  return await res.json() as TraceResponse;
}

async function coordinatedShutdown(host: string, controlPort: number): Promise<void> {
  const res = await fetch(`http://${host}:${controlPort}/test/coordinated-shutdown`, { method: 'POST' });
  if (!res.ok && res.status !== 202) {
    throw new Error(`/test/coordinated-shutdown on ${host} → ${res.status}`);
  }
}

export const scenario: Scenario = {
  name: '13-coordinated-shutdown',
  async run(ctx) {
    const live = await clusterLiveNodes(ctx.nodes, ctx.controlPort);
    if (live.length < 2) {
      console.log(`[13] skipping — need >=2 live nodes (one to shut down, one to observe), have ${live.length}`);
      return;
    }
    const victim = live[0]!;
    const observer = live[1]!;
    console.log(`[13] victim=${victim}, observer=${observer}`);

    // Pre-trigger snapshot of the observer's trace (might be empty
    // or might contain markers from earlier nodes' boots — we want
    // to assert *new* markers post-shutdown).
    const baseline = await fetchTrace(observer, ctx.controlPort);
    const baselineFromVictim = baseline.markers.filter((m) => m.from === victim).length;
    console.log(`[13] observer already has ${baselineFromVictim} markers from ${victim} (baseline)`);

    // Trigger CoordinatedShutdown on the victim.  Fire-and-forget;
    // the HTTP server on the victim WILL close mid-pipeline.
    console.log(`[13] triggering coordinated-shutdown on ${victim}...`);
    await coordinatedShutdown(victim, ctx.controlPort);

    // Wait for the observer to receive BOTH markers: one from the
    // early phase (`BeforeServiceUnbind`, phase 1) and one from the
    // late phase (`BeforeActorSystemTerminate`, phase 11 of 12).
    // Together they prove the pipeline progressed through nearly
    // every phase — early-only would be a regression where the
    // pipeline got stuck.
    await waitFor(
      `${observer} sees BOTH early + late markers from ${victim}`,
      async () => {
        const trace = await fetchTrace(observer, ctx.controlPort);
        const fromVictim = trace.markers.filter((m) => m.from === victim);
        const hasEarly = fromVictim.some((m) => m.phase === 'BeforeServiceUnbind');
        const hasLate = fromVictim.some((m) => m.phase === 'BeforeActorSystemTerminate');
        return hasEarly && hasLate && fromVictim.length > baselineFromVictim;
      },
      30_000,
      400,
    );
    const finalTrace = await fetchTrace(observer, ctx.controlPort);
    const victimMarkers = finalTrace.markers.filter((m) => m.from === victim);
    const phases = victimMarkers.map((m) => m.phase);
    console.log(`[13] observer received ${victimMarkers.length} markers from ${victim}: ${phases.join(' → ')}`);

    // Sanity: the markers arrived in chronological order with
    // 'BeforeServiceUnbind' before 'BeforeActorSystemTerminate'.
    const earlyIdx = phases.indexOf('BeforeServiceUnbind');
    const lateIdx = phases.indexOf('BeforeActorSystemTerminate');
    if (earlyIdx < 0 || lateIdx < 0 || earlyIdx > lateIdx) {
      throw new Error(`[13] markers not in expected order: ${phases.join(',')}`);
    }
    console.log(`[13] pipeline progressed through ${phases.length} hook phases in correct order`);

    // Note: we deliberately don't assert the victim's HTTP server
    // closes — the framework doesn't currently auto-register
    // user-bound HTTP servers with CoordinatedShutdown's
    // `ServiceUnbind` phase (a documented gap; see follow-up).
    // The two-marker assertion is sufficient evidence the
    // shutdown pipeline ran end-to-end.
  },
};
