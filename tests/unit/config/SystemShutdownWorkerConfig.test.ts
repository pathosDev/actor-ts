import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import type { CoordinatedShutdown } from '../../../src/CoordinatedShutdown.js';
import { CoordinatedShutdownId, Phases } from '../../../src/CoordinatedShutdown.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DEFAULT_PHASE_TIMEOUT_MS, DEFAULT_SHUTDOWN_EXIT_CODE } from '../../../src/Constants.js';
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

/**
 * The config front-end to the phase DAG (#866).  The code-side graph —
 * `addPhase`, `setPhaseTimeout`, `dependsOn`, the Kahn sort — has existed
 * since `ca0ca3d6`; what these pin is the *merge* between a config block and
 * the twelve seeded phases, which is where the decisions are.
 *
 * Every case uses the nested-object form, never
 * `{'actor-ts.coordinated-shutdown.phases…': …}`: a dotted string stays a
 * literal top-level key, `hasPath` then resolves the nested reference.conf
 * value instead, and the test asserts nothing.
 */
describe('actor-ts.coordinated-shutdown.phases', () => {
  const withPhases = (phases: ConfigObject, rest: ConfigObject = {}): ActorSystem =>
    systemWith({ 'actor-ts': { 'coordinated-shutdown': { ...rest, phases } } }, 'cs-phases');

  /** The phase order a run actually produced, one entry per phase that had a task. */
  async function orderOf(shutdown: CoordinatedShutdown, phases: readonly string[]): Promise<string[]> {
    const seen: string[] = [];
    for (const phase of phases) shutdown.addTask(phase, 'record', () => { seen.push(phase); });
    await shutdown.run();
    return seen;
  }

  test('a timeout retimes exactly its own phase', async () => {
    const system = withPhases(
      { 'service-requests-done': { timeout: '30s' } },
      { 'default-phase-timeout': '250ms' },
    );
    const shutdown = system.extension(CoordinatedShutdownId);

    expect(shutdown.phaseDefinition(Phases.ServiceRequestsDone)?.timeoutMs).toBe(30_000);
    // Its neighbours keep the default — "for exactly that phase" is the
    // half a retime-everything implementation would still pass.
    expect(shutdown.phaseDefinition(Phases.ServiceStop)?.timeoutMs).toBe(250);
    expect(shutdown.phaseDefinition(Phases.ServiceUnbind)?.timeoutMs).toBe(250);
    expect(shutdown.defaultPhaseTimeoutMs).toBe(250);
    await system.terminate();
  });

  test('the configured timeout is the budget a task in that phase actually gets', async () => {
    // A structural assertion cannot show the number reaching `runOneTask`.
    // The default is 30 s and the task never resolves, so a run that returns
    // at all is one the 20 ms override bounded — the margin below is three
    // orders of magnitude, not a stopwatch.
    const system = withPhases(
      { 'service-unbind': { timeout: '20ms' } },
      { 'default-phase-timeout': '30s' },
    );
    const shutdown = system.extension(CoordinatedShutdownId);
    let started = false;
    // Never settles: the only thing that can end this phase is its timeout.
    shutdown.addTask(Phases.ServiceUnbind, 'hangs', () => new Promise<void>(() => {
      started = true;
    }));

    const startedAt = Date.now();
    await shutdown.run();

    expect(started).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(shutdown.isComplete).toBe(true);
    expect(system.isTerminated).toBe(true);
  });

  test('recover = false on a canonical phase halts the pipeline', async () => {
    const system = withPhases({ 'service-stop': { recover: false } }, {});
    const shutdown = system.extension(CoordinatedShutdownId);
    const ran: string[] = [];
    shutdown.addTask(Phases.ServiceStop, 'throws', () => {
      ran.push('service-stop');
      throw new Error('boom');
    });
    shutdown.addTask(Phases.ClusterLeave, 'later', () => { ran.push('cluster-leave'); });

    await expect(shutdown.run()).rejects.toThrow('boom');

    expect(shutdown.phaseDefinition(Phases.ServiceStop)?.recover).toBe(false);
    // The seeded `true` survives on every phase the block did not name.
    expect(shutdown.phaseDefinition(Phases.ClusterLeave)?.recover).toBe(true);
    expect(ran).toEqual(['service-stop']);
    await system.terminate();
  });

  test('a declared phase runs between the phases it is wired between', async () => {
    const system = withPhases({
      'flush-metrics': { 'depends-on': ['before-actor-system-terminate'] },
      'actor-system-terminate': { 'depends-on': ['flush-metrics'] },
    });
    const shutdown = system.extension(CoordinatedShutdownId);

    const order = await orderOf(shutdown, [
      Phases.BeforeActorSystemTerminate,
      'flush-metrics',
      Phases.ActorSystemTerminate,
    ]);

    expect(order).toEqual([
      Phases.BeforeActorSystemTerminate,
      'flush-metrics',
      Phases.ActorSystemTerminate,
    ]);
  });

  test('two declared phases naming each other register regardless of file order', async () => {
    // `addPhase` demands the target exist, and a config file has no reason to
    // be written dependency-first — so the reader sorts before it registers.
    const system = withPhases({
      'second-audit': { 'depends-on': ['first-audit'] },
      'first-audit': { 'depends-on': ['before-service-unbind'] },
    });
    const shutdown = system.extension(CoordinatedShutdownId);

    expect(shutdown.phaseDefinition('first-audit')?.dependsOn).toEqual(['before-service-unbind']);
    expect(shutdown.phaseDefinition('second-audit')?.dependsOn).toEqual(['first-audit']);

    const order = await orderOf(shutdown, ['second-audit', 'first-audit']);
    expect(order).toEqual(['first-audit', 'second-audit']);
  });

  test('depends-on on a canonical phase is added to the seeded edge, not a replacement', async () => {
    // Replacing would re-parent cluster-leave onto before-service-unbind,
    // and the topological sort would then run it second — a pipeline in the
    // wrong order that never throws.  Additive leaves the order alone.
    const system = withPhases({ 'cluster-leave': { 'depends-on': ['before-service-unbind'] } });
    const shutdown = system.extension(CoordinatedShutdownId);

    expect(shutdown.phaseDefinition(Phases.ClusterLeave)?.dependsOn)
      .toEqual([Phases.ClusterShardingShutdownRegion, Phases.BeforeServiceUnbind]);

    const order = await orderOf(shutdown, [
      Phases.BeforeServiceUnbind,
      Phases.ServiceUnbind,
      Phases.ClusterShardingShutdownRegion,
      Phases.ClusterLeave,
    ]);
    expect(order).toEqual([
      Phases.BeforeServiceUnbind,
      Phases.ServiceUnbind,
      Phases.ClusterShardingShutdownRegion,
      Phases.ClusterLeave,
    ]);
  });

  test('an unknown depends-on target is a ConfigError', async () => {
    const system = withPhases({ 'flush-metrics': { 'depends-on': ['no-such-phase'] } });

    expect(() => system.extension(CoordinatedShutdownId))
      .toThrow(/no-such-phase/);
    expect(() => system.extension(CoordinatedShutdownId)).toThrow(ConfigError);
    await system.terminate();
  });

  test('a declared phase with no depends-on is a ConfigError', async () => {
    // It would sort into the first ready batch and run before
    // before-service-unbind, which is never what "add a phase" meant.
    const system = withPhases({ 'flush-metrics': { timeout: '3s' } });

    expect(() => system.extension(CoordinatedShutdownId)).toThrow(ConfigError);
    await system.terminate();
  });

  test('declared phases that depend on each other in a cycle are a ConfigError', async () => {
    const system = withPhases({
      'left': { 'depends-on': ['right'] },
      'right': { 'depends-on': ['left'] },
    });

    expect(() => system.extension(CoordinatedShutdownId)).toThrow(/cycle/);
    await system.terminate();
  });

  test('a cycle through a canonical phase is caught at startup, not at shutdown', async () => {
    // `service-unbind` already runs before `cluster-leave`; asking for the
    // reverse closes the loop.  Reporting it here beats reporting it from
    // inside the shutdown that needed the pipeline to work.
    const system = withPhases({ 'service-unbind': { 'depends-on': ['cluster-leave'] } });

    expect(() => system.extension(CoordinatedShutdownId)).toThrow(ConfigError);
    await system.terminate();
  });

  test('an unknown setting under a phase is a ConfigError, not a silent no-op', async () => {
    const system = withPhases({ 'service-unbind': { timout: '30s' } });

    expect(() => system.extension(CoordinatedShutdownId)).toThrow(/timout/);
    await system.terminate();
  });

  test('nothing configured leaves the seeded graph exactly as it was', async () => {
    const system = systemWith({}, 'cs-phases-untouched');
    const shutdown = system.extension(CoordinatedShutdownId);

    expect(shutdown.phaseDefinition(Phases.ClusterLeave)).toEqual({
      name: Phases.ClusterLeave,
      timeoutMs: DEFAULT_PHASE_TIMEOUT_MS,
      dependsOn: [Phases.ClusterShardingShutdownRegion],
      recover: true,
    });
    expect(shutdown.phaseDefinition('flush-metrics')).toBeUndefined();
    await system.terminate();
  });
});

describe('actor-ts.coordinated-shutdown.exit-code', () => {
  /** Replace `process.exit` for the duration of `body` and report what it was handed. */
  async function captureExit(body: () => Promise<void>): Promise<number | undefined> {
    const realExit = process.exit;
    let captured: number | undefined;
    process.exit = ((code?: number): never => {
      captured = code;
      return undefined as never;
    }) as typeof process.exit;
    try {
      await body();
    } finally {
      process.exit = realExit;
    }
    return captured;
  }

  test('the configured code is what exit-process hands to process.exit', async () => {
    const system = systemWith({
      'actor-ts': { 'coordinated-shutdown': { 'exit-process': true, 'exit-code': 17 } },
    }, 'cs-exit-code');

    const captured = await captureExit(() => system.extension(CoordinatedShutdownId).run());

    expect(captured).toBe(17);
  });

  test('the default is 0, and exit-process off never calls exit at all', async () => {
    const withDefault = systemWith({
      'actor-ts': { 'coordinated-shutdown': { 'exit-process': true } },
    }, 'cs-exit-default');
    expect(await captureExit(() => withDefault.extension(CoordinatedShutdownId).run()))
      .toBe(DEFAULT_SHUTDOWN_EXIT_CODE);

    const off = systemWith({}, 'cs-exit-off');
    expect(await captureExit(() => off.extension(CoordinatedShutdownId).run()))
      .toBeUndefined();
  });

  test('a code the operating system would truncate is refused at startup', async () => {
    for (const code of [256, -1, 1000]) {
      const system = systemWith({
        'actor-ts': { 'coordinated-shutdown': { 'exit-code': code } },
      }, `cs-exit-${code}`);
      expect(() => system.extension(CoordinatedShutdownId)).toThrow(ConfigError);
      await system.terminate();
    }
  });
});

describe('actor-ts.coordinated-shutdown.run-by-process-signals', () => {
  test('false leaves runUntilTerminated without handlers, and it still waits', async () => {
    const before = process.listenerCount('SIGTERM');
    const system = systemWith({
      'actor-ts': { 'coordinated-shutdown': { 'run-by-process-signals': false } },
    }, 'cs-signals-off');
    expect(system.extension(CoordinatedShutdownId).runByProcessSignals).toBe(false);

    const running = system.runUntilTerminated();
    expect(process.listenerCount('SIGTERM')).toBe(before);

    // The promise is still a wait, not a no-op — the process stays up until
    // something shuts the system down from inside, which is the same promise
    // `runUntilTerminated` makes when every signal is unsupported.
    await system.terminate();
    await running;
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  test('an explicit signal list still installs, because explicit beats config', async () => {
    const before = process.listenerCount('SIGTERM');
    const system = systemWith({
      'actor-ts': { 'coordinated-shutdown': { 'run-by-process-signals': false } },
    }, 'cs-signals-explicit');

    const running = system.runUntilTerminated(['SIGTERM']);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);

    await system.terminate();
    await running;
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  test('true is the default and arms the handlers with no argument', async () => {
    const before = process.listenerCount('SIGTERM');
    const system = systemWith({}, 'cs-signals-default');
    expect(system.extension(CoordinatedShutdownId).runByProcessSignals).toBe(true);

    const running = system.runUntilTerminated();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);

    await system.terminate();
    await running;
    expect(process.listenerCount('SIGTERM')).toBe(before);
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
