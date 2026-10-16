import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { Config, ConfigError } from '../../src/config/Config.js';
import { CoordinatedShutdownId, Phases, type Reason } from '../../src/CoordinatedShutdown.js';
import {
  CoordinatedStartup,
  CoordinatedStartupId,
  StartupFailedReason,
  StartupPhases,
} from '../../src/CoordinatedStartup.js';
import {
  CoordinatedStartupOptions,
  DEFAULT_STARTUP_PHASE_TIMEOUT_MS,
  type CoordinatedStartupOptionsType,
  type StartupTaskRegistration,
} from '../../src/CoordinatedStartupOptions.js';
import { LogLevel, NoopLogger, type Logger } from '../../src/Logger.js';
import { OptionsError } from '../../src/util/OptionsValidator.js';
import { RecordingLogger } from '../util/RecordingLogger.js';

/**
 * The startup graph the system runs itself (#1473).
 *
 * Every wait here is on a promise the code under test settles — a task's own
 * deferred, `whenReady()`, `whenTerminated()` — never on the clock.  The one
 * real duration is the 50 ms phase budget of the timeout cases, and those
 * await the rejection it produces rather than sleeping past it.
 */

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};

function deferred(): Deferred {
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const STILL_PENDING = Symbol('still pending');

/**
 * Whether `promise` has settled by now.  A promise that already has wins the
 * race, because its reaction is queued before the sentinel's.
 */
async function settledState(promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
  try {
    const value = await Promise.race([promise, Promise.resolve(STILL_PENDING)]);
    return value === STILL_PENDING ? 'pending' : 'resolved';
  } catch {
    return 'rejected';
  }
}

/** The error `promise` rejects with; fails the test when it resolves instead. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to reject, and it resolved');
}

function systemWith(
  startupOptions: CoordinatedStartupOptions,
  logger: Logger = new NoopLogger(),
  name = 'startup-unit',
): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Off)
    .withCoordinatedStartup(startupOptions);
  return ActorSystem.create(name, systemOptions);
}

/** A system whose configuration carries `hocon`, with `startupOptions` set in code over it. */
function systemConfiguredWith(
  hocon: string,
  startupOptions: CoordinatedStartupOptions = CoordinatedStartupOptions.create(),
  logger: Logger = new NoopLogger(),
): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon))
    .withCoordinatedStartup(startupOptions);
  return ActorSystem.create('startup-configured', systemOptions);
}

function task(
  phase: string,
  name: string,
  body: (signal: AbortSignal) => Promise<void> | void,
): StartupTaskRegistration {
  return { phase, name, task: body };
}

/**
 * Count the host timers armed with `delayMs` while `scenario` runs, and how
 * many of them are still armed when it is over — neither cleared nor fired.
 *
 * Keyed on the delay so the scheduler's, the shutdown pipeline's and the
 * keep-alive's timers stay out of the count; each scenario gives its phases a
 * budget nothing else in a system uses.  `armed` is the canary: zero of zero
 * would say nothing.
 */
async function timersLeftArmed(
  delayMs: number,
  scenario: () => Promise<void>,
): Promise<{ readonly armed: number; readonly leftArmed: number }> {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const live = new Set<unknown>();
  let armed = 0;
  globalThis.setTimeout = ((callback: (...callbackArguments: unknown[]) => void, delay?: number) => {
    if (delay !== delayMs) return realSetTimeout(callback, delay);
    armed++;
    const handle: unknown = realSetTimeout(() => {
      live.delete(handle);
      callback();
    }, delay);
    live.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: unknown) => {
    live.delete(handle);
    realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  try {
    await scenario();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  return { armed, leftArmed: live.size };
}

describe('CoordinatedStartup — phases and order', () => {
  test('tasks run in phase order: persistence-start, then before-system-ready', async () => {
    const trace: string[] = [];
    // Registered against the phase order on purpose: the order a run follows
    // is the phases', never the list's.
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.BeforeSystemReady, 'warm-cache', () => { trace.push('before-system-ready'); }),
      task(StartupPhases.PersistenceStart, 'open-journal', () => { trace.push('persistence-start'); }),
    ]);
    const system = systemWith(startupOptions);
    await system.whenReady();
    expect(trace).toEqual(['persistence-start', 'before-system-ready']);
    await system.terminate();
  });

  test('a declared phase runs after the phase it depends on', async () => {
    const trace: string[] = [];
    const startupOptions = CoordinatedStartupOptions.create()
      .withPhases([
        { name: 'announce', timeoutMs: 1_000, dependsOn: [StartupPhases.BeforeSystemReady], recover: false },
      ])
      .withTasks([
        task('announce', 'say-hello', () => { trace.push('announce'); }),
        task(StartupPhases.BeforeSystemReady, 'warm-cache', () => { trace.push('before-system-ready'); }),
        task(StartupPhases.PersistenceStart, 'open-journal', () => { trace.push('persistence-start'); }),
      ]);
    const system = systemWith(startupOptions);
    await system.whenReady();
    expect(trace).toEqual(['persistence-start', 'before-system-ready', 'announce']);
    await system.terminate();
  });

  // The only way to put a phase *between* the two canonical ones: declare it
  // after the first, and add it to the second's dependencies.
  test('dependsOn on a canonical phase is added to its seeded edge, so a declared phase can sit between them', async () => {
    const trace: string[] = [];
    const startupOptions = CoordinatedStartupOptions.create()
      .withPhases([
        { name: 'migrate', timeoutMs: 1_000, dependsOn: [StartupPhases.PersistenceStart], recover: false },
        { name: StartupPhases.BeforeSystemReady, timeoutMs: 2_000, dependsOn: ['migrate'], recover: false },
      ])
      .withTasks([
        task(StartupPhases.BeforeSystemReady, 'warm-cache', () => { trace.push('before-system-ready'); }),
        task('migrate', 'run-migrations', () => { trace.push('migrate'); }),
        task(StartupPhases.PersistenceStart, 'open-journal', () => { trace.push('persistence-start'); }),
      ]);
    const system = systemWith(startupOptions);
    await system.whenReady();
    expect(trace).toEqual(['persistence-start', 'migrate', 'before-system-ready']);
    const merged = system.extension(CoordinatedStartupId).phaseDefinition(StartupPhases.BeforeSystemReady);
    expect(merged?.timeoutMs).toBe(2_000);
    expect(merged?.dependsOn).toEqual([StartupPhases.PersistenceStart, 'migrate']);
    await system.terminate();
  });

  test('tasks of one phase run concurrently', async () => {
    // One trace for both tasks: run one after the other they would read
    // `start-a, end-a, start-b, end-b`, together both starts come first.
    const trace: string[] = [];
    const release = deferred();
    const firstStarted = deferred();
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.PersistenceStart, 'a', async () => {
        trace.push('start-a');
        firstStarted.resolve();
        await release.promise;
        trace.push('end-a');
      }),
      task(StartupPhases.PersistenceStart, 'b', async () => {
        trace.push('start-b');
        await release.promise;
        trace.push('end-b');
      }),
    ]);
    const system = systemWith(startupOptions);
    await firstStarted.promise;
    // Released either way, so a sequential run finishes and fails the
    // assertion rather than hanging the test.
    release.resolve();
    await system.whenReady();
    expect(trace).toEqual(['start-a', 'start-b', 'end-a', 'end-b']);
    await system.terminate();
  });

  test('a task passed through withCoordinatedStartup runs with no call in main', async () => {
    const ran = deferred();
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.PersistenceStart, 'open-journal', () => { ran.resolve(); }),
    ]);
    const system = systemWith(startupOptions);
    // Nothing is called between `create` and here: the system started the
    // graph by itself.
    await ran.promise;
    await system.whenReady();
    expect(system.extension(CoordinatedStartupId).isComplete).toBe(true);
    await system.terminate();
  });

  test('no task runs inside ActorSystem.create — a task may refer to the system create returned', async () => {
    const seen: string[] = [];
    let ranInsideCreate = true;
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.PersistenceStart, 'name-the-system', () => {
        seen.push(system.name);
        ranInsideCreate = false;
      }),
    ]);
    const system = systemWith(startupOptions, new NoopLogger(), 'refers-to-itself');
    expect(seen).toEqual([]);
    await system.whenReady();
    expect(ranInsideCreate).toBe(false);
    expect(seen).toEqual(['refers-to-itself']);
    await system.terminate();
  });
});

describe('CoordinatedStartup — whenReady', () => {
  test('a system with no tasks is ready at once, with the same promise every call and no timer armed', async () => {
    const realSetTimeout = globalThis.setTimeout;
    let armedDuringCreate = 0;
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      armedDuringCreate++;
      return realSetTimeout(callback, delay);
    }) as typeof setTimeout;
    let system: ActorSystem;
    try {
      system = systemWith(CoordinatedStartupOptions.create());
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(armedDuringCreate).toBe(0);
    expect(system.whenReady()).toBe(system.whenReady());
    expect(await settledState(system.whenReady())).toBe('resolved');
    const startup = system.extension(CoordinatedStartupId);
    expect(startup.hasTasks).toBe(false);
    expect(startup.isComplete).toBe(true);
    expect(startup.isRunning).toBe(false);
    await system.terminate();
  });

  test('a system created without the option is ready at once too', async () => {
    const system = ActorSystem.create('startup-plain', ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off));
    expect(await settledState(system.whenReady())).toBe('resolved');
    expect(system.extension(CoordinatedStartupId)).toBeInstanceOf(CoordinatedStartup);
    await system.terminate();
  });

  test('with tasks, whenReady is pending until the last phase is done, and the same promise throughout', async () => {
    const release = deferred();
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.BeforeSystemReady, 'held', () => release.promise),
    ]);
    const system = systemWith(startupOptions);
    const first = system.whenReady();
    expect(await settledState(first)).toBe('pending');
    const startup = system.extension(CoordinatedStartupId);
    expect(startup.isRunning).toBe(true);
    expect(startup.isComplete).toBe(false);
    release.resolve();
    await first;
    expect(system.whenReady()).toBe(first);
    expect(startup.isRunning).toBe(false);
    expect(startup.isComplete).toBe(true);
    expect(startup.runningPhase).toBeUndefined();
    await system.terminate();
  });
});

describe('CoordinatedStartup — registration and options', () => {
  test('addTask and addPhase on a constructed system throw, naming withCoordinatedStartup', async () => {
    const system = systemWith(CoordinatedStartupOptions.create());
    const startup = system.extension(CoordinatedStartupId);
    expect(() => startup.addTask(StartupPhases.PersistenceStart, 'late', () => {}))
      .toThrow(/ActorSystemOptions\.withCoordinatedStartup/);
    expect(() => startup.addPhase({
      name: 'late-phase',
      timeoutMs: 1_000,
      dependsOn: [StartupPhases.PersistenceStart],
      recover: false,
    })).toThrow(/ActorSystemOptions\.withCoordinatedStartup/);
    await system.terminate();
  });

  test('a task for an unknown phase is refused at ActorSystem.create', () => {
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task('persistence-starts', 'typo', () => {}),
    ]);
    expect(() => systemWith(startupOptions)).toThrow(OptionsError);
    expect(() => systemWith(startupOptions)).toThrow(/tasks\[0\]\.phase names an unknown phase/);
  });

  test('a duplicate task name within a phase is refused, the same name in another phase is not', async () => {
    const duplicated = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.PersistenceStart, 'open', () => {}),
      task(StartupPhases.PersistenceStart, 'open', () => {}),
    ]);
    expect(() => systemWith(duplicated)).toThrow(OptionsError);
    expect(() => systemWith(duplicated)).toThrow(/tasks\[1\]\.name is already registered in phase "persistence-start"/);

    const twoPhases = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.PersistenceStart, 'open', () => {}),
      task(StartupPhases.BeforeSystemReady, 'open', () => {}),
    ]);
    const system = systemWith(twoPhases);
    await system.whenReady();
    await system.terminate();
  });

  test('a declared phase without dependsOn is refused at ActorSystem.create', () => {
    const startupOptions = CoordinatedStartupOptions.create().withPhases([
      { name: 'floating', timeoutMs: 1_000, dependsOn: [], recover: false },
    ]);
    expect(() => systemWith(startupOptions)).toThrow(OptionsError);
    expect(() => systemWith(startupOptions)).toThrow(/phases\[0\]\.dependsOn must name the phase it runs after/);
  });

  test('a non-positive timeout is refused, as a default and on a phase', () => {
    const zeroDefault = CoordinatedStartupOptions.create().withDefaultPhaseTimeoutMs(0);
    expect(() => systemWith(zeroDefault)).toThrow(/defaultPhaseTimeoutMs must be a positive finite number/);
    const negativePhase = CoordinatedStartupOptions.create().withPhases([
      { name: StartupPhases.PersistenceStart, timeoutMs: -1, dependsOn: [], recover: false },
    ]);
    expect(() => systemWith(negativePhase)).toThrow(/phases\[0\]\.timeoutMs must be a positive finite number/);
  });

  test('a dependency on a phase that exists nowhere is refused', () => {
    const startupOptions = CoordinatedStartupOptions.create().withPhases([
      { name: 'after-nothing', timeoutMs: 1_000, dependsOn: ['no-such-phase'], recover: false },
    ]);
    expect(() => systemWith(startupOptions)).toThrow(/names "no-such-phase", which is neither a startup phase nor one declared here/);
  });

  test('phases that depend on each other in a cycle are refused', () => {
    const startupOptions = CoordinatedStartupOptions.create().withPhases([
      { name: StartupPhases.PersistenceStart, timeoutMs: 1_000, dependsOn: ['loop'], recover: false },
      { name: 'loop', timeoutMs: 1_000, dependsOn: [StartupPhases.BeforeSystemReady], recover: false },
    ]);
    expect(() => systemWith(startupOptions)).toThrow(OptionsError);
    expect(() => systemWith(startupOptions)).toThrow(/cycle/);
  });

  test('the default budget is the one every seeded phase starts with', async () => {
    const plain = systemWith(CoordinatedStartupOptions.create());
    expect(plain.extension(CoordinatedStartupId).phaseDefinition(StartupPhases.PersistenceStart)?.timeoutMs)
      .toBe(DEFAULT_STARTUP_PHASE_TIMEOUT_MS);
    const plainObject: Partial<CoordinatedStartupOptionsType> = { defaultPhaseTimeoutMs: 1_234 };
    const tuned = systemWith(plainObject);
    expect(tuned.extension(CoordinatedStartupId).phaseDefinition(StartupPhases.BeforeSystemReady)?.timeoutMs)
      .toBe(1_234);
    await plain.terminate();
    await tuned.terminate();
  });
});

describe('CoordinatedStartup — actor-ts.coordinated-startup', () => {
  const persistenceStartTimeout = (system: ActorSystem): number | undefined =>
    system.extension(CoordinatedStartupId).phaseDefinition(StartupPhases.PersistenceStart)?.timeoutMs;

  test('the default budget: withCoordinatedStartup beats the configuration, which beats the built-in default', async () => {
    const builtIn = systemConfiguredWith('actor-ts.system.name = x');
    const configured = systemConfiguredWith('actor-ts.coordinated-startup.default-phase-timeout = 12s');
    const explicit = systemConfiguredWith(
      'actor-ts.coordinated-startup.default-phase-timeout = 12s',
      CoordinatedStartupOptions.create().withDefaultPhaseTimeoutMs(3_456),
    );
    try {
      expect(persistenceStartTimeout(builtIn)).toBe(DEFAULT_STARTUP_PHASE_TIMEOUT_MS);
      expect(persistenceStartTimeout(configured)).toBe(12_000);
      expect(configured.extension(CoordinatedStartupId).phaseDefinition(StartupPhases.BeforeSystemReady)?.timeoutMs)
        .toBe(12_000);
      expect(persistenceStartTimeout(explicit)).toBe(3_456);
    } finally {
      await builtIn.terminate();
      await configured.terminate();
      await explicit.terminate();
    }
  });

  test('a phase the options name is theirs as a whole; the configuration still retimes and declares the others', async () => {
    const hocon = `
      actor-ts.coordinated-startup.phases {
        persistence-start { timeout = 7s, recover = true }
        warm-caches { depends-on = ["persistence-start"] }
        before-system-ready { timeout = 9s, recover = true, depends-on = ["warm-caches"] }
      }
    `;
    const startupOptions = CoordinatedStartupOptions.create().withPhases([
      { name: StartupPhases.BeforeSystemReady, timeoutMs: 2_000, dependsOn: [], recover: false },
    ]);
    const system = systemConfiguredWith(hocon, startupOptions);
    try {
      const startup = system.extension(CoordinatedStartupId);
      // The code's entry over the seed: the file's timeout, recover and edge
      // for this phase are not applied, the seeded edge is kept.
      expect(startup.phaseDefinition(StartupPhases.BeforeSystemReady)).toEqual({
        name: StartupPhases.BeforeSystemReady,
        timeoutMs: 2_000,
        dependsOn: [StartupPhases.PersistenceStart],
        recover: false,
      });
      expect(startup.phaseDefinition(StartupPhases.PersistenceStart))
        .toEqual({ name: StartupPhases.PersistenceStart, timeoutMs: 7_000, dependsOn: [], recover: true });
      expect(startup.phaseDefinition('warm-caches')).toEqual({
        name: 'warm-caches',
        timeoutMs: DEFAULT_STARTUP_PHASE_TIMEOUT_MS,
        dependsOn: [StartupPhases.PersistenceStart],
        recover: false,
      });
    } finally {
      await system.terminate();
    }
  });

  test('phases.persistence-start.timeout from the configuration bounds that phase', async () => {
    let observedSignal: AbortSignal | undefined;
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.PersistenceStart, 'connect-without-a-timeout', (signal) => {
        observedSignal = signal;
        return new Promise<void>(() => {});
      }),
    ]);
    const system = systemConfiguredWith(
      'actor-ts.coordinated-startup.phases.persistence-start.timeout = 50ms',
      startupOptions,
    );
    try {
      // A child that only retimes keeps what the phase was seeded with.
      expect(system.extension(CoordinatedStartupId).phaseDefinition(StartupPhases.PersistenceStart))
        .toEqual({ name: StartupPhases.PersistenceStart, timeoutMs: 50, dependsOn: [], recover: false });
      expect(system.extension(CoordinatedStartupId).phaseDefinition(StartupPhases.BeforeSystemReady)?.timeoutMs)
        .toBe(DEFAULT_STARTUP_PHASE_TIMEOUT_MS);
      const error = await rejectionOf(system.whenReady());
      expect(error.message).toContain('"connect-without-a-timeout"');
      expect((error.cause as Error).message).toContain('50 ms budget ran out');
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      // Already on its way down after the failed startup; a terminate() also
      // ends the run when the budget was not applied and the task still hangs.
      await system.terminate();
      await system.whenTerminated();
    }
  });

  test('a phase the configuration declares runs where its depends-on puts it, and a task passed in code can run in it', async () => {
    const trace: string[] = [];
    const hocon = `
      actor-ts.coordinated-startup.phases {
        warm-caches { depends-on = ["persistence-start"] }
        before-system-ready { depends-on = ["warm-caches"] }
      }
    `;
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.BeforeSystemReady, 'last', () => { trace.push('before-system-ready'); }),
      task('warm-caches', 'prefetch', () => { trace.push('warm-caches'); }),
      task(StartupPhases.PersistenceStart, 'first', () => { trace.push('persistence-start'); }),
    ]);
    const system = systemConfiguredWith(hocon, startupOptions);
    try {
      await system.whenReady();
      expect(trace).toEqual(['persistence-start', 'warm-caches', 'before-system-ready']);
      const startup = system.extension(CoordinatedStartupId);
      // Added to the seeded edge, never a replacement.
      expect(startup.phaseDefinition(StartupPhases.BeforeSystemReady)?.dependsOn)
        .toEqual([StartupPhases.PersistenceStart, 'warm-caches']);
      expect(startup.phaseDefinition('warm-caches')).toEqual({
        name: 'warm-caches',
        timeoutMs: DEFAULT_STARTUP_PHASE_TIMEOUT_MS,
        dependsOn: [StartupPhases.PersistenceStart],
        recover: false,
      });
    } finally {
      await system.terminate();
    }
  });

  test('a declared phase recovers only when it says so', async () => {
    const failing = (): CoordinatedStartupOptions => CoordinatedStartupOptions.create().withTasks([
      task('warm-caches', 'prefetch', () => { throw new Error('cache cold'); }),
    ]);
    const recovering = systemConfiguredWith(
      'actor-ts.coordinated-startup.phases.warm-caches { depends-on = ["persistence-start"], recover = true }',
      failing(),
    );
    const strict = systemConfiguredWith(
      'actor-ts.coordinated-startup.phases.warm-caches { depends-on = ["persistence-start"] }',
      failing(),
    );
    try {
      await recovering.whenReady();
      expect(recovering.isTerminated).toBe(false);
      const error = await rejectionOf(strict.whenReady());
      expect(error.message).toContain('"prefetch"');
      expect(error.message).toContain('"warm-caches"');
    } finally {
      await recovering.terminate();
      // On its way down already when the phase did not recover; terminate()
      // also ends a system that recovered where it should not have.
      await strict.terminate();
      await strict.whenTerminated();
    }
  });

  test('an unknown phase setting, a declared phase without depends-on and a cycle are ConfigErrors at ActorSystem.create', () => {
    const refusals: ReadonlyArray<readonly [string, RegExp]> = [
      [
        'actor-ts.coordinated-startup.phases.persistence-start.timout = 5s',
        /actor-ts\.coordinated-startup\.phases\.persistence-start\.timout is not a phase setting/,
      ],
      [
        'actor-ts.coordinated-startup.phases.warm-caches.timeout = 5s',
        /actor-ts\.coordinated-startup\.phases\.warm-caches declares a new phase, so it must name depends-on/,
      ],
      [
        'actor-ts.coordinated-startup.phases.persistence-start.depends-on = ["before-system-ready"]',
        /actor-ts\.coordinated-startup\.phases: the phases depend on each other in a cycle: before-system-ready, persistence-start/,
      ],
      [
        'actor-ts.coordinated-startup.phases.warm-caches.depends-on = ["no-such-phase"]',
        /warm-caches\.depends-on names "no-such-phase", which is neither a startup phase nor another phase declared here/,
      ],
      [
        'actor-ts.coordinated-startup.phases.persistence-start.timeout = 0s',
        /persistence-start\.timeout must be a positive duration/,
      ],
    ];
    for (const [hocon, message] of refusals) {
      expect(() => systemConfiguredWith(hocon), hocon).toThrow(ConfigError);
      expect(() => systemConfiguredWith(hocon), hocon).toThrow(message);
    }
  });

  test('a cycle the options tie through a phase the configuration declares is the options\' mistake', () => {
    const startupOptions = CoordinatedStartupOptions.create().withPhases([
      { name: StartupPhases.PersistenceStart, timeoutMs: 1_000, dependsOn: ['warm-caches'], recover: false },
    ]);
    const create = (): ActorSystem => systemConfiguredWith(
      'actor-ts.coordinated-startup.phases.warm-caches.depends-on = ["persistence-start"]',
      startupOptions,
    );
    expect(create).toThrow(OptionsError);
    expect(create).toThrow(/cycle/);
  });
});

describe('CoordinatedStartup — a failed startup', () => {
  test('a task that rejects stops the run, takes the system down once with StartupFailedReason, and ends runUntilTerminated', async () => {
    const logger = new RecordingLogger();
    const cause = new Error('connection refused');
    let laterPhaseRan = false;
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.PersistenceStart, 'open-journal', async () => { throw cause; }),
      task(StartupPhases.BeforeSystemReady, 'warm-cache', () => { laterPhaseRan = true; }),
    ]);
    const system = systemWith(startupOptions, logger);
    // Registered before the first phase has had a chance to run: `create`
    // returns before any task does.
    const shutdownReasons: Reason[] = [];
    system.extension(CoordinatedShutdownId).addTask(Phases.BeforeServiceUnbind, 'observe', (reason) => {
      shutdownReasons.push(reason);
    });
    const running = system.runUntilTerminated([]);

    const error = await rejectionOf(system.whenReady());
    expect(error.message).toContain('"open-journal"');
    expect(error.message).toContain('"persistence-start"');
    expect(error.cause).toBe(cause);

    expect(await rejectionOf(running)).toBe(error);
    expect(system.isTerminated).toBe(true);
    expect(laterPhaseRan).toBe(false);
    expect(shutdownReasons).toHaveLength(1);
    const reason = shutdownReasons[0] as StartupFailedReason;
    expect(reason).toBeInstanceOf(StartupFailedReason);
    expect(reason.phase).toBe(StartupPhases.PersistenceStart);
    expect(reason.task).toBe('open-journal');
    expect(reason.cause).toBe(cause);
    const errorLines = logger.records.filter((record) => record.level === 'error');
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]!.message).toContain('"open-journal"');
    expect(system.extension(CoordinatedStartupId).failure).toBe(error);
    expect(system.extension(CoordinatedStartupId).isComplete).toBe(false);
  });

  test('runUntilTerminated() ends with the startup error even when the shutdown it started halts on the way down', async () => {
    // The halt is the consequence of the failed startup, and it has already
    // been logged; the startup error is the cause a `main` has to exit with.
    const startupCause = new Error('connection refused');
    const shutdownCause = new Error('flush failed');
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.PersistenceStart, 'open-journal', async () => { throw startupCause; }),
    ]);
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { 'coordinated-shutdown': { phases: { 'before-service-unbind': { recover: false } } } } })
      .withCoordinatedStartup(startupOptions);
    const system = ActorSystem.create('startup-unit', systemOptions);
    const coordinatedShutdown = system.extension(CoordinatedShutdownId);
    coordinatedShutdown.addTask(Phases.BeforeServiceUnbind, 'flush', () => { throw shutdownCause; });
    const running = system.runUntilTerminated([]);

    const startupError = await rejectionOf(system.whenReady());
    const ended = await rejectionOf(running);
    // The precondition the order is about: the pipeline really did halt.
    expect(await rejectionOf(coordinatedShutdown.run())).toBe(shutdownCause);
    expect(system.isTerminated).toBe(true);
    expect(ended).toBe(startupError);
    expect(ended.cause).toBe(startupCause);
  });

  test('a task that throws synchronously fails the same way', async () => {
    const cause = new Error('bad connection string');
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.BeforeSystemReady, 'parse-settings', () => { throw cause; }),
    ]);
    const system = systemWith(startupOptions);
    const error = await rejectionOf(system.whenReady());
    expect(error.message).toContain('"parse-settings"');
    expect(error.message).toContain('"before-system-ready"');
    expect(error.cause).toBe(cause);
    await system.whenTerminated();
  });

  test('a task that outlives its phase budget fails the phase, and its signal aborts with the cause', async () => {
    const logger = new RecordingLogger();
    let observedSignal: AbortSignal | undefined;
    let laterPhaseRan = false;
    const startupOptions = CoordinatedStartupOptions.create()
      .withPhases([{ name: StartupPhases.PersistenceStart, timeoutMs: 50, dependsOn: [], recover: false }])
      .withTasks([
        task(StartupPhases.PersistenceStart, 'connect-without-a-timeout', (signal) => {
          observedSignal = signal;
          return new Promise<void>(() => {});
        }),
        task(StartupPhases.BeforeSystemReady, 'warm-cache', () => { laterPhaseRan = true; }),
      ]);
    const system = systemWith(startupOptions, logger);
    // The same way down as a task that rejects: one pipeline run, with the
    // reason, and the error at the end of runUntilTerminated().
    const shutdownReasons: Reason[] = [];
    system.extension(CoordinatedShutdownId).addTask(Phases.BeforeServiceUnbind, 'observe', (reason) => {
      shutdownReasons.push(reason);
    });
    const running = system.runUntilTerminated([]);
    const error = await rejectionOf(system.whenReady());
    expect(error.message).toContain('"connect-without-a-timeout"');
    expect(error.message).toContain('"persistence-start"');
    expect((error.cause as Error).message).toContain('50 ms budget ran out');
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe(error.cause);
    expect(await rejectionOf(running)).toBe(error);
    expect(system.isTerminated).toBe(true);
    expect(laterPhaseRan).toBe(false);
    expect(shutdownReasons).toHaveLength(1);
    expect(shutdownReasons[0]).toBeInstanceOf(StartupFailedReason);
    expect((shutdownReasons[0] as StartupFailedReason).task).toBe('connect-without-a-timeout');
    expect((shutdownReasons[0] as StartupFailedReason).cause).toBe(error.cause);
    expect(logger.records.filter((record) => record.level === 'error')).toHaveLength(1);
  });

  test('the other tasks of a failing phase are aborted, naming the task that failed', async () => {
    let siblingSignal: AbortSignal | undefined;
    const siblingStarted = deferred();
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.PersistenceStart, 'slow-sibling', (signal) => {
        siblingSignal = signal;
        siblingStarted.resolve();
        return new Promise<void>(() => {});
      }),
      task(StartupPhases.PersistenceStart, 'failing', async () => {
        await siblingStarted.promise;
        throw new Error('down');
      }),
    ]);
    const system = systemWith(startupOptions);
    const error = await rejectionOf(system.whenReady());
    expect(error.message).toContain('"failing"');
    expect(siblingSignal?.aborted).toBe(true);
    expect((siblingSignal?.reason as Error).message).toContain('task "failing"');
    await system.whenTerminated();
  });

  test('a declared phase with recover: true logs the failure and startup goes on', async () => {
    const logger = new RecordingLogger();
    let laterRan = false;
    const startupOptions = CoordinatedStartupOptions.create()
      .withPhases([
        { name: 'optional-warmup', timeoutMs: 1_000, dependsOn: [StartupPhases.PersistenceStart], recover: true },
        { name: StartupPhases.BeforeSystemReady, timeoutMs: 1_000, dependsOn: ['optional-warmup'], recover: false },
      ])
      .withTasks([
        task('optional-warmup', 'prefetch', () => { throw new Error('cache cold'); }),
        task(StartupPhases.BeforeSystemReady, 'later', () => { laterRan = true; }),
      ]);
    const system = systemWith(startupOptions, logger);
    await system.whenReady();
    expect(laterRan).toBe(true);
    const warnings = logger.records.filter((record) => record.level === 'warn');
    expect(warnings.some((record) => record.message.includes('"prefetch"'))).toBe(true);
    expect(logger.records.filter((record) => record.level === 'error')).toHaveLength(0);
    expect(system.isTerminated).toBe(false);
    await system.terminate();
  });
});

describe('CoordinatedStartup — terminate() during startup', () => {
  test('aborts the running task, skips the later phases, rejects whenReady and runs no startup-failure pipeline', async () => {
    const logger = new RecordingLogger();
    const started = deferred();
    let runningSignal: AbortSignal | undefined;
    let laterPhaseRan = false;
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.PersistenceStart, 'held-open', (signal) => {
        runningSignal = signal;
        started.resolve();
        return new Promise<void>(() => {});
      }),
      task(StartupPhases.BeforeSystemReady, 'warm-cache', () => { laterPhaseRan = true; }),
    ]);
    const system = systemWith(startupOptions, logger);
    const shutdownReasons: Reason[] = [];
    system.extension(CoordinatedShutdownId).addTask(Phases.BeforeServiceUnbind, 'observe', (reason) => {
      shutdownReasons.push(reason);
    });
    const running = system.runUntilTerminated([]);
    await started.promise;

    await system.terminate();
    await running;

    expect(runningSignal?.aborted).toBe(true);
    expect((runningSignal?.reason as Error).message).toContain('abandoned');
    const error = await rejectionOf(system.whenReady());
    expect(error.message).toContain('abandoned');
    expect(error.message).toContain('"persistence-start"');
    expect(laterPhaseRan).toBe(false);
    expect(shutdownReasons).toEqual([]);
    expect(system.extension(CoordinatedStartupId).failure).toBeUndefined();
    expect(logger.records.filter((record) => record.level === 'error')).toHaveLength(0);
    expect(logger.records.some((record) => record.level === 'debug' && record.message.includes('abandoned'))).toBe(true);
  });

  test('a terminate() before the first phase began means no task runs at all', async () => {
    let ran = false;
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.PersistenceStart, 'never', () => { ran = true; }),
    ]);
    const system = systemWith(startupOptions);
    const terminated = system.terminate();
    const error = await rejectionOf(system.whenReady());
    expect(error.message).toContain('before its first phase began');
    await terminated;
    expect(ran).toBe(false);
  });

  // The abandonment comes first, before the pipeline's first phase: a startup
  // task has no business running on while the node is unbinding and leaving.
  test('a pipeline run through terminate({ runCoordinatedShutdown: true }) abandons first and carries its own reason', async () => {
    const started = deferred();
    let runningSignal: AbortSignal | undefined;
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.PersistenceStart, 'held-open', (signal) => {
        runningSignal = signal;
        started.resolve();
        return new Promise<void>(() => {});
      }),
    ]);
    const system = systemWith(startupOptions);
    const shutdownReasons: string[] = [];
    const abortedWhenThePipelineStarted: boolean[] = [];
    system.extension(CoordinatedShutdownId).addTask(Phases.BeforeServiceUnbind, 'observe', (reason) => {
      shutdownReasons.push(reason.name);
      abortedWhenThePipelineStarted.push(runningSignal?.aborted ?? false);
    });
    await started.promise;
    await system.terminate({ runCoordinatedShutdown: true });
    expect(shutdownReasons).toEqual(['ActorSystemTerminateReason']);
    expect(abortedWhenThePipelineStarted).toEqual([true]);
    expect(await settledState(system.whenReady())).toBe('rejected');
  });

  // A signal reaches the system through the pipeline and never through
  // `terminate()`: the teardown in the pipeline's last phase is what has to
  // abandon a startup still running.
  test('a pipeline started any other way abandons the startup when it tears the system down', async () => {
    const started = deferred();
    let runningSignal: AbortSignal | undefined;
    const startupOptions = CoordinatedStartupOptions.create().withTasks([
      task(StartupPhases.PersistenceStart, 'held-open', (signal) => {
        runningSignal = signal;
        started.resolve();
        return new Promise<void>(() => {});
      }),
    ]);
    const system = systemWith(startupOptions);
    await started.promise;
    await system.extension(CoordinatedShutdownId).run();
    expect(system.isTerminated).toBe(true);
    expect(runningSignal?.aborted).toBe(true);
    const error = await rejectionOf(system.whenReady());
    expect(error.message).toContain('abandoned');
    expect(system.extension(CoordinatedStartupId).failure).toBeUndefined();
  });
});

describe('CoordinatedStartup — a failure nobody awaits', () => {
  test('raises no unhandled rejection: the failure has its own log line and its own shutdown', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const startupOptions = CoordinatedStartupOptions.create().withTasks([
        task(StartupPhases.PersistenceStart, 'open-journal', () => { throw new Error('refused'); }),
      ]);
      const system = systemWith(startupOptions);
      await system.whenTerminated();
      // One macrotask turn, because the rejection tracker reports once the
      // microtask queue has drained — not a wait for anything to happen.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('CoordinatedStartup — no budget timer outlives the run', () => {
  // A budget nothing else in a system uses, so the count sees only these.
  const BUDGET_MS = 4_321;

  test('after a startup that completes', async () => {
    const { armed, leftArmed } = await timersLeftArmed(BUDGET_MS, async () => {
      const startupOptions = CoordinatedStartupOptions.create()
        .withDefaultPhaseTimeoutMs(BUDGET_MS)
        .withTasks([
          task(StartupPhases.PersistenceStart, 'a', () => {}),
          task(StartupPhases.BeforeSystemReady, 'b', async () => {}),
        ]);
      const system = systemWith(startupOptions);
      await system.whenReady();
      await system.terminate();
    });
    expect(armed).toBe(2);
    expect(leftArmed).toBe(0);
  });

  test('after a startup that fails, with a sibling still running', async () => {
    const { armed, leftArmed } = await timersLeftArmed(BUDGET_MS, async () => {
      const siblingStarted = deferred();
      const startupOptions = CoordinatedStartupOptions.create()
        .withDefaultPhaseTimeoutMs(BUDGET_MS)
        .withTasks([
          task(StartupPhases.PersistenceStart, 'sibling', () => {
            siblingStarted.resolve();
            return new Promise<void>(() => {});
          }),
          task(StartupPhases.PersistenceStart, 'failing', async () => {
            await siblingStarted.promise;
            throw new Error('down');
          }),
          task(StartupPhases.BeforeSystemReady, 'never-armed', () => {}),
        ]);
      const system = systemWith(startupOptions);
      await rejectionOf(system.whenReady());
      await system.whenTerminated();
    });
    expect(armed).toBe(2);
    expect(leftArmed).toBe(0);
  });

  test('after a phase budget runs out', async () => {
    const shortBudgetMs = 47;
    const { armed, leftArmed } = await timersLeftArmed(shortBudgetMs, async () => {
      const startupOptions = CoordinatedStartupOptions.create()
        .withDefaultPhaseTimeoutMs(shortBudgetMs)
        .withTasks([
          task(StartupPhases.PersistenceStart, 'hangs', () => new Promise<void>(() => {})),
          task(StartupPhases.PersistenceStart, 'also-hangs', () => new Promise<void>(() => {})),
        ]);
      const system = systemWith(startupOptions);
      await rejectionOf(system.whenReady());
      await system.whenTerminated();
    });
    expect(armed).toBe(2);
    expect(leftArmed).toBe(0);
  });

  test('after a startup abandoned by terminate()', async () => {
    const { armed, leftArmed } = await timersLeftArmed(BUDGET_MS, async () => {
      const started = deferred();
      const startupOptions = CoordinatedStartupOptions.create()
        .withDefaultPhaseTimeoutMs(BUDGET_MS)
        .withTasks([
          task(StartupPhases.PersistenceStart, 'held-open', () => {
            started.resolve();
            return new Promise<void>(() => {});
          }),
        ]);
      const system = systemWith(startupOptions);
      await started.promise;
      await system.terminate();
      await rejectionOf(system.whenReady());
    });
    expect(armed).toBe(1);
    expect(leftArmed).toBe(0);
  });
});
