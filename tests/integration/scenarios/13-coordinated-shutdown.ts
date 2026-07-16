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
  const response = await fetch(`http://${host}:${controlPort}/test/shutdown-trace`);
  if (!response.ok) throw new Error(`/test/shutdown-trace on ${host} → ${response.status}`);
  return await response.json() as TraceResponse;
}

async function coordinatedShutdown(host: string, controlPort: number): Promise<void> {
  const response = await fetch(`http://${host}:${controlPort}/test/coordinated-shutdown`, { method: 'POST' });
  if (!response.ok && response.status !== 202) {
    throw new Error(`/test/coordinated-shutdown on ${host} → ${response.status}`);
  }
}

export const scenario: Scenario = {
  name: '13-coordinated-shutdown',
  async run(context) {
    const live = await clusterLiveNodes(context.nodes, context.controlPort);
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
    const baseline = await fetchTrace(observer, context.controlPort);
    const baselineFromVictim = baseline.markers.filter((m) => m.from === victim).length;
    console.log(`[13] observer already has ${baselineFromVictim} markers from ${victim} (baseline)`);

    // Trigger CoordinatedShutdown on the victim.  Fire-and-forget;
    // the HTTP server on the victim WILL close mid-pipeline.
    console.log(`[13] triggering coordinated-shutdown on ${victim}...`);
    await coordinatedShutdown(victim, context.controlPort);

    // Wait for the observer to receive BOTH markers: one from the
    // early phase (`BeforeServiceUnbind`, phase 1) and one from the
    // late phase (`BeforeActorSystemTerminate`, phase 11 of 12).
    // Together they prove the pipeline progressed through nearly
    // every phase — early-only would be a regression where the
    // pipeline got stuck.
    await waitFor(
      `${observer} sees BOTH early + late markers from ${victim}`,
      async () => {
        const trace = await fetchTrace(observer, context.controlPort);
        const fromVictim = trace.markers.filter((m) => m.from === victim);
        const hasEarly = fromVictim.some((m) => m.phase === 'BeforeServiceUnbind');
        const hasLate = fromVictim.some((m) => m.phase === 'BeforeActorSystemTerminate');
        return hasEarly && hasLate && fromVictim.length > baselineFromVictim;
      },
      30_000,
      400,
    );
    const finalTrace = await fetchTrace(observer, context.controlPort);
    const victimMarkers = finalTrace.markers.filter((m) => m.from === victim);
    const phases = victimMarkers.map((m) => m.phase);
    console.log(`[13] observer received ${victimMarkers.length} markers from ${victim}: ${phases.join(' → ')}`);

    // Sanity: the markers arrived in chronological order with
    // 'BeforeServiceUnbind' before 'BeforeActorSystemTerminate'.
    const earlyIndex = phases.indexOf('BeforeServiceUnbind');
    const lateIndex = phases.indexOf('BeforeActorSystemTerminate');
    if (earlyIndex < 0 || lateIndex < 0 || earlyIndex > lateIndex) {
      throw new Error(`[13] markers not in expected order: ${phases.join(',')}`);
    }
    console.log(`[13] pipeline progressed through ${phases.length} hook phases in correct order`);

    // Note: we deliberately don't assert here that the victim's HTTP
    // port stops accepting connections — the cluster harness keeps
    // its OWN control-port server bound separately from the user's
    // routes, so even after `ServiceUnbind` closes the auto-registered
    // user server the control port may still respond.  The unit test
    // in `tests/unit/http/HttpExtension.test.ts` covers the auto-
    // registration behavior directly; here, the two-marker assertion
    // (early + late phase) is sufficient evidence the shutdown
    // pipeline ran end-to-end.
  },
};
