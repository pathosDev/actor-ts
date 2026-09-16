import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LocalActorRef } from '../../../src/internal/LocalActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ParallelismExtensionId } from '../../../src/parallelism/ParallelismExtension.js';
import { ParallelismOptions } from '../../../src/parallelism/ParallelismOptions.js';
import { FakeWorkerBackend } from '../worker/__fixtures__/InMemoryWorkerThread.js';
import { Counter, Where } from './__fixtures__/actors.js';

/**
 * The promise `workers = 0` makes (#1563): the system is the system it always
 * was.  No thread, no module import, no cluster; `spawn` returns a
 * `LocalActorRef` and the cell tree is the one a system without the option
 * would have.  Checked against a reference system built with the extension
 * never mentioned, and against a spy backend that would record the first
 * thread anybody tried to start.
 */

function systemOptions(): ReturnType<typeof ActorSystemOptions.create> {
  return ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
}

const ACTORS = new URL('./__fixtures__/actors.ts', import.meta.url);

describe('parallelism off by default (#1563)', () => {
  test('the default is workers = 0: local refs, no cluster, the extension disabled', async () => {
    const system = ActorSystem.create('plain', systemOptions());
    try {
      const ref = system.spawn(Where, 'where');
      expect(ref).toBeInstanceOf(LocalActorRef);
      expect(system.cluster.isNone()).toBe(true);
      const extension = system.extension(ParallelismExtensionId);
      expect(extension.enabled).toBe(false);
      expect(extension.workerMesh).toBeNull();
      await extension.whenReady();
    } finally {
      await system.terminate();
    }
  });

  test('workers = 0 set explicitly, with a module and a backend in hand, starts no thread and imports nothing', async () => {
    const backend = new FakeWorkerBackend();
    const parallelism = ParallelismOptions.create()
      .withWorkers(0)
      .withModule(ACTORS)
      .withBackend(backend);
    const system = ActorSystem.create('off', systemOptions().withParallelism(parallelism));
    const reference = ActorSystem.create('off', systemOptions());
    try {
      const counter = system.spawn(Counter, 'counter');
      const referenceCounter = reference.spawn(Counter, 'counter');
      expect(counter).toBeInstanceOf(LocalActorRef);
      counter.tell({ kind: 'add', value: 2 });
      const totals = await counter.ask<{ total: number }>({ kind: 'total' });
      expect(totals.total).toBe(2);
      expect(counter.path.toString()).toBe(referenceCounter.path.toString());

      // Same tree, path for path — the extension left nothing behind.
      const paths = (s: ActorSystem): string[] => s._inspectTree().map((cell) => cell.path).sort();
      expect(paths(system)).toEqual(paths(reference));
      expect(backend.spawned).toHaveLength(0);
      expect(system.extension(ParallelismExtensionId).exportedActors).toEqual([]);
    } finally {
      await system.terminate();
      await reference.terminate();
    }
    expect(backend.spawned).toHaveLength(0);
  });

  test('a bad offload pattern is a config mistake even when workers = 0, and fails create()', () => {
    const parallelism = ParallelismOptions.create().withWorkers(0).withOffload(['/system/*']);
    expect(() => ActorSystem.create('bad', systemOptions().withParallelism(parallelism)))
      .toThrow(/would match the \/system tree/);
  });
});
