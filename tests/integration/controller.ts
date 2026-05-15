/**
 * Scenario runner (#313).
 *
 * Runs each registered scenario sequentially against the cluster of
 * node containers brought up by docker-compose.  Exit code 0 if
 * every scenario passes; 1 if any fails.  `docker compose up
 * --exit-code-from controller` propagates the result to the shell
 * / CI runner.
 *
 * Configured via env:
 *   NODES   — comma-separated list of node hostnames (`node-a,node-b,...`)
 *   MGMT_TOKEN     — bearer token configured on every node
 *
 * Scenarios live in `./scenarios/*.ts`; each exports `name` and an
 * async `run(ctx)` function.  Adding a new scenario is a matter of
 * dropping a new file in `scenarios/` and adding it to the list below.
 */

import { scenario as membershipConvergence } from './scenarios/01-membership-convergence.js';
import { scenario as splitBrain } from './scenarios/02-split-brain.js';
import { scenario as receptionistConvergence } from './scenarios/03-receptionist-convergence.js';
import { scenario as ddataLatencyStorm } from './scenarios/04-ddata-latency-storm.js';
import { scenario as singletonFailover } from './scenarios/05-singleton-failover.js';
import { scenario as shardingRebalance } from './scenarios/06-sharding-rebalance.js';
import type { ControllerCtx, Scenario } from './scenarios/types.js';

const NODES = (process.env.NODES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const MGMT_TOKEN = process.env.MGMT_TOKEN ?? 'integration-test-token';
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 8090);
const MGMT_PORT = Number(process.env.MGMT_PORT ?? 8080);

if (NODES.length === 0) {
  console.error('controller: NODES env var is required (comma-separated hostnames)');
  process.exit(2);
}

const ctx: ControllerCtx = {
  nodes: NODES,
  mgmtToken: MGMT_TOKEN,
  mgmtPort: MGMT_PORT,
  controlPort: CONTROL_PORT,
};

// Scenario order: non-destructive scenarios run first (cluster
// stays at full membership), destructive scenarios (those that
// remove members via `/test/leave` or `/cluster/down`) run last.
// 05 onwards may not assume the original 5-node count — they
// inspect `ctx.nodes` and degrade gracefully.
const scenarios: Scenario[] = [
  membershipConvergence,
  splitBrain,
  receptionistConvergence,
  ddataLatencyStorm,
  shardingRebalance,    // — removes one node via cluster.leave()
  singletonFailover,    // — removes ANOTHER node via cluster.leave()
];

async function main(): Promise<void> {
  console.log(`[controller] running ${scenarios.length} scenario(s) against ${NODES.length} node(s): ${NODES.join(', ')}\n`);

  let failed = 0;
  for (const s of scenarios) {
    const startedAt = Date.now();
    console.log(`[controller] === ${s.name} ===`);
    try {
      // Always reset every node's network state before a scenario.
      // A previous scenario's partition / delay rules would otherwise
      // bleed into the next test's setup and confuse failure modes.
      await Promise.all(NODES.map((n) =>
        fetch(`http://${n}:${CONTROL_PORT}/test/clear`, { method: 'POST' })
          .catch((e) => console.warn(`[controller] pre-clear of ${n} failed: ${e.message}`)),
      ));
      await s.run(ctx);
      console.log(`[controller] PASS ${s.name} (${Date.now() - startedAt}ms)\n`);
    } catch (e) {
      failed += 1;
      console.error(`[controller] FAIL ${s.name} (${Date.now() - startedAt}ms)`);
      console.error(e);
      console.error('');
    }
  }

  if (failed > 0) {
    console.error(`[controller] ${failed} of ${scenarios.length} scenarios failed`);
    process.exit(1);
  }
  console.log(`[controller] all ${scenarios.length} scenarios passed`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[controller] fatal:', e);
  process.exit(2);
});
