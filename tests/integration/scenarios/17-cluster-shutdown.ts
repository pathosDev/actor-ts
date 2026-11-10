/**
 * Scenario 17 — the whole cluster shuts down, and every process exits.
 *
 * Runs LAST, on whatever the destructive scenarios left behind: two live
 * members, two nodes that answered `/test/leave` (06, 05) and one that has
 * already been through `CoordinatedShutdown.run()` (13).  Every node that
 * still answers `/test/ping` — member or left, the harness does not care
 * which — is asked for a coordinated shutdown, one at a time, and must
 * stop answering within `UNBIND_DEADLINE_MS`.  `ServiceUnbind` closes the
 * control port along with every other binding, so a port that keeps
 * answering means the pipeline never got that far.
 *
 * Why the suite ends this way rather than with the controller simply
 * exiting: `bun run test:integration` runs compose with
 * `--abort-on-container-failure`, under which a node exiting 0 is a
 * scenario event rather than the end of the run — 13's victim does exactly
 * that, and under the old `--abort-on-container-exit` its exit tore the
 * controller down mid-poll (#1594).  The price is that compose only ends
 * such a run once the LAST container is gone, so a green run has to shut
 * the cluster down itself.  In doing so it asserts what #1567 made true
 * and nothing but a process boundary can check: a node that has left and
 * terminated exits on its own, with no leaked handle holding its event
 * loop open.  The exit itself is out of this controller's sight — it sees
 * ports, not processes — which is why `NodeRunner` arms a watchdog once
 * its actor system has terminated: a process that lingers past it exits
 * with code 3, and the same compose flag turns that into an immediate red
 * run naming the container, instead of a hang until `timeout-minutes`.
 *
 * Nothing may run after this scenario.  A scenario appended below it would
 * find no nodes, and most scenarios skip rather than fail on a cluster
 * that is too small — silently green against a cluster that is gone.
 * `tests/unit/ci/IntegrationHarnessCascade.test.ts` pins the position.
 */

import { controlPost, waitFor, type Scenario } from './Types.js';

/**
 * How long a node has to close its control port after the request.  The
 * pipeline's own phase timeouts bound the shutdown well inside this; the
 * margin is for a busy runner, not for a slow node.
 */
const UNBIND_DEADLINE_MS = 15_000;

/**
 * Whether the node's control port still answers.  Anything but a 2xx —
 * a refused connection, a hostname compose has already withdrawn because
 * the container is gone, a timeout — counts as "no".
 */
async function answersPing(host: string, controlPort: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${controlPort}/test/ping`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export const scenario: Scenario = {
  name: '17-cluster-shutdown',
  async run(context) {
    const reachable: string[] = [];
    for (const host of context.nodes) {
      if (await answersPing(host, context.controlPort)) reachable.push(host);
    }
    console.log(`[17] ${reachable.length} node(s) still answer: ${reachable.length > 0 ? reachable.join(', ') : '(none)'}`);

    // One node at a time, in declaration order: the remaining members see
    // each other leave gracefully, and the log reads as a sequence rather
    // than as five interleaved pipelines.
    for (const host of reachable) {
      console.log(`[17] coordinated shutdown on ${host}...`);
      await controlPost(host, context.controlPort, '/test/coordinated-shutdown');
      await waitFor(
        `${host} stops answering /test/ping (ServiceUnbind closed the control port)`,
        async () => !(await answersPing(host, context.controlPort)),
        UNBIND_DEADLINE_MS,
        250,
      );
      console.log(`[17] ${host} is down`);
    }
    console.log(`[17] ${reachable.length} node(s) shut down; the run ends when their processes have exited`);
  },
};
