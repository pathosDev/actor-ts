/**
 * Transparent placement on real OS threads (#1563).
 *
 * `tests/unit/parallelism/ParallelismExtension.test.ts` runs the identical
 * extension, bootstrap and protocol in-process; this file proves the parts
 * only a thread can: the actor module is imported by URL inside a real
 * worker, the spawn frame and its acknowledgment cross a `MessagePort`, an
 * `ask` to an actor `spawn` placed on another thread comes back, and
 * `system.terminate()` — the only call the application makes — leaves no
 * thread behind (a leftover one would keep this process alive past the
 * runner's exit).
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { ParallelismExtensionId } from '../../src/parallelism/ParallelismExtension.js';
import { ParallelismOptions } from '../../src/parallelism/ParallelismOptions.js';
import { PendingRemoteActorRef } from '../../src/parallelism/PendingRemoteActorRef.js';
import { Sum, Where } from './internal/ParallelismActors.js';

describe('parallelism on real worker threads', () => {
  test('spawn() places actors on two worker threads; asks come back; terminate() takes the threads down', async () => {
    const parallelism = ParallelismOptions.create()
      .withWorkers(2)
      .withModule(new URL('./internal/ParallelismActors.ts', import.meta.url));
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          cluster: {
            'gossip-interval': '40ms',
            'failure-detector': { 'heartbeat-interval': '100ms', 'unreachable-after': '2s', 'down-after': '4s' },
          },
          'worker-cluster': { 'ready-timeout': '20s' },
        },
      })
      .withParallelism(parallelism);
    const system = ActorSystem.create('real-para', systemOptions);
    try {
      // Spawned and used before the threads exist: the refs buffer until
      // the workers acknowledge.
      const first = system.spawn(Where, 'first');
      const second = system.spawn(Where, 'second');
      const sum = system.spawn(Sum, 'sum');
      for (let i = 1; i <= 100; i++) sum.tell({ kind: 'add', value: i });
      expect(first).toBeInstanceOf(PendingRemoteActorRef);

      const homes = await Promise.all([first, second].map((ref) => ref.ask<string>({ kind: 'where' }, 20_000)));
      for (const home of homes) expect(home.startsWith('real-para@worker:')).toBe(true);
      expect(await sum.ask<number>({ kind: 'sum' }, 20_000)).toBe(5050);

      const mesh = system.extension(ParallelismExtensionId).workerMesh!;
      expect(mesh.size).toBe(2);
      expect(mesh.cluster.upMembers()).toHaveLength(3);
      expect(system._inspectTree().some((cell) => cell.path.endsWith('/user/first'))).toBe(false);
    } finally {
      await system.terminate();
    }
  }, 60_000);
});
