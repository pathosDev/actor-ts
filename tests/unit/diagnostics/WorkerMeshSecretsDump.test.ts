/**
 * A WorkerMesh worker withholds its main thread's secrets-file values in its
 * own config dump (#1546).
 *
 * A worker receives the main thread's effective tree as one plain overrides
 * object — `WorkerMesh` sends `system.config.toJSON()`, and the bootstrap
 * builds its system from it — so `override` wins every leaf of a worker's
 * config.  When the worker's own `Config.load` reads the same secrets file,
 * the file's layer is enough.  When it cannot — the main thread named the
 * file in code, which no environment variable carries into the worker — the
 * paths travel in the init frame beside the tree.
 *
 * Runs the production `WorkerMesh` and bootstrap on the in-process rig of
 * `tests/unit/worker/WorkerMesh.test.ts`: real cluster nodes, no OS thread.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import { Config } from '../../../src/config/Config.js';
import { configDumpLines } from '../../../src/diagnostics/ConfigDump.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { WorkerMesh } from '../../../src/worker/WorkerMesh.js';
import type { ModuleImporter } from '../../../src/worker/WorkerMeshBootstrap.js';
import { WorkerMeshOptions } from '../../../src/worker/WorkerMeshOptions.js';
import { FakeWorkerBackend, hostMeshNode } from '../worker/__fixtures__/InMemoryWorkerThread.js';

const MODULE_URL = 'file:///mesh/secrets-dump.js';

class Idle extends Actor<never> {
  override onReceive(): void { /* nothing */ }
}

/** The boot dumps of a main thread and its one worker, both systems still running. */
type MeshDumps = {
  readonly main: string;
  readonly worker: string;
  readonly workerConfig: Config;
};

/**
 * Starts a one-worker mesh whose main thread loaded `secrets` as a secrets
 * file named in code, with `profile` active, and hands `body` both dumps.
 *
 * The worker must not find the file on its own, or the carried paths would
 * prove nothing: the variable is the one thing that could tell it, so it is
 * unset for the duration.
 */
async function withMeshDumps(
  label: string,
  secrets: string,
  profile: string | undefined,
  body: (dumps: MeshDumps) => void,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-mesh-secrets-'));
  const secretsPath = join(directory, 'secrets.conf');
  writeFileSync(secretsPath, secrets, 'utf8');
  const previousVariable = process.env['ACTOR_TS_SECRETS_CONF'];
  delete process.env['ACTOR_TS_SECRETS_CONF'];

  const importer: ModuleImporter = async (href) => {
    if (href !== MODULE_URL) throw new Error(`no such module in this test: ${href}`);
    return { Idle };
  };
  const hosted: Array<Promise<{ readonly system: ActorSystem; readonly cluster: Cluster }>> = [];
  const backend = new FakeWorkerBackend({ onSpawn: (worker) => { hosted.push(hostMeshNode(worker, importer).node); } });
  try {
    // How code names a secrets file for a system: a loaded config, passed in.
    const mainConfig = Config.load({
      appConfPath: 'no-such-application.conf',
      secretsConfPath: secretsPath,
      ...(profile === undefined ? {} : { profile }),
      overrides: { 'actor-ts': { cluster: { 'gossip-interval': '25ms' } } },
    });
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(mainConfig);
    const system = ActorSystem.create(label, systemOptions);
    const meshOptions = WorkerMeshOptions.create()
      .withModule(MODULE_URL)
      .withWorkers(1)
      .withBackend(backend)
      .withReadyTimeoutMs(8_000);
    try {
      const mesh = await WorkerMesh.start(system, meshOptions);
      try {
        const worker = await hosted[0]!;
        body({
          main: configDumpLines(system.config),
          worker: configDumpLines(worker.system.config),
          workerConfig: worker.system.config,
        });
      } finally {
        await mesh.terminate();
      }
    } finally {
      await system.terminate();
    }
  } finally {
    if (previousVariable === undefined) delete process.env['ACTOR_TS_SECRETS_CONF'];
    else process.env['ACTOR_TS_SECRETS_CONF'] = previousVariable;
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('a WorkerMesh worker and its main thread’s secrets file (#1546)', () => {
  test('a file the main thread named in code is withheld in the worker’s dump too', async () => {
    // Named like nothing in particular: only the file says it is a secret.
    await withMeshDumps('mesh-secrets', 'my-app.db.endpoint-value = "s3cr3t"\n', undefined, (dumps) => {
      expect(dumps.main).toContain('my-app.db.endpoint-value = <redacted>  [override]');
      // The worker has the value — it runs with the main thread's tree — and
      // attributes it to `override`, as it does every leaf.
      expect(dumps.workerConfig.getString('my-app.db.endpoint-value')).toBe('s3cr3t');
      expect(dumps.worker).toContain('my-app.db.endpoint-value = <redacted>  [override');
      expect(dumps.worker).not.toContain('s3cr3t');
    });
  }, 20_000);

  test('so is a key the file quotes because it holds a dot — at the root, nested, in its profile', async () => {
    const secrets = [
      '"db.dsn" = "dotted-root-1"',
      'my-app { "stripe.live" = "dotted-nested-2" }',
      'profiles.production { my-app { "payments.v2" = "dotted-profile-3" } }',
    ].join('\n');
    await withMeshDumps('mesh-secrets-quoted', secrets, 'production', (dumps) => {
      for (const value of ['dotted-root-1', 'dotted-nested-2', 'dotted-profile-3']) {
        expect(dumps.main).not.toContain(value);
        expect(dumps.worker).not.toContain(value);
      }
      // The worker holds all three, under the keys the file gave them.
      expect(dumps.workerConfig.toJSON()).toMatchObject({
        'db.dsn': 'dotted-root-1',
        'my-app': { 'stripe.live': 'dotted-nested-2', 'payments.v2': 'dotted-profile-3' },
      });
      expect(dumps.worker).toContain('\n  my-app."stripe.live" = <redacted>  [override');
    });
  }, 20_000);
});
