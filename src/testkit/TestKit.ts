import { ActorSystem } from '../ActorSystem.js';
import { LogLevel, NoopLogger } from '../Logger.js';
import { ManualScheduler } from './ManualScheduler.js';
import { TestProbe } from './TestProbe.js';
import type { TestKitOptions, TestKitOptionsType } from './TestKitOptions.js';
import type { TestProbeOptions } from './TestProbeOptions.js';

/**
 * Convenience fassade to create an ActorSystem pre-wired for deterministic
 * testing: NoopLogger by default and a TestProbe factory handy.
 *
 * Typical usage:
 *
 *   const tk = TestKit.create('my-spec');
 *   const probe = tk.createTestProbe();
 *   const ref = tk.system.spawn(() => new Worker(probe), 'worker');
 *   ref.tell('go');
 *   await probe.expectMessage('done');
 *   await tk.shutdown();
 */
export class TestKit {
  readonly system: ActorSystem;

  /**
   * The virtual clock this kit drives, when it has one.
   *
   * Held so {@link advance} can be a method rather than something a test has to
   * assemble from the two halves `withManualScheduler` hands back — which is
   * the shape the documentation's samples were written in, and the shape that
   * left the settle out.
   */
  private readonly manualScheduler: ManualScheduler | null;

  private constructor(system: ActorSystem, manualScheduler: ManualScheduler | null = null) {
    this.system = system;
    this.manualScheduler = manualScheduler;
  }

  static create(
    name: string = 'test-kit',
    options: TestKitOptions = {},
  ): TestKit {
    const resolvedOptions = (options as Partial<TestKitOptionsType>);
    const quiet = resolvedOptions.quiet ?? true;
    // Quiet default: install a NoopLogger + LogLevel.Off unless the caller
    // already set a logger / level.  The extra `quiet` field is ignored by
    // the system constructor.
    const system = ActorSystem.create(name, {
      ...resolvedOptions,
      logger: resolvedOptions.logger ?? (quiet ? new NoopLogger() : undefined),
      logLevel: resolvedOptions.logLevel ?? (quiet ? LogLevel.Off : undefined),
    });
    return new TestKit(
      system,
      resolvedOptions.scheduler instanceof ManualScheduler ? resolvedOptions.scheduler : null,
    );
  }

  /**
   * Let every actor turn that is already armed run, and every turn those arm.
   *
   * The missing half of deterministic testing.  Virtual time makes *when* a
   * timer fires deterministic and says nothing about when its effects have
   * landed: `advance` fires the timer synchronously, but the `tell` it performs
   * is delivered by the dispatcher on a later turn.  So
   *
   *     scheduler.advance(100);
   *     expect(probe.received).toHaveLength(1);   // ✗ reads an empty probe
   *
   * was wrong as written, in this repository's own flagship samples (#1025).
   * With a settle it is right, and it is right *without a sleep* — nothing is
   * being waited for, the work is already armed and only needs the event loop
   * to reach it.
   *
   * Prefer {@link advance}, which does both in the right order.  Reach for this
   * one directly after a plain `tell` with no timer involved.
   *
   * @throws if the system does not become quiet within the turn budget, which
   *   means an exchange is not going to terminate rather than that it needed
   *   one more turn.
   */
  async settle(): Promise<void> {
    const quiet = await this.system._settle();
    if (!quiet) {
      throw new Error(
        'TestKit.settle: the /user tree was still busy after the turn budget. '
        + 'That is an exchange with no end rather than one that needed longer — '
        + 'two actors volleying, or a handler that re-sends to itself every turn.',
      );
    }
  }

  /**
   * Advance virtual time by `ms`, then let the effects land.
   *
   * The one call a timer-driven assertion should be written around:
   *
   *     await kit.advance(100);
   *     expect(probe.received).toEqual(['tick']);
   *
   * @throws if this kit was not built with a `ManualScheduler`, since there is
   *   no virtual time to advance and silently doing nothing would make the
   *   assertion that follows a coin flip.
   */
  async advance(ms: number): Promise<void> {
    if (this.manualScheduler === null) {
      throw new Error(
        'TestKit.advance: this kit has no ManualScheduler, so there is no virtual '
        + 'time to advance. Build it with TestKit.withManualScheduler(...), or pass '
        + 'a ManualScheduler as the `scheduler` option.',
      );
    }
    this.manualScheduler.advance(ms);
    await this.settle();
  }

  /** Create a TestProbe scoped to this kit's system. */
  createTestProbe(options: TestProbeOptions = {}): TestProbe {
    return new TestProbe(this.system, options);
  }

  /** Run `callback` with a soft deadline; throws if it takes longer than `durationMs`. */
  async within<T>(durationMs: number, callback: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const value = await callback();
    const elapsed = Date.now() - started;
    if (elapsed > durationMs) {
      throw new Error(`within(${durationMs}ms) exceeded — actual ${elapsed}ms`);
    }
    return value;
  }

  /** Tear the system down at the end of a test. */
  async shutdown(): Promise<void> {
    await this.system.terminate();
  }

  /**
   * Build a TestKit that uses a `ManualScheduler` so that timers fire
   * deterministically via `scheduler.advance(ms)`.
   */
  static withManualScheduler(
    name: string = 'test-kit-manual',
    options: TestKitOptions = {},
  ): { kit: TestKit; scheduler: ManualScheduler } {
    const scheduler = new ManualScheduler();
    const kit = TestKit.create(name, { ...(options as Partial<TestKitOptionsType>), scheduler });
    // Both halves are still returned, because a test that wants to advance
    // without settling — to assert that nothing has happened *yet* — needs the
    // scheduler directly. `kit.advance` is the right call for everything else.
    return { kit, scheduler };
  }
}
