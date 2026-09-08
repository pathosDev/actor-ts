import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';

/**
 * #1424 — a scheduler handed in through `ActorSystemOptions` belongs to
 * whoever handed it over.
 *
 * The dispatcher has always followed that rule; the scheduler did not, and was
 * shut down by whichever system terminated first.  With one system that is
 * invisible, because the scheduler had nothing left to do.  Share one across
 * two — which is what a multi-node spec on one virtual clock has to do — and
 * the first teardown disarms every handle the second one still owns.
 *
 * The `_rootTerminated` comment already reasoned this way about the error sink
 * ("a `ManualScheduler` handed in through `ActorSystemOptions` outlives the
 * system and is advanced by the test afterwards") while the line above it shut
 * that same scheduler down.
 */

const quiet = (scheduler?: ManualScheduler): ActorSystemOptions => {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (scheduler !== undefined) options.withScheduler(scheduler);
  return options;
};

describe('a borrowed scheduler outlives the system that borrowed it', () => {
  test('terminating one of two systems leaves the other one ticking', async () => {
    const scheduler = new ManualScheduler();
    const first = ActorSystem.create('owner-first', quiet(scheduler));
    const second = ActorSystem.create('owner-second', quiet(scheduler));

    let secondFired = 0;
    scheduler.scheduleOnceFunction(1_000, () => { secondFired++; });

    await first.terminate();

    // The handle belongs to a test that is still running, and the scheduler is
    // still the second system's clock.
    scheduler.advance(1_000);
    expect(secondFired).toBe(1);
    expect(second.clock.now()).toBe(1_000);

    await second.terminate();
  });

  test('a task armed after the first teardown still fires', async () => {
    const scheduler = new ManualScheduler();
    const first = ActorSystem.create('arm-after-first', quiet(scheduler));
    const second = ActorSystem.create('arm-after-second', quiet(scheduler));

    await first.terminate();

    let fired = false;
    scheduler.scheduleOnceFunction(500, () => { fired = true; });
    scheduler.advance(500);

    expect(fired).toBe(true);
    await second.terminate();
  });

  test('a system that built its own scheduler still shuts it down', async () => {
    // The other half: nothing changes for the ordinary case, and a system that
    // owns its scheduler must not leave timers armed after `terminate()` —
    // an armed interval holds the event loop open (#641).
    const system = ActorSystem.create('owns-its-own', quiet());
    const scheduler = system.scheduler;

    let fired = false;
    scheduler.scheduleOnceFunction(10, () => { fired = true; });
    await system.terminate();

    // `shutdown()` disarms rather than fires, so waiting past the delay proves
    // it was cancelled rather than merely not yet due.
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    expect(fired).toBe(false);
  });
});
