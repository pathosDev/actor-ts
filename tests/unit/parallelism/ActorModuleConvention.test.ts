import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ParallelismExtensionId } from '../../../src/parallelism/ParallelismExtension.js';
import { ParallelismOptions } from '../../../src/parallelism/ParallelismOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { FakeWorkerBackend, hostMeshNode } from '../worker/__fixtures__/InMemoryWorkerThread.js';

/**
 * The convention that lets `module` stay unset (#1563): `actors.js` (or
 * `.ts`) next to the entry module.  The entry is what `process.argv[1]`
 * says, so each case points it at a fixture directory for the duration of
 * `ActorSystem.create` — the only moment the extension looks.
 */

const ENTRY_WITH_ACTORS = new URL('./__fixtures__/entry/main.ts', import.meta.url);
const ENTRY_WITHOUT_ACTORS = new URL('./PathPattern.test.ts', import.meta.url);

function withEntry<T>(entry: URL, body: () => T): T {
  const argv = process.argv;
  process.argv = [argv[0]!, fileURLToPath(entry)];
  try { return body(); } finally { process.argv = argv; }
}

function systemOptions(backend: FakeWorkerBackend): ReturnType<typeof ActorSystemOptions.create> {
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { cluster: { 'gossip-interval': '25ms' } } })
    .withParallelism(ParallelismOptions.create().withWorkers(1).withBackend(backend));
}

describe('actor module by convention (#1563)', () => {
  test('actors.ts beside the entry module is the actor module when none is named', async () => {
    const importer = (href: string): Promise<Record<string, unknown>> => import(href) as Promise<Record<string, unknown>>;
    const backend = new FakeWorkerBackend({ onSpawn: (worker) => { hostMeshNode(worker, importer); } });
    const system = withEntry(ENTRY_WITH_ACTORS, () => ActorSystem.create('conv', systemOptions(backend)));
    try {
      const extension = system.extension(ParallelismExtensionId);
      await extension.whenReady();
      expect(extension.exportedActors).toEqual(['Where']);
      expect(extension.workerMesh!.workers.map((w) => [...w.actors])).toEqual([['Where']]);
    } finally {
      await system.terminate();
    }
  }, 20_000);

  test('no module anywhere: create() fails naming the candidates it looked for and the way to name one', () => {
    const backend = new FakeWorkerBackend();
    let caught: unknown;
    try {
      withEntry(ENTRY_WITHOUT_ACTORS, () => ActorSystem.create('conv', systemOptions(backend)));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OptionsError);
    const message = (caught as Error).message;
    expect(message).toContain('actor-ts.parallelism.workers');
    expect(message).toContain('actors.ts');
    expect(message).toContain('actors.js');
    expect(message).toContain('withModule');
    expect(backend.spawned).toHaveLength(0);
  });

  test('no entry module at all: the same error, saying there was nowhere to look', () => {
    const backend = new FakeWorkerBackend();
    const argv = process.argv;
    process.argv = [argv[0]!];
    try {
      expect(() => ActorSystem.create('conv', systemOptions(backend))).toThrow(/nowhere to look/);
    } finally {
      process.argv = argv;
    }
  });
});
