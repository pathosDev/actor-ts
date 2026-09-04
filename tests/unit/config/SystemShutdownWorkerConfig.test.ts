import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { Config } from '../../../src/config/Config.js';
import { CoordinatedShutdownId, Phases } from '../../../src/CoordinatedShutdown.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DEFAULT_PHASE_TIMEOUT_MS } from '../../../src/Constants.js';
import {
  readWorkerClusterOptionsFromConfig,
  withWorkerClusterConfigDefaults,
  WorkerClusterOptionsValidator,
} from '../../../src/worker/WorkerClusterOptions.js';
import type { WorkerClusterOptionsType } from '../../../src/worker/WorkerClusterOptions.js';

function systemWith(config: ConfigObject, name?: string): ActorSystem {
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
  test('reads the two string leaves, with "auto" staying a string', () => {
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

  /**
   * Every leaf at a value that is *not* its reference default, so the
   * assertion pins three things a defaulted value would hide: which accessor
   * reads the leaf (a duration read as an int throws, read as a string comes
   * back as `'30s'`), which field it lands in (the min/max backoff pair is
   * otherwise swappable in silence), and the leaf's spelling.
   */
  test('every leaf reaches its field, through the accessor its literal needs', () => {
    const config = Config.parseString(`
      actor-ts.worker-cluster {
        workers               = 4
        system-name           = "ingest"
        hostname              = "ingest-worker"
        base-port             = 100
        ready-timeout         = 30s
        restart-policy        = "always"
        restart-min-backoff   = 500ms
        restart-max-backoff   = 30s
        restart-random-factor = 0.3
        max-restarts          = 20
        restart-window        = 5m
      }
    `);

    expect(readWorkerClusterOptionsFromConfig(config)).toEqual({
      workers: 4,
      systemName: 'ingest',
      hostname: 'ingest-worker',
      basePort: 100,
      readyTimeoutMs: 30_000,
      restartPolicy: 'always',
      restartMinBackoffMs: 500,
      restartMaxBackoffMs: 30_000,
      restartRandomFactor: 0.3,
      maxRestarts: 20,
      restartWindowMs: 300_000,
    });
  });

  test('an absent leaf stays absent rather than being defaulted in', () => {
    // `mergeOptions` treats `undefined` as "not set" and falls through to the
    // next layer, so a reader that punched in its own default for a missing
    // leaf would shadow the built-in one and make the layering unobservable.
    // Exact-object on purpose: one leaf set, so a default punched into any of
    // the other ten shows up here.
    const config = Config.parseString('actor-ts.worker-cluster.base-port = 100');

    expect(readWorkerClusterOptionsFromConfig(config)).toEqual({ basePort: 100 });
  });

  test('the reference defaults round-trip to the built-in ones', () => {
    // Config.load merges reference.conf first, so from here on every one of
    // these leaves is always present and reference.conf *is* the effective
    // default -- WorkerCluster's `??` fallbacks are no longer reachable
    // through spawn().  Written out as literals on purpose: a second copy of
    // the numbers that is independent of the DEFAULT_* constants, which is
    // what DocumentedDefaults compares reference.conf against.
    expect(readWorkerClusterOptionsFromConfig(Config.loadReference())).toEqual({
      workers: 'auto',
      systemName: 'worker-cluster',
      hostname: 'worker',
      basePort: 1,
      readyTimeoutMs: 10_000,
      restartPolicy: 'on-failure',
      restartMinBackoffMs: 200,
      restartMaxBackoffMs: 10_000,
      restartRandomFactor: 0.2,
      maxRestarts: 10,
      restartWindowMs: 60_000,
    });
  });

  test('explicit options win over the config file', () => {
    const config = Config.parseString('actor-ts.worker-cluster.workers = 4');
    const options = { bootstrap: 'file:///w.js', workers: 8 } as WorkerClusterOptionsType;

    expect(withWorkerClusterConfigDefaults(options, config).workers).toBe(8);
  });

  test('an unset field falls through to the config file', () => {
    const config = Config.parseString('actor-ts.worker-cluster.workers = 4');
    const options = { bootstrap: 'file:///w.js' } as WorkerClusterOptionsType;

    expect(withWorkerClusterConfigDefaults(options, config).workers).toBe(4);
  });

  test('precedence holds per field across the whole block', () => {
    const config = Config.parseString(`
      actor-ts.worker-cluster {
        system-name         = "from-file"
        hostname            = "from-file"
        base-port           = 100
        ready-timeout       = 30s
        restart-min-backoff = 500ms
        max-restarts        = 20
      }
    `);
    const options = {
      bootstrap: 'file:///w.js',
      hostname: 'from-code',
      readyTimeoutMs: 250,
      maxRestarts: 3,
    } as WorkerClusterOptionsType;

    const merged = withWorkerClusterConfigDefaults(options, config);

    // Set in code: code wins.
    expect(merged.hostname).toBe('from-code');
    expect(merged.readyTimeoutMs).toBe(250);
    expect(merged.maxRestarts).toBe(3);
    // Set only in the file: the file supplies it.
    expect(merged.systemName).toBe('from-file');
    expect(merged.basePort).toBe(100);
    expect(merged.restartMinBackoffMs).toBe(500);
    // In neither: still unset, so WorkerCluster's `??` default applies.
    expect(merged.restartWindowMs).toBeUndefined();
  });

  test('a bogus restart-policy from config is rejected like a bogus one in code', () => {
    // Before this, an unknown policy fell through WorkerCluster's match and
    // silently meant "never restart".
    const config = Config.parseString('actor-ts.worker-cluster.restart-policy = "sometimes"');
    const merged = withWorkerClusterConfigDefaults(
      { bootstrap: 'file:///w.js' } as WorkerClusterOptionsType,
      config,
    );

    expect(() => new WorkerClusterOptionsValidator().validate(merged)).toThrow('restartPolicy');
  });

  test('an empty system-name or hostname from config is rejected', () => {
    // A config file is the only way these can be empty -- the builder's
    // callers were all passing real names -- and an empty one would reach
    // NodeAddress and give every worker an address with no host.
    for (const [leaf, field] of [['system-name', 'systemName'], ['hostname', 'hostname']]) {
      const config = Config.parseString(`actor-ts.worker-cluster.${leaf} = ""`);
      const merged = withWorkerClusterConfigDefaults(
        { bootstrap: 'file:///w.js' } as WorkerClusterOptionsType,
        config,
      );

      expect(() => new WorkerClusterOptionsValidator().validate(merged)).toThrow(field);
    }
  });

  test('an out-of-range restart-random-factor from config is rejected', () => {
    // The one fractional leaf in reference.conf, and the reason DefaultKind
    // grew a `number` member: getInt would have thrown on 0.2 outright.
    const config = Config.parseString('actor-ts.worker-cluster.restart-random-factor = 1.5');
    const merged = withWorkerClusterConfigDefaults(
      { bootstrap: 'file:///w.js' } as WorkerClusterOptionsType,
      config,
    );

    expect(() => new WorkerClusterOptionsValidator().validate(merged))
      .toThrow('restartRandomFactor');
  });
});
