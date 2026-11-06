/**
 * A WorkerMesh worker runs with its main thread's active profile (#1546).
 *
 * The main system's own load applies the profile once, and the values it
 * produced reach every worker inside the effective tree `WorkerMesh` sends.
 * Nothing on the way may select a profile a second time.  Both the worker pool
 * and each worker's own system used to call `Config.load()` for themselves,
 * which applies `ACTOR_TS_PROFILE` to `ACTOR_TS_CONFIG` or `./application.conf`
 * — not necessarily the file the main thread was given in code — and so
 * refused a mesh whose profile was defined only in that file.  The files a
 * worker reads are its main thread's for the same reason: the application
 * file (#1546) and, since #1785, the project `reference.conf`, the secrets
 * file and the `.env` — `false` included.
 *
 * Runs the production `WorkerMesh` and bootstrap on the in-process rig of
 * `WorkerMesh.test.ts`: real cluster nodes, no OS thread.  The fake workers
 * read this thread's `process.env`, as a real worker thread inherits it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions, type ActorSystemOptionsBuilder } from '../../../src/ActorSystemOptions.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import { Config } from '../../../src/config/Config.js';
import { configDumpLines } from '../../../src/diagnostics/ConfigDump.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { WorkerCluster } from '../../../src/worker/WorkerCluster.js';
import { WorkerClusterOptions } from '../../../src/worker/WorkerClusterOptions.js';
import { WorkerMesh } from '../../../src/worker/WorkerMesh.js';
import type { ModuleImporter } from '../../../src/worker/WorkerMeshBootstrap.js';
import { WorkerMeshOptions } from '../../../src/worker/WorkerMeshOptions.js';
import { autoHandshake, FakeWorkerBackend, hostMeshNode } from './__fixtures__/InMemoryWorkerThread.js';

const MODULE_URL = 'file:///mesh/profile.js';

class Idle extends Actor<never> {
  override onReceive(): void { /* nothing */ }
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A file called `name` holding `lines`, in a fresh directory removed after the case. */
function fileWith(name: string, lines: ReadonlyArray<string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-mesh-profile-'));
  directories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

/** The variables `Config.load` reads, cleared around every case. */
const LOAD_VARIABLES = [
  'ACTOR_TS_CONFIG', 'ACTOR_TS_PROFILE', 'ACTOR_TS_SECRETS_CONF', 'ACTOR_TS_REFERENCE_CONFIG', 'ACTOR_TS_ENV_FILE',
] as const;

/**
 * Run `body` with the load variables cleared and `variables` set on top,
 * restoring every one of them afterwards — so neither the shell running the
 * suite nor a case before this one decides what a load sees.
 */
async function withEnvironment(
  variables: Readonly<Record<string, string | undefined>>,
  body: () => Promise<void>,
): Promise<void> {
  const names = [...new Set([...LOAD_VARIABLES, ...Object.keys(variables)])];
  const previous = new Map(names.map((name) => [name, process.env[name]] as const));
  for (const name of names) {
    const value = variables[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The main system's settings every case starts from: quiet, and fast gossip set in code. */
function mainSystemOptions(): ActorSystemOptionsBuilder {
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { cluster: { 'gossip-interval': '25ms' } } });
}

/**
 * Start a mesh of `workers` on a system built from `systemOptions`, hand
 * `body` the main system and the configs its workers run with, and take it
 * all down again.
 */
async function withMesh(
  label: string,
  systemOptions: ActorSystemOptions,
  workers: number,
  body: (main: ActorSystem, workerConfigs: ReadonlyArray<Config>) => void,
): Promise<void> {
  const importer: ModuleImporter = async (href) => {
    if (href !== MODULE_URL) throw new Error(`no such module in this test: ${href}`);
    return { Idle };
  };
  const hosted: Array<Promise<{ readonly system: ActorSystem; readonly cluster: Cluster }>> = [];
  const backend = new FakeWorkerBackend({ onSpawn: (worker) => { hosted.push(hostMeshNode(worker, importer).node); } });
  const system = ActorSystem.create(label, systemOptions);
  try {
    const meshOptions = WorkerMeshOptions.create()
      .withModule(MODULE_URL)
      .withWorkers(workers)
      .withBackend(backend)
      .withReadyTimeoutMs(5_000);
    const mesh = await WorkerMesh.start(system, meshOptions);
    try {
      const nodes = await Promise.all(hosted);
      body(system, nodes.map((node) => node.system.config));
    } finally {
      await mesh.terminate();
    }
  } finally {
    await system.terminate();
  }
}

describe('a WorkerMesh under a profile (#1546)', () => {
  test('ACTOR_TS_PROFILE and a file named in code: the mesh starts, and every worker runs the profile', async () => {
    const applicationPath = fileWith('application.conf', [
      'my-app.mode = "root"',
      'profiles.staging.my-app.mode = "staging"',
    ]);
    await withEnvironment({ ACTOR_TS_PROFILE: 'staging' }, async () => {
      const systemOptions = mainSystemOptions().withConfigFile(applicationPath);
      await withMesh('mesh-profile-variable', systemOptions, 2, (main, workerConfigs) => {
        expect(main.config.getString('my-app.mode')).toBe('staging');
        expect(workerConfigs).toHaveLength(2);
        for (const config of workerConfigs) expect(config.getString('my-app.mode')).toBe('staging');
      });
    });
  }, 20_000);

  test('a profile selected in code reaches the workers, whatever ACTOR_TS_PROFILE names', async () => {
    const applicationPath = fileWith('application.conf', [
      'my-app.mode = "root"',
      'profiles.production.my-app.mode = "production"',
    ]);
    // `staging` is defined nowhere: a load that took the variable would refuse.
    await withEnvironment({ ACTOR_TS_PROFILE: 'staging' }, async () => {
      const systemOptions = mainSystemOptions()
        .withConfigFile(applicationPath)
        .withProfile('production');
      await withMesh('mesh-profile-option', systemOptions, 1, (main, workerConfigs) => {
        expect(main.config.getString('my-app.mode')).toBe('production');
        expect(workerConfigs.map((config) => config.getString('my-app.mode'))).toEqual(['production']);
      });
    });
  }, 20_000);

  test('a main system that opted out of the profile has workers that run without it too', async () => {
    // The file defines the profile the variable names, so a worker that took
    // the variable would start — on values its main thread does not run.  The
    // main thread's tree overrides every key it has, so it is a key only the
    // profile sets that would show it.
    const applicationPath = fileWith('application.conf', [
      'my-app.mode = "root"',
      'profiles.staging.my-app { mode = "staging", only-in-the-profile = "set" }',
    ]);
    await withEnvironment({ ACTOR_TS_PROFILE: 'staging' }, async () => {
      const systemOptions = mainSystemOptions()
        .withConfigFile(applicationPath)
        .withProfile('');
      await withMesh('mesh-profile-opted-out', systemOptions, 1, (main, workerConfigs) => {
        expect(main.config.getString('my-app.mode')).toBe('root');
        expect(main.config.hasPath('my-app.only-in-the-profile')).toBe(false);
        const [worker] = workerConfigs;
        expect(worker!.getString('my-app.mode')).toBe('root');
        expect(worker!.hasPath('my-app.only-in-the-profile')).toBe(false);
      });
    });
  }, 20_000);

  test('a worker reads the application file its main thread read, not the one ACTOR_TS_CONFIG names', async () => {
    const applicationPath = fileWith('application.conf', ['my-app.mode = "named-in-code"']);
    const variablePath = fileWith('application.conf', [
      'my-app.mode = "from-the-variable"',
      'my-app.only-in-the-variable-file = "stray"',
    ]);
    await withEnvironment({ ACTOR_TS_CONFIG: variablePath }, async () => {
      const systemOptions = mainSystemOptions().withConfigFile(applicationPath);
      await withMesh('mesh-profile-file', systemOptions, 1, (main, workerConfigs) => {
        expect(main.config.hasPath('my-app.only-in-the-variable-file')).toBe(false);
        const [worker] = workerConfigs;
        expect(worker!.getString('my-app.mode')).toBe('named-in-code');
        // A key only the other file sets is the tell: the main thread's tree
        // overrides every key it has, so nothing else could show the read.
        expect(worker!.hasPath('my-app.only-in-the-variable-file')).toBe(false);
      });
    });
  }, 20_000);
});

describe('a WorkerMesh worker reads the files its main thread read (#1769, #1785)', () => {
  test('a .env named in code answers a required substitution in the worker as well', async () => {
    const environmentPath = fileWith('app.env', ['MESH_FILES_TOKEN=from-the-named-file']);
    const applicationPath = fileWith('application.conf', ['my-app.token = ${MESH_FILES_TOKEN}']);
    // Left to its own chain, the worker would find no `.env` and refuse the
    // substitution — which only the file named in code answers.
    await withEnvironment({ MESH_FILES_TOKEN: undefined }, async () => {
      const systemOptions = mainSystemOptions()
        .withConfigFile(applicationPath)
        .withEnvironmentFile(environmentPath);
      await withMesh('mesh-files-environment', systemOptions, 1, (main, workerConfigs) => {
        expect(main.config.getString('my-app.token')).toBe('from-the-named-file');
        expect(workerConfigs.map((config) => config.getString('my-app.token'))).toEqual(['from-the-named-file']);
        expect(workerConfigs[0]!._sources()!.environmentFilePath).toBe(environmentPath);
      });
    });
  }, 20_000);

  test('a secrets file named in code is the one a worker reads, not the one ACTOR_TS_SECRETS_CONF names', async () => {
    const secretsPath = fileWith('vault.conf', ['my-app.db.endpoint-value = "from-the-option"']);
    // Another tool's file: a worker that read it would not start.
    const strayPath = fileWith('secrets.conf', ['server {', '  listen 80;', '}']);
    await withEnvironment({ ACTOR_TS_SECRETS_CONF: strayPath }, async () => {
      const systemOptions = mainSystemOptions().withSecretsFile(secretsPath);
      await withMesh('mesh-files-secrets', systemOptions, 1, (main, workerConfigs) => {
        const [worker] = workerConfigs;
        expect(worker!.getString('my-app.db.endpoint-value')).toBe('from-the-option');
        expect(worker!._sources()!.secretsPath).toBe(secretsPath);
        expect(configDumpLines(worker!)).not.toContain('from-the-option');
      });
    });
  }, 20_000);

  test('a project reference.conf named in code is the one a worker reads', async () => {
    const referencePath = fileWith('defaults.conf', ['my-app.pool-size = 4']);
    const variablePath = fileWith('reference.conf', [
      'my-app.pool-size = 99',
      'my-app.only-in-the-variable-file = "stray"',
    ]);
    await withEnvironment({ ACTOR_TS_REFERENCE_CONFIG: variablePath }, async () => {
      const systemOptions = mainSystemOptions().withReferenceConfigFile(referencePath);
      await withMesh('mesh-files-reference', systemOptions, 1, (main, workerConfigs) => {
        expect(main.config.hasPath('my-app.only-in-the-variable-file')).toBe(false);
        const [worker] = workerConfigs;
        expect(worker!.getInt('my-app.pool-size')).toBe(4);
        expect(worker!.hasPath('my-app.only-in-the-variable-file')).toBe(false);
      });
    });
  }, 20_000);

  test('false travels as false: a worker reads no file its main thread was told not to read', async () => {
    const variablePath = fileWith('application.conf', ['my-app.only-in-the-variable-file = "stray"']);
    await withEnvironment({ ACTOR_TS_CONFIG: variablePath }, async () => {
      const systemOptions = mainSystemOptions().withConfigFile(false);
      await withMesh('mesh-files-false', systemOptions, 1, (main, workerConfigs) => {
        expect(main.config.hasPath('my-app.only-in-the-variable-file')).toBe(false);
        const [worker] = workerConfigs;
        expect(worker!.hasPath('my-app.only-in-the-variable-file')).toBe(false);
        expect(worker!._sources()!.applicationPath).toBeNull();
      });
    });
  }, 20_000);
});

describe('WorkerCluster.spawn and the config it is handed (#1546)', () => {
  test('the worker-cluster block comes from that config, with no load of its own', async () => {
    // A load of its own would refuse: the variable names a profile no file defines.
    await withEnvironment({ ACTOR_TS_PROFILE: 'defined-nowhere' }, async () => {
      const config = Config.parseString('actor-ts.worker-cluster.workers = 2');
      const backend = new FakeWorkerBackend({ onSpawn: (spawned) => autoHandshake(spawned) });
      const workerOptions = WorkerClusterOptions.create()
        .withBootstrap(new URL('file:///fake-bootstrap.js'))
        .withBackend(backend);
      const pool = await WorkerCluster.spawn(workerOptions, config);
      try {
        expect(pool.size).toBe(2);
        expect(backend.spawned).toHaveLength(2);
      } finally {
        await pool.terminate();
      }
    });
  });
});
