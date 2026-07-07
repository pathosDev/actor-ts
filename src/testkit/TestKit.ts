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
 *   const ref = tk.system.spawn(Props.create(() => new Worker(probe)), 'worker');
 *   ref.tell('go');
 *   await probe.expectMsg('done');
 *   await tk.shutdown();
 */
export class TestKit {
  readonly system: ActorSystem;

  private constructor(system: ActorSystem) {
    this.system = system;
  }

  static create(
    name: string = 'test-kit',
    options: TestKitOptions = {},
  ): TestKit {
    const s = (options as Partial<TestKitOptionsType>);
    const quiet = s.quiet ?? true;
    // Quiet default: install a NoopLogger + LogLevel.Off unless the caller
    // already set a logger / level.  The extra `quiet` field is ignored by
    // the system constructor.
    const system = ActorSystem.create(name, {
      ...s,
      logger: s.logger ?? (quiet ? new NoopLogger() : undefined),
      logLevel: s.logLevel ?? (quiet ? LogLevel.Off : undefined),
    });
    return new TestKit(system);
  }

  /** Create a TestProbe scoped to this kit's system. */
  createTestProbe(options: TestProbeOptions = {}): TestProbe {
    return new TestProbe(this.system, options);
  }

  /** Run `fn` with a soft deadline; throws if it takes longer than `durationMs`. */
  async within<T>(durationMs: number, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const value = await fn();
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
    return { kit, scheduler };
  }
}
