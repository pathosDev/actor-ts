/**
 * `WorkerMesh` on real OS threads (#1562, #1186).
 *
 * The unit suite (`tests/unit/worker/WorkerMesh.test.ts`) runs the identical
 * bootstrap in-process and proves the protocol; this file proves the three
 * things only a real thread can: that the shipped `worker-mesh-bootstrap`
 * resolves and runs as a worker entry on this runtime, that a `Worker`
 * actually joins the main thread's cluster over a `MessagePort`, and that an
 * `ask` round trip crosses a thread boundary and comes back.  One mesh, one
 * spawn, no respawn — the shape that has been running on CI since the
 * quarantine ended (#538).
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { WorkerMesh } from '../../src/worker/WorkerMesh.js';
import { WorkerMeshOptions } from '../../src/worker/WorkerMeshOptions.js';
import type { WhereCommand } from './internal/WorkerMeshActors.js';

describe('WorkerMesh on real worker threads', () => {
  test('two workers join the main thread, and an ask reaches an actor on each', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      // Fast membership so the mesh converges in well under the deadline;
      // builder-set, so it also proves the effective config reaches the
      // workers — with the reference defaults they would converge far slower.
      .withConfig({
        'actor-ts': {
          cluster: {
            'gossip-interval': '40ms',
            'failure-detector': { 'heartbeat-interval': '100ms', 'unreachable-after': '2s', 'down-after': '4s' },
          },
        },
      });
    const system = ActorSystem.create('real-mesh', systemOptions);
    const meshOptions = WorkerMeshOptions.create()
      .withModule(new URL('./internal/WorkerMeshActors.ts', import.meta.url))
      .withWorkers(2)
      .withReadyTimeoutMs(20_000);
    const mesh = await WorkerMesh.start(system, meshOptions);
    try {
      expect(mesh.size).toBe(2);
      expect(mesh.cluster.upMembers()).toHaveLength(3);
      expect(mesh.workers.map((w) => w.actors)).toEqual([['Where'], ['Where']]);

      const answers = await Promise.all(
        mesh.addresses.map((address) =>
          mesh.refFor<WhereCommand>(address, '/user/where').ask<string>({ kind: 'where' }, 10_000)),
      );
      expect(answers.sort()).toEqual(['real-mesh@worker:2', 'real-mesh@worker:3']);
    } finally {
      await mesh.terminate();
      await system.terminate();
    }
  }, 40_000);
});
