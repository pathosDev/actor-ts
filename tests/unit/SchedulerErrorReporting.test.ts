import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ActorPath } from '../../src/ActorPath.js';
import { ActorRef } from '../../src/ActorRef.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger, type Logger } from '../../src/Logger.js';
import type { LogContextData } from '../../src/LogContext.js';
import { Scheduler } from '../../src/Scheduler.js';
import { SchedulerError } from '../../src/SystemMessages.js';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';
import { awaitCondition } from '../util/AwaitCondition.js';

/**
 * A throwing scheduled task used to reach `console.error` and nothing else —
 * invisible to every log sink, to the event stream, and to a test (#678).
 *
 * The tests the fix inherited could not tell a working channel from no channel
 * at all: all three of them replaced `console.error` with a no-op and asserted
 * only that the schedule survived, and one asserted nothing but
 * `expect(true).toBe(true)`.  So every assertion here is about the
 * *destination*, and the console is captured rather than silenced so that
 * "it did not also go to the terminal" is checkable.
 *
 * `scheduleOnce` / `scheduleAtFixedRate` are deliberately absent: those `tell`
 * a target, and a throw inside the target's handler belongs to its supervisor.
 * What this channel is for is the two bare-closure forms, which run inside a
 * raw timer callback with no cell and no parent above them.
 */

/** Records events without a cell, so a report cannot re-enter the scheduler. */
class RecordingRef extends ActorRef<unknown> {
  readonly path: ActorPath;
  readonly received: unknown[] = [];
  constructor(pathName: string) {
    super();
    this.path = new ActorPath('', null, 'test-sys').child(pathName);
  }
  tell(message: unknown): void { this.received.push(message); }
}

/** The system logger, kept so the test can read what was written to it. */
class RecordingLogger implements Logger {
  readonly errors: Array<{ message: string; args: unknown[] }> = [];

  constructor(
    public level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  debug(_message: string): void {}
  info(_message: string): void {}
  warn(_message: string): void {}
  error(message: string, ...args: unknown[]): void { this.sink.errors.push({ message, args }); }

  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}

/**
 * Widens the protected report to public so a test can drive it without a live
 * timer.
 *
 * Needed for the teardown case specifically: `terminate()` calls
 * `scheduler.shutdown()`, which disarms every handle, so a lent scheduler
 * cannot be made to fire a *real* task after the system is gone — and
 * "reports fall back to the console once the slot is cleared" is exactly the
 * claim that matters there.  Driving the report directly is the only way to
 * observe it, and it is the same method the guard calls.
 */
class ReportableScheduler extends Scheduler {
  reportDirectly(error: unknown): void { this.reportTaskError(error); }
}

let consoleErrors: unknown[][];
const originalConsoleError = console.error;

beforeEach(() => {
  consoleErrors = [];
  console.error = ((...args: unknown[]) => { consoleErrors.push(args); }) as typeof console.error;
});

afterEach(() => {
  console.error = originalConsoleError;
});

const quietSystemOptions = (): ActorSystemOptions => ActorSystemOptions.create()
  .withLogger(new NoopLogger())
  .withLogLevel(LogLevel.Off);

describe('scheduler failures reach the logger and the EventStream (#678)', () => {
  test('a throwing scheduleOnceFunction task is logged and published, not printed', async () => {
    const logger = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(logger)
      .withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create('scheduler-error-once', systemOptions);
    try {
      const probe = new RecordingRef('probe');
      system.eventStream.subscribe(probe, SchedulerError);

      system.scheduler.scheduleOnceFunction(1, () => { throw new Error('boom'); });
      await awaitCondition(() => probe.received.length === 1, {
        timeoutMs: 4_000,
        label: 'the failed scheduled task was published on the event stream',
      });

      const event = probe.received[0] as SchedulerError;
      expect(event).toBeInstanceOf(SchedulerError);
      expect(event.cause).toBeInstanceOf(Error);
      expect(event.cause.message).toBe('boom');
      expect(String(event)).toBe('SchedulerError(boom)');

      // The same failure reached the system logger, which is what puts it in
      // front of every sink the logging subsystem has.
      const logged = logger.errors.filter((e) => e.message.includes('Unhandled scheduler error'));
      expect(logged.length).toBe(1);
      expect((logged[0]!.args[0] as Error).message).toBe('boom');

      // And it did NOT go to the console: that branch is the last resort for a
      // scheduler with no sink, not a second copy of every report.
      expect(consoleErrors).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a throwing tick is reported and the repeating schedule survives it', async () => {
    const logger = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(logger)
      .withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create('scheduler-error-fixed-rate', systemOptions);
    try {
      const probe = new RecordingRef('probe');
      system.eventStream.subscribe(probe, SchedulerError);

      let ticks = 0;
      const cancellable = system.scheduler.scheduleAtFixedRateFunction(0, 5, () => {
        ticks++;
        if (ticks === 2) throw new Error('transient');
      });
      await awaitCondition(() => ticks >= 3 && probe.received.length >= 1, {
        timeoutMs: 4_000,
        label: 'the schedule kept firing past a tick that was reported',
      });
      cancellable.cancel();

      // Liveness was the old test's only claim; it is still true, and now the
      // failure is also observable rather than merely survivable.
      expect(ticks).toBeGreaterThanOrEqual(3);
      expect((probe.received[0] as SchedulerError).cause.message).toBe('transient');
      expect(logger.errors.some((e) => e.message.includes('Unhandled scheduler error'))).toBe(true);
      expect(consoleErrors).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a non-Error throw is normalised before it is published', async () => {
    const system = ActorSystem.create('scheduler-non-error-throws', quietSystemOptions());
    try {
      const probe = new RecordingRef('probe');
      system.eventStream.subscribe(probe, SchedulerError);

      system.scheduler.scheduleOnceFunction(1, () => { throw 'a bare string'; });
      await awaitCondition(() => probe.received.length === 1, {
        timeoutMs: 4_000,
        label: 'the non-Error throw was published',
      });

      const event = probe.received[0] as SchedulerError;
      expect(event.cause).toBeInstanceOf(Error);
      expect(event.cause.message).toBe('a bare string');
    } finally {
      await system.terminate();
    }
  });
});

describe('the console is the last resort, not a second channel (#678)', () => {
  test('a scheduler with no system at all still reports, on the console', async () => {
    const scheduler = new Scheduler();
    try {
      expect(scheduler.onError).toBeUndefined();
      scheduler.scheduleOnceFunction(1, () => { throw new Error('nobody wired a sink'); });
      await awaitCondition(() => consoleErrors.length === 1, {
        timeoutMs: 4_000,
        label: 'the sink-less scheduler fell back to the console',
      });
      expect(consoleErrors[0]![0]).toBe('[actor-ts] unhandled scheduler error:');
      expect((consoleErrors[0]![1] as Error).message).toBe('nobody wired a sink');
    } finally {
      scheduler.shutdown();
    }
  });

  test('a sink that throws does not destroy the original error', async () => {
    const scheduler = new Scheduler();
    try {
      scheduler.onError = () => { throw new Error('the sink is broken too'); };
      scheduler.scheduleOnceFunction(1, () => { throw new Error('the original'); });
      await awaitCondition(() => consoleErrors.length === 2, {
        timeoutMs: 4_000,
        label: 'both the original failure and the sink failure were printed',
      });
      // The original first: it is the one nobody else is holding.
      expect(consoleErrors[0]![0]).toBe('[actor-ts] unhandled scheduler error:');
      expect((consoleErrors[0]![1] as Error).message).toBe('the original');
      expect(consoleErrors[1]![0]).toBe('[actor-ts] the scheduler error sink failed too:');
      expect((consoleErrors[1]![1] as Error).message).toBe('the sink is broken too');
    } finally {
      scheduler.shutdown();
    }
  });
});

describe('the sink ActorSystem installs on its scheduler (#678)', () => {
  test('a sink the caller already wired is not taken over', async () => {
    const scheduler = new Scheduler();
    const mine: unknown[] = [];
    scheduler.onError = (error) => { mine.push(error); };

    const systemOptions = ActorSystemOptions.create()
      .withScheduler(scheduler)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('scheduler-sink-not-taken-over', systemOptions);
    try {
      const probe = new RecordingRef('probe');
      system.eventStream.subscribe(probe, SchedulerError);

      scheduler.scheduleOnceFunction(1, () => { throw new Error('mine to report'); });
      await awaitCondition(() => mine.length === 1, {
        timeoutMs: 4_000,
        label: "the caller's own sink saw the failure",
      });
      expect((mine[0] as Error).message).toBe('mine to report');
      // `??=` and not `=`: the system must not have claimed a slot the owner
      // filled, so nothing reached the system's channels.
      expect(probe.received).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('termination takes the system sink back off a scheduler it does not own', async () => {
    const scheduler = new ReportableScheduler();
    const systemOptions = ActorSystemOptions.create()
      .withScheduler(scheduler)
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('scheduler-sink-detached', systemOptions);
    expect(scheduler.onError).toBeDefined();

    await system.terminate();

    // The scheduler outlives the system it was lent to, so it must not keep
    // reporting into a logger that has been closed.
    expect(scheduler.onError).toBeUndefined();

    scheduler.reportDirectly(new Error('after the system went away'));
    expect(consoleErrors.length).toBe(1);
    expect(consoleErrors[0]![0]).toBe('[actor-ts] unhandled scheduler error:');
  });
});

describe('ManualScheduler reports through the slot it inherits (#678)', () => {
  test('a throwing task reaches the system that borrowed the scheduler', async () => {
    const logger = new RecordingLogger();
    const scheduler = new ManualScheduler();
    const systemOptions = ActorSystemOptions.create()
      .withScheduler(scheduler)
      .withLogger(logger)
      .withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create('manual-scheduler-errors', systemOptions);
    try {
      const probe = new RecordingRef('probe');
      system.eventStream.subscribe(probe, SchedulerError);

      // Every scheduling method on ManualScheduler is an override, so the base
      // class's guard never runs on this path: fixing only `Scheduler` would
      // leave this assertion failing while every other test in this file
      // passed.  Virtual time, so nothing here waits on a clock.
      let subsequent = 0;
      scheduler.scheduleOnceFunction(5, () => { throw new Error('oops'); });
      scheduler.scheduleOnceFunction(10, () => { subsequent++; });
      scheduler.advance(50);

      expect(subsequent).toBe(1);
      expect(probe.received.length).toBe(1);
      expect((probe.received[0] as SchedulerError).cause.message).toBe('oops');
      expect(logger.errors.some((e) => e.message.includes('Unhandled scheduler error'))).toBe(true);
      expect(consoleErrors).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('with no system it falls back to the console, like its base class', () => {
    const scheduler = new ManualScheduler();
    scheduler.scheduleOnceFunction(5, () => { throw new Error('unsupervised'); });
    scheduler.advance(10);

    expect(consoleErrors.length).toBe(1);
    expect(consoleErrors[0]![0]).toBe('[actor-ts] unhandled scheduler error:');
    expect((consoleErrors[0]![1] as Error).message).toBe('unsupervised');
  });
});
