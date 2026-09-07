import { describe, expect, test } from 'bun:test';
import type { Clock } from '../../src/Clock.js';
import { SystemClock, systemClock } from '../../src/Clock.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Scheduler } from '../../src/Scheduler.js';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';

/**
 * The seam #1424 exists to open: a component that needs the time can take one
 * object from the system and be deterministic under a `ManualScheduler`.
 *
 * Before this, `Scheduler` had no `now()` and `ManualScheduler.now()` reached
 * nothing — virtual time drove the ticks and the code they drove read the wall
 * clock, so a hundred advanced ticks all arrived at the same real instant. The
 * last case here is that failure written as an assertion.
 */
describe('Clock', () => {
  test('the wall clock reads what Date.now() reads', () => {
    const before = Date.now();
    const reading = new SystemClock().now();
    const after = Date.now();
    expect(reading).toBeGreaterThanOrEqual(before);
    expect(reading).toBeLessThanOrEqual(after);
  });

  test('the shared instance is a SystemClock, so a `?? systemClock` default allocates nothing', () => {
    expect(systemClock).toBeInstanceOf(SystemClock);
    expect(systemClock).toBe(systemClock);
  });

  test('a Scheduler is a Clock, which is what makes system.clock the scheduler', () => {
    // Structural, deliberately: the contract is one method, and a component
    // taking `Clock` must accept the scheduler without a wrapper.
    const clock: Clock = new Scheduler();
    expect(typeof clock.now()).toBe('number');
  });

  test('a ManualScheduler is a Clock whose time only moves when advanced', () => {
    const scheduler = new ManualScheduler();
    const clock: Clock = scheduler;
    const start = clock.now();
    scheduler.advance(60_000);
    expect(clock.now() - start).toBe(60_000);
  });
});

describe('ActorSystem.clock', () => {
  /** A system with logging off, since none of these assert on a log. */
  const systemWith = (name: string, scheduler?: ManualScheduler): ActorSystem => {
    const options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    if (scheduler !== undefined) options.withScheduler(scheduler);
    return ActorSystem.create(name, options);
  };

  test('is the system scheduler, not a second object with its own idea of the time', () => {
    const system = systemWith('clock-identity');
    try {
      expect(system.clock).toBe(system.scheduler);
    } finally {
      void system.terminate();
    }
  });

  test('reads the wall clock by default', () => {
    const system = systemWith('clock-wall');
    try {
      const before = Date.now();
      const reading = system.clock.now();
      expect(reading).toBeGreaterThanOrEqual(before);
      expect(reading).toBeLessThanOrEqual(Date.now());
    } finally {
      void system.terminate();
    }
  });

  test('a minute of virtual time passes in no real time at all', () => {
    // The whole point, and the thing that was impossible before: a test says
    // "a minute went by" and the wall clock does not move.
    const scheduler = new ManualScheduler();
    const system = systemWith('clock-virtual', scheduler);
    try {
      const virtualStart = system.clock.now();
      const realStart = Date.now();
      scheduler.advance(60_000);
      expect(system.clock.now() - virtualStart).toBe(60_000);
      // A minute of wall clock has emphatically not gone by. The bound is loose
      // because it is a sanity check on the claim, not a timing assertion.
      expect(Date.now() - realStart).toBeLessThan(5_000);
    } finally {
      void system.terminate();
    }
  });

  test('a hundred advanced ticks land on a hundred distinct instants', () => {
    // The mixed-clock defect, as an assertion. Ticks run through the scheduler,
    // so virtual time drives them; before `system.clock` existed the code they
    // drove read `Date.now()`, and a hundred of these arrived so close together
    // that a failure detector handed them saw no elapsed time between samples
    // and could conclude nothing.
    const scheduler = new ManualScheduler();
    const system = systemWith('clock-ticks', scheduler);
    try {
      const observed: number[] = [];
      scheduler.scheduleAtFixedRateFunction(1_000, 1_000, () => { observed.push(system.clock.now()); });
      scheduler.advance(100_000);
      expect(observed.length).toBe(100);
      expect(new Set(observed).size).toBe(100);
      expect(observed.at(-1)! - observed[0]!).toBe(99_000);
    } finally {
      void system.terminate();
    }
  });
});
