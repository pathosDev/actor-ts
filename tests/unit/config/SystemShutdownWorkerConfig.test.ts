import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { CoordinatedShutdownId, Phases } from '../../../src/CoordinatedShutdown.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DEFAULT_PHASE_TIMEOUT_MS } from '../../../src/util/Constants.js';
import {
  readWorkerClusterOptionsFromConfig,
  withWorkerClusterConfigDefaults,
  WorkerClusterOptionsValidator,
} from '../../../src/worker/WorkerClusterOptions.js';
import type { WorkerClusterOptionsType } from '../../../src/worker/WorkerClusterOptions.js';

function systemWith(config: Record<string, unknown>, name?: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config);
  return ActorSystem.create(name, options);
}

describe('actor-ts.system.name', () => {
  test('names the system when create() is called without one', async () => {
    const system = systemWith({ 'actor-ts': { system: { name: 'billing' } } });

    expect(system.name).toBe('billing');
    // The name reaches the paths, which is the only reason it matters.
    expect(system.deadLetters.path.toString()).toContain('billing');
    await system.terminate();
  });

  test('an explicit name wins over the config file', async () => {
    const system = systemWith({ 'actor-ts': { system: { name: 'billing' } } }, 'explicit');

    expect(system.name).toBe('explicit');
    await system.terminate();
  });

  test('falls back to "default" with nothing configured', async () => {
    const system = systemWith({});

    expect(system.name).toBe('default');
    await system.terminate();
  });
});

describe('actor-ts.coordinated-shutdown', () => {
  test('default-phase-timeout sets the seeded phases', async () => {
    const system = systemWith({
      'actor-ts': { 'coordinated-shutdown': { 'default-phase-timeout': '250ms' } },
    });

    expect(system.extension(CoordinatedShutdownId).defaultPhaseTimeoutMs).toBe(250);
    await system.terminate();
  });

  test('the built-in default is unchanged when nothing is configured', async () => {
    const system = systemWith({});

    expect(system.extension(CoordinatedShutdownId).defaultPhaseTimeoutMs)
      .toBe(DEFAULT_PHASE_TIMEOUT_MS);
    await system.terminate();
  });

  test('terminate-actor-system = false leaves the system running after run()', async () => {
    const system = systemWith({
      'actor-ts': { 'coordinated-shutdown': { 'terminate-actor-system': false } },
    });
    let userTaskRan = false;
    const shutdown = system.extension(CoordinatedShutdownId);
    // The phase must still run user tasks — only the built-in terminator is
    // opted out of, which is what an embedder owning the system wants.
    shutdown.addTask(Phases.ActorSystemTerminate, 'user-task', async () => { userTaskRan = true; });

    await shutdown.run();

    expect(userTaskRan).toBe(true);
    expect(system.isTerminated).toBe(false);
    await system.terminate();
  });

  test('the system terminates by default', async () => {
    const system = systemWith({});

    await system.extension(CoordinatedShutdownId).run();

    expect(system.isTerminated).toBe(true);
  });
});

describe('actor-ts.worker-cluster', () => {
  test('reads both leaves, with "auto" staying a string', () => {
    const config = Config.parseString(`
      actor-ts.worker-cluster {
        workers        = "auto"
        restart-policy = "always"
      }
    `);

    expect(readWorkerClusterOptionsFromConfig(config)).toEqual({
      workers: 'auto',
      restartPolicy: 'always',
    });
  });

  test('a numeric worker count comes back as a number', () => {
    const config = Config.parseString('actor-ts.worker-cluster.workers = 4');

    expect(readWorkerClusterOptionsFromConfig(config)).toEqual({ workers: 4 });
  });

  test('the reference defaults round-trip to the built-in ones', () => {
    expect(readWorkerClusterOptionsFromConfig(Config.loadReference())).toEqual({
      workers: 'auto',
      restartPolicy: 'on-failure',
    });
  });

  test('explicit options win over the config file', () => {
    const config = Config.parseString('actor-ts.worker-cluster.workers = 4');
    const options = { bootstrap: 'w.js', workers: 8 } as WorkerClusterOptionsType;

    expect(withWorkerClusterConfigDefaults(options, config).workers).toBe(8);
  });

  test('an unset field falls through to the config file', () => {
    const config = Config.parseString('actor-ts.worker-cluster.workers = 4');
    const options = { bootstrap: 'w.js' } as WorkerClusterOptionsType;

    expect(withWorkerClusterConfigDefaults(options, config).workers).toBe(4);
  });

  test('a bogus restart-policy from config is rejected like a bogus one in code', () => {
    // Before this, an unknown policy fell through WorkerCluster's match and
    // silently meant "never restart".
    const config = Config.parseString('actor-ts.worker-cluster.restart-policy = "sometimes"');
    const merged = withWorkerClusterConfigDefaults(
      { bootstrap: 'w.js' } as WorkerClusterOptionsType,
      config,
    );

    expect(() => new WorkerClusterOptionsValidator().validate(merged)).toThrow('restartPolicy');
  });
});
