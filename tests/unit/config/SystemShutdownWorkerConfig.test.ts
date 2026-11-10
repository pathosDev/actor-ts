import { describe, expect, spyOn, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { Config, ConfigError } from '../../../src/config/Config.js';
import type { CoordinatedShutdown, Reason } from '../../../src/CoordinatedShutdown.js';
import {
  ActorSystemTerminateReason,
  ClusterDowningReason,
  ClusterJoinUnsuccessfulReason,
  ClusterLeavingReason,
  CoordinatedShutdownId,
  Phases,
  ProcessTerminateReason,
  UnknownReason,
} from '../../../src/CoordinatedShutdown.js';
import { CoordinatedStartupOptions, StartupPhases } from '../../../src/CoordinatedStartupOptions.js';
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import { BatchingSink } from '../../../src/logging/BatchingSink.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';
import type { LogSink } from '../../../src/logging/LogSink.js';
import { DEFAULT_PHASE_TIMEOUT_MS, DEFAULT_SHUTDOWN_EXIT_CODE } from '../../../src/Constants.js';
import {
  readWorkerClusterOptionsFromConfig,
  withWorkerClusterConfigDefaults,
  WorkerClusterOptionsValidator,
} from '../../../src/worker/WorkerClusterOptions.js';
import type { WorkerClusterOptionsType } from '../../../src/worker/WorkerClusterOptions.js';
import { readWorkerMeshOptionsFromConfig, withWorkerMeshConfigDefaults } from '../../../src/worker/WorkerMeshOptions.js';
import type { WorkerMeshOptionsType } from '../../../src/worker/WorkerMeshOptions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { expectExactOptions } from '../../util/ExactOptions.js';

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
  /**
   * Replace `process.exit` for the duration of `body` and report what it was
   * handed — writing `exit <code>` into `trace` too, when there is one, so the
   * call has a place among the log lines a {@link TraceLogger} writes there,
   * and calling `atExit` at that moment, so a test can record what had reached
   * a sink by the time the process would have ended.
   */
  async function captureExit(
    body: () => Promise<void>,
    trace?: string[],
    atExit?: () => void,
  ): Promise<number | undefined> {
    const realExit = process.exit;
    let captured: number | undefined;
    process.exit = ((code?: number): never => {
      captured = code;
      trace?.push(`exit ${code}`);
      atExit?.();
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

  test('a code the operating system would truncate is refused at startup', () => {
    // By `create` itself: the system reads the block when it is built, for the
    // switch that decides what its `terminate()` does (#1455), so a value the
    // reader refuses no longer waits for the first use of the pipeline.
    for (const code of [256, -1, 1000]) {
      expect(() => systemWith({
        'actor-ts': { 'coordinated-shutdown': { 'exit-code': code } },
      }, `cs-exit-${code}`)).toThrow(ConfigError);
    }
  });

  /** A system whose one startup task fails, with `actor-ts.coordinated-shutdown` set to `settings`. */
  function failingStartup(settings: ConfigObject, name: string): ActorSystem {
    const startupOptions = CoordinatedStartupOptions.create().withTasks([{
      phase: StartupPhases.BeforeSystemReady,
      name: 'open-the-journal',
      task: () => { throw new Error('the journal is unreachable'); },
    }]);
    const options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { 'coordinated-shutdown': settings } })
      .withCoordinatedStartup(startupOptions);
    return ActorSystem.create(name, options);
  }

  /**
   * The run the failed startup started, waited out to its end — past the exit,
   * which comes after the terminator, so the real `process.exit` is not back
   * in place before the pipeline has called the stand-in.
   */
  async function shutdownAfterFailedStartup(system: ActorSystem): Promise<void> {
    // Rejected in the same call that starts the shutdown, so the run below is
    // the one already in flight, not a new one.
    await system.whenReady().catch(() => {});
    await system.extension(CoordinatedShutdownId).run();
  }

  test('a run for a failed startup does not exit 0: the default code becomes 1', async () => {
    // `0` tells a supervisor the process stopped cleanly, which a startup
    // that never finished did not.
    const captured = await captureExit(async () => {
      await shutdownAfterFailedStartup(failingStartup({ 'exit-process': true }, 'cs-exit-startup-default'));
    });

    expect(captured).toBe(1);
  });

  test('a configured non-zero code is what a failed startup exits with', async () => {
    const captured = await captureExit(async () => {
      await shutdownAfterFailedStartup(
        failingStartup({ 'exit-process': true, 'exit-code': 17 }, 'cs-exit-startup-configured'),
      );
    });

    expect(captured).toBe(17);
  });

  /**
   * Writes every record into `trace` as `<level> <message>` — the list
   * {@link captureExit} writes the exit into, so "logged before the exit" is a
   * position in one sequence.  What an ERROR was handed besides its text is
   * kept apart: the error a halt is logged with is an argument.
   */
  class TraceLogger implements Logger {
    readonly level = LogLevel.Debug;
    readonly errors: { readonly message: string; readonly details: readonly unknown[] }[] = [];

    constructor(protected readonly trace: string[]) {}

    debug(message: string): void { this.trace.push(`debug ${message}`); }
    info(message: string): void { this.trace.push(`info ${message}`); }
    warn(message: string): void { this.trace.push(`warn ${message}`); }
    error(message: string, ...details: unknown[]): void {
      this.trace.push(`error ${message}`);
      this.errors.push({ message, details });
    }
    withSource(): Logger { return this; }
    withFields(): Logger { return this; }
  }

  /** `service-stop` does not recover, so a task failing there halts the run. */
  const HALTING = { phases: { 'service-stop': { recover: false } } };

  /**
   * A system whose one shutdown task, in `service-stop`, throws `failure`, with
   * `actor-ts.coordinated-shutdown` set to `settings` and its log written into
   * `trace`.
   */
  function failingServiceStop(
    settings: ConfigObject,
    name: string,
    trace: string[],
  ): { system: ActorSystem; logger: TraceLogger; failure: Error } {
    const logger = new TraceLogger(trace);
    const options = ActorSystemOptions.create()
      .withLogger(logger)
      .withConfig({ 'actor-ts': { 'coordinated-shutdown': settings } });
    const system = ActorSystem.create(name, options);
    const failure = new Error('the broker would not close');
    system.extension(CoordinatedShutdownId).addTask(Phases.ServiceStop, 'close-the-broker', () => { throw failure; });
    return { system, logger, failure };
  }

  /** What `run()` settled with: the error it rejected with, or `'resolved'`. */
  const settledWith = (run: Promise<void>): Promise<unknown> =>
    run.then(() => 'resolved', (error: unknown) => error);

  test('a run that halts does not exit 0 either, and logs where it halted before it exits', async () => {
    // A halt ends the run short of its terminator, which is no clean stop.  And
    // nothing runs after the exit — not the teardown the halt would otherwise
    // get — so the ERROR line naming the phase is the last word the process has.
    const trace: string[] = [];
    const { system, logger, failure } = failingServiceStop(
      { ...HALTING, 'exit-process': true },
      'cs-exit-halted-default',
      trace,
    );
    let outcome: unknown = 'pending';

    const captured = await captureExit(async () => {
      outcome = await settledWith(system.extension(CoordinatedShutdownId).run());
    }, trace);

    expect(captured).toBe(1);
    const halted = trace.findIndex((line) =>
      line.startsWith('error ') && line.includes('halted') && line.includes(`"${Phases.ServiceStop}"`));
    expect(halted).toBeGreaterThanOrEqual(0);
    expect(halted).toBeLessThan(trace.indexOf('exit 1'));
    expect(logger.errors.find((record) => record.message.includes('halted'))?.details).toEqual([failure]);
    // Where `process.exit` returns — replaced, as here — the halt still rejects
    // the run, as it does with exit-process off.
    expect(outcome).toBe(failure);
    await system.terminate();
  });

  test('a configured non-zero code is what a halted run exits with', async () => {
    const trace: string[] = [];
    const { system } = failingServiceStop(
      { ...HALTING, 'exit-process': true, 'exit-code': 17 },
      'cs-exit-halted-configured',
      trace,
    );

    const captured = await captureExit(async () => {
      await settledWith(system.extension(CoordinatedShutdownId).run());
    }, trace);

    expect(captured).toBe(17);
    await system.terminate();
  });

  /**
   * Every reason the framework starts a run with — the cluster's join give-up
   * and its self-down among them, which reach the run through `run()` like
   * every other trigger.
   */
  const EVERY_REASON: readonly Reason[] = [
    UnknownReason.instance,
    ActorSystemTerminateReason.instance,
    new ProcessTerminateReason('SIGTERM'),
    ClusterLeavingReason.instance,
    ClusterDowningReason.instance,
    ClusterJoinUnsuccessfulReason.instance,
  ];

  test.each(EVERY_REASON.map((reason) => [reason.toString(), reason] as const))(
    'a halted run exits whichever reason started it: %s',
    async (_name, reason) => {
      const trace: string[] = [];
      const { system } = failingServiceStop(
        { ...HALTING, 'exit-process': true },
        `cs-exit-halted-${reason.name}`,
        trace,
      );

      const captured = await captureExit(async () => {
        await settledWith(system.extension(CoordinatedShutdownId).run(reason));
      }, trace);

      expect(captured).toBe(1);
      // The line says which run halted, so a node its own downing verdict
      // stopped is told apart from one a signal stopped.
      expect(trace.some((line) => line.startsWith('error ') && line.includes(`(${reason})`))).toBe(true);
      await system.terminate();
    },
  );

  test('with exit-process off a halted run never calls exit, and logs no more than it did', async () => {
    const trace: string[] = [];
    const { system, failure } = failingServiceStop(HALTING, 'cs-exit-halted-off', trace);
    let outcome: unknown = 'pending';

    const captured = await captureExit(async () => {
      outcome = await settledWith(system.extension(CoordinatedShutdownId).run());
    }, trace);

    expect(captured).toBeUndefined();
    expect(outcome).toBe(failure);
    // The halt stays the caller's to answer: the task's own WARN is all the
    // pipeline says, and the system is left as the halt found it.
    expect(trace.filter((line) => line.startsWith('error '))).toEqual([]);
    expect(trace.some((line) => line.startsWith('warn ') && line.includes('close-the-broker'))).toBe(true);
    expect(system.isTerminated).toBe(false);
    await system.terminate();
  });

  test('a failure the phase recovers from is no halt: the run completes and exits with exit-code', async () => {
    const trace: string[] = [];
    const { system } = failingServiceStop({ 'exit-process': true }, 'cs-exit-recovered', trace);
    let outcome: unknown = 'pending';

    const captured = await captureExit(async () => {
      outcome = await settledWith(system.extension(CoordinatedShutdownId).run());
    }, trace);

    expect(captured).toBe(DEFAULT_SHUTDOWN_EXIT_CODE);
    expect(outcome).toBe('resolved');
    expect(system.isTerminated).toBe(true);
  });

  /**
   * A batching sink that keeps what it delivers.  Its flush tick is an hour
   * away, so a record reaches `delivered` only through a flush or a close —
   * which is what a process about to exit has to be given, because nothing
   * gets the chance afterwards.
   *
   * A delivery takes an asynchronous step before it lands, as a write to a
   * file or a socket does.  Landing synchronously inside `flush()` would let
   * an exit that started the flush without waiting for it pass these cases.
   */
  class DeliveringSink extends BatchingSink {
    readonly delivered: LogRecord[] = [];

    constructor() {
      super('delivering', LogLevel.Debug, { flushIntervalMs: 3_600_000 });
    }

    protected async emitBatch(records: readonly LogRecord[]): Promise<void> {
      await Promise.resolve();
      this.delivered.push(...records);
    }
  }

  /** A system logging through `sink` alone, with `actor-ts.coordinated-shutdown` set to `settings`. */
  function loggingThrough(sink: LogSink, settings: ConfigObject, name: string): ActorSystem {
    const options = ActorSystemOptions.create()
      .withLogSinks([sink])
      .withConfig({ 'actor-ts': { 'coordinated-shutdown': settings } });
    return ActorSystem.create(name, options);
  }

  test('the halt\'s ERROR line has reached a buffering sink by the time the process exits', async () => {
    // The teardown is what would have drained the sink, and the exit takes
    // its place: unflushed, the line saying why the process went dies in the
    // sink's queue with it.
    const sink = new DeliveringSink();
    const system = loggingThrough(sink, { ...HALTING, 'exit-process': true }, 'cs-exit-halted-flushed');
    system.extension(CoordinatedShutdownId).addTask(Phases.ServiceStop, 'close-the-broker', () => {
      throw new Error('the broker would not close');
    });
    let deliveredAtExit: string[] = [];

    const captured = await captureExit(async () => {
      await settledWith(system.extension(CoordinatedShutdownId).run());
    }, undefined, () => { deliveredAtExit = sink.delivered.map((record) => record.message); });

    expect(captured).toBe(1);
    expect(deliveredAtExit.some((message) =>
      message.includes('halted') && message.includes(`"${Phases.ServiceStop}"`))).toBe(true);
    await system.terminate();
  });

  test('so has a completed run\'s last line when the run left the system up', async () => {
    // terminate-actor-system = false: no teardown ran, so none drained the
    // sink — the same gap as after a halt, from before the halt had an exit.
    const sink = new DeliveringSink();
    const system = loggingThrough(
      sink,
      { 'exit-process': true, 'terminate-actor-system': false },
      'cs-exit-completed-flushed',
    );
    system.extension(CoordinatedShutdownId).addTask(Phases.ServiceStop, 'close-the-broker', () => {
      system.log.info('the broker is closed');
    });
    let deliveredAtExit: string[] = [];

    const captured = await captureExit(
      () => system.extension(CoordinatedShutdownId).run(),
      undefined,
      () => { deliveredAtExit = sink.delivered.map((record) => record.message); },
    );

    expect(captured).toBe(DEFAULT_SHUTDOWN_EXIT_CODE);
    expect(deliveredAtExit).toContain('the broker is closed');
    expect(system.isTerminated).toBe(false);
    await system.terminate();
  });

  /** Counts what it is asked to do at the end: flush, and close. */
  class FlushCountingLogger extends NoopLogger {
    flushes = 0;
    closes = 0;

    flush(): Promise<void> {
      this.flushes += 1;
      return Promise.resolve();
    }

    close(): Promise<void> {
      this.closes += 1;
      return Promise.resolve();
    }
  }

  test.each([
    ['tore the system down: its teardown closed the logger, and nothing flushes it again', true, 'flushes=0 closes=1'],
    ['left the system up: the logger is flushed before the exit, and left open', false, 'flushes=1 closes=0'],
  ] as const)('a completed run that %s', async (_case, terminateActorSystem, expected) => {
    const logger = new FlushCountingLogger();
    const options = ActorSystemOptions.create()
      .withLogger(logger)
      .withConfig({
        'actor-ts': { 'coordinated-shutdown': { 'exit-process': true, 'terminate-actor-system': terminateActorSystem } },
      });
    const system = ActorSystem.create(`cs-exit-completed-${terminateActorSystem}`, options);
    let atExit = '';

    await captureExit(() => system.extension(CoordinatedShutdownId).run(), undefined, () => {
      atExit = `flushes=${logger.flushes} closes=${logger.closes}`;
    });

    expect(atExit).toBe(expected);
    await system.terminate();
  });

  /** A {@link TraceLogger} with a `flush`, written into the trace when it is called. */
  class FlushingTraceLogger extends TraceLogger {
    flush(): Promise<void> {
      this.trace.push('logger flush');
      return Promise.resolve();
    }
  }

  test('the dead-letter writes settle first, then the logger flushes, then the process exits', async () => {
    // The order the teardown flushes in, and for its reason: a dead-letter
    // write that fails reports through the logger, so the logger goes last.
    const trace: string[] = [];
    const options = ActorSystemOptions.create()
      .withLogger(new FlushingTraceLogger(trace))
      .withConfig({
        'actor-ts': {
          'dead-letters': { store: 'memory' },
          'coordinated-shutdown': { ...HALTING, 'exit-process': true },
        },
      });
    const system = ActorSystem.create('cs-exit-halted-dead-letters', options);
    system.extension(CoordinatedShutdownId).addTask(Phases.ServiceStop, 'close-the-broker', () => {
      throw new Error('the broker would not close');
    });
    const deadLetterFlush = spyOn(system.deadLetterQueue, 'flush').mockImplementation(() => {
      trace.push('dead-letter flush started');
      // Settled a macrotask later, so a flush that is started but not awaited
      // shows up after the exit in the trace instead of hiding before it.
      return new Promise<void>((resolve) => setTimeout(() => {
        trace.push('dead-letter flush settled');
        resolve();
      }, 0));
    });

    try {
      await captureExit(async () => {
        await settledWith(system.extension(CoordinatedShutdownId).run());
      }, trace);
    } finally {
      deadLetterFlush.mockRestore();
    }

    const halted = trace.findIndex((line) => line.startsWith('error ') && line.includes('halted'));
    expect(halted).toBeGreaterThanOrEqual(0);
    expect(trace.slice(halted + 1)).toEqual([
      'dead-letter flush started',
      'dead-letter flush settled',
      'logger flush',
      'exit 1',
    ]);
    await system.terminate();
  });

  test('a logger whose flush never settles still lets the halted run exit once close-timeout runs out', async () => {
    // Capped inside the fixture rather than by the test timeout: an exit that
    // waited on the flush for good would leave the run pending, not fail it.
    class NeverFlushingLogger extends NoopLogger {
      flushes = 0;

      flush(): Promise<void> {
        this.flushes += 1;
        return new Promise<void>(() => {});
      }
    }
    const logger = new NeverFlushingLogger();
    const options = ActorSystemOptions.create()
      .withLogger(logger)
      .withConfig({
        'actor-ts': {
          logger: { 'close-timeout': '50ms' },
          'coordinated-shutdown': { ...HALTING, 'exit-process': true },
        },
      });
    const system = ActorSystem.create('cs-exit-halted-flush-hangs', options);
    system.extension(CoordinatedShutdownId).addTask(Phases.ServiceStop, 'close-the-broker', () => {
      throw new Error('the broker would not close');
    });
    const realExit = process.exit;
    let atExit = 'not called';
    process.exit = ((code?: number): never => {
      atExit = `exit ${code} after ${logger.flushes} flush(es)`;
      return undefined as never;
    }) as typeof process.exit;
    try {
      void settledWith(system.extension(CoordinatedShutdownId).run());
      await awaitCondition(() => atExit !== 'not called', {
        label: 'the halted run exited once the flush budget ran out',
        timeoutMs: 3_000,
      });
    } finally {
      process.exit = realExit;
    }

    expect(atExit).toBe('exit 1 after 1 flush(es)');
    await system.terminate();
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

/**
 * #1455 — what a `terminate()` that names no `runCoordinatedShutdown` does.
 * The run-by-process-signals shape: the key decides the default where the
 * default is chosen, so an explicit choice on the call still beats it.
 */
describe('actor-ts.coordinated-shutdown.run-by-actor-system-terminate', () => {
  const switchedTo = (value: boolean): ConfigObject => ({
    'actor-ts': { 'coordinated-shutdown': { 'run-by-actor-system-terminate': value } },
  });

  /** The phase tasks that ran, with their reason, while `terminate` took `system` down. */
  async function phaseTasksRunBy(system: ActorSystem, terminate: () => Promise<void>): Promise<string[]> {
    const ran: string[] = [];
    system.extension(CoordinatedShutdownId).addTask(Phases.ServiceUnbind, 'unbind', (reason) => {
      ran.push(`service-unbind ${reason.name}`);
    });
    await terminate();
    expect(system.isTerminated).toBe(true);
    return ran;
  }

  test('off is the default: a terminate() that does not choose is the bare teardown', async () => {
    const system = systemWith({}, 'cs-terminate-default');

    expect(await phaseTasksRunBy(system, () => system.terminate())).toEqual([]);
  });

  test('on, a terminate() that does not choose runs the pipeline first', async () => {
    const system = systemWith(switchedTo(true), 'cs-terminate-on');

    expect(await phaseTasksRunBy(system, () => system.terminate()))
      .toEqual(['service-unbind ActorSystemTerminateReason']);
  });

  test('an explicit runCoordinatedShutdown: false beats it, because explicit beats config', async () => {
    const system = systemWith(switchedTo(true), 'cs-terminate-explicit-off');

    expect(await phaseTasksRunBy(system, () => system.terminate({ runCoordinatedShutdown: false })))
      .toEqual([]);
  });

  test('and an explicit true runs the pipeline with the switch off', async () => {
    const system = systemWith(switchedTo(false), 'cs-terminate-explicit-on');

    expect(await phaseTasksRunBy(system, () => system.terminate({ runCoordinatedShutdown: true })))
      .toEqual(['service-unbind ActorSystemTerminateReason']);
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

    expectExactOptions(readWorkerClusterOptionsFromConfig(config), {
      workers: 'auto',
      restartPolicy: 'always',
    });
  });

  test('a numeric worker count comes back as a number', () => {
    const config = Config.parseString('actor-ts.worker-cluster.workers = 4');

    expectExactOptions(readWorkerClusterOptionsFromConfig(config), { workers: 4 });
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

    expectExactOptions(readWorkerClusterOptionsFromConfig(config), {
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
    // Exact-object on purpose, own keys included: one leaf set, so anything
    // punched into the other ten shows up here — a default, or the bare
    // `undefined` a `toEqual` alone would let through.
    const config = Config.parseString('actor-ts.worker-cluster.base-port = 100');

    expectExactOptions(readWorkerClusterOptionsFromConfig(config), { basePort: 100 });
  });

  test('the reference defaults round-trip to the built-in ones', () => {
    // Config.load merges reference.conf first, so from here on every one of
    // these leaves is always present and reference.conf *is* the effective
    // default -- WorkerCluster's `??` fallbacks are no longer reachable
    // through spawn().  Written out as literals on purpose: a second copy of
    // the numbers that is independent of the DEFAULT_* constants, which is
    // what DocumentedDefaults compares reference.conf against.
    expectExactOptions(readWorkerClusterOptionsFromConfig(Config.loadReference()), {
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
    // The first fractional leaf in reference.conf, though no longer the only
    // one, and the reason DefaultKind grew a `number` member: getInt would
    // have thrown on 0.2 outright.
    const config = Config.parseString('actor-ts.worker-cluster.restart-random-factor = 1.5');
    const merged = withWorkerClusterConfigDefaults(
      { bootstrap: 'file:///w.js' } as WorkerClusterOptionsType,
      config,
    );

    expect(() => new WorkerClusterOptionsValidator().validate(merged))
      .toThrow('restartRandomFactor');
  });
});

describe('actor-ts.worker-mesh', () => {
  /**
   * Every leaf at a value that is *not* its reference default, so the
   * assertion pins the accessor, the field and the leaf's spelling — the same
   * three things the worker-cluster block above pins.  `module` and
   * `bootstrap` have no leaf on purpose (#1562, same reason as
   * `worker-cluster.bootstrap`), so an exact-object match here is also the
   * proof that a config file cannot name the code a worker runs.
   */
  test('every leaf reaches its field, through the accessor its literal needs', () => {
    const config = Config.parseString(`
      actor-ts.worker-mesh {
        workers                = 3
        main-hostname          = "front"
        main-port              = 10
        worker-hostname        = "core"
        base-port              = 20
        main-roles             = ["frontend"]
        worker-roles           = ["compute", "ingest"]
        metrics-relay-interval = 2500ms
      }
    `);

    // This exact-object match is what binds `metrics-relay-interval` to its
    // field (#1570): `NoDeadConfigKeys` fails the leaf once the reader drops it
    // (#1425), but a reader that read it into another field would still move
    // its answer and leave that gate green.
    expectExactOptions(readWorkerMeshOptionsFromConfig(config), {
      workers: 3,
      mainHostname: 'front',
      mainPort: 10,
      workerHostname: 'core',
      basePort: 20,
      mainRoles: ['frontend'],
      workerRoles: ['compute', 'ingest'],
      metricsRelayIntervalMs: 2_500,
    });
  });

  test('"auto" stays a string, and an absent leaf stays absent', () => {
    expectExactOptions(
      readWorkerMeshOptionsFromConfig(Config.parseString('actor-ts.worker-mesh.workers = "auto"')),
      { workers: 'auto' },
    );
    expectExactOptions(
      readWorkerMeshOptionsFromConfig(Config.parseString('actor-ts.worker-mesh.base-port = 7')),
      { basePort: 7 },
    );
    // The off switch is a literal zero, read through `getDuration` like `10s` is.
    expectExactOptions(
      readWorkerMeshOptionsFromConfig(Config.parseString('actor-ts.worker-mesh.metrics-relay-interval = 0')),
      { metricsRelayIntervalMs: 0 },
    );
  });

  test('the reference defaults round-trip to the built-in ones', () => {
    expectExactOptions(readWorkerMeshOptionsFromConfig(Config.loadReference()), {
      workers: 'auto',
      mainHostname: 'main',
      mainPort: 1,
      workerHostname: 'worker',
      basePort: 2,
      mainRoles: [],
      workerRoles: [],
      metricsRelayIntervalMs: 10_000,
    });
  });

  test('explicit options win over the config file, and an unset field falls through to it', () => {
    const config = Config.parseString('actor-ts.worker-mesh { workers = 4, worker-hostname = "core" }');
    const options = { module: 'file:///actors.js', workers: 8 } as WorkerMeshOptionsType;
    const resolved = withWorkerMeshConfigDefaults(options, config);

    expect(resolved.workers).toBe(8);
    expect(resolved.workerHostname).toBe('core');
    expect(resolved.module).toBe('file:///actors.js');
  });
});
