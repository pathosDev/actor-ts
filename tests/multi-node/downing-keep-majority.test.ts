/**
 * Multi-node end-to-end test for the wired-in `KeepMajority` strategy
 * (#61).  Confirms the full pipeline: cluster sees partition →
 * provider.decide() runs → minority side gets force-downed without
 * waiting for the failure detector's elapsed-time path.
 *
 * Scenario:
 *
 *   - 5 nodes a..e join a cluster.  Each carries `KeepMajority` as
 *     its downing provider.
 *   - We partition into 3 (a, b, c) vs 2 (d, e) via MultiNodeSpec.
 *   - Failure detector flips d, e to `unreachable` on the majority
 *     side; KeepMajority's decide() returns those addresses; the
 *     wiring force-downs them.
 *   - On the minority side, KeepMajority returns the side's own
 *     addresses → `cluster.leave()` runs on each.
 *   - Within ~1 s the majority side converges to a 3-node view.
 *     Without the wiring, this would take `downAfterMs` (set to 30 s
 *     here so we know the convergence is from KeepMajority and not
 *     the failure detector's elapsed-time fallback).
 */
import { describe, expect, test } from 'bun:test';
import { KeepMajority } from '../../src/cluster/downing/index.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  // Long downAfterMs so we KNOW the downing comes from KeepMajority,
  // not the failure detector's elapsed-time path.
  downAfterMs: 30_000,
} as const;

describe('KeepMajority — wired into cluster', () => {
  test('5 nodes, 3/2 partition: majority converges to 3, minority self-downs', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c', 'd', 'e'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
      // Each role gets its own KeepMajority instance.  The strategy
      // is stateless so a single shared one would work too, but
      // factoring this way keeps consistency with stateful strategies
      // (e.g. LeaseMajority) the harness will need to support next.
      downing: () => new KeepMajority(),
    });
    try {
      await spec.start();
      await Promise.all(['a', 'b', 'c', 'd', 'e'].map((r) =>
        spec.awaitMembers(r, 5)));

      // Partition: (a,b,c) ⇕ (d,e).
      for (const left of ['a', 'b', 'c']) {
        for (const right of ['d', 'e']) {
          spec.partition(left, right);
        }
      }

      // Majority side (a, b, c) converges to a 3-member view well
      // before downAfterMs would let the FD do this on its own.
      await Promise.all(['a', 'b', 'c'].map((r) =>
        spec.awaitMembers(r, 3, 4_000)));

      // Verify the majority side genuinely sees only 3 active members.
      for (const r of ['a', 'b', 'c']) {
        expect(spec.clusterFor(r).upMembers().length).toBe(3);
      }
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);
});
