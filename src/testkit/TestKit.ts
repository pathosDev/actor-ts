import { ActorSystem, type ActorSystemSettings } from '../ActorSystem.js';
import { LogLevel, NoopLogger } from '../Logger.js';
import { ManualScheduler } from './ManualScheduler.js';
import { TestProbe, type TestProbeOptions } from './TestProbe.js';

export interface TestKitOptions extends ActorSystemSettings {
  /** When true, install a NoopLogger if the caller didn't provide one. */
  readonly quiet?: boolean;
}

/**
 * Convenience fassade to create an ActorSystem pre-wired for deterministic
 * testing: NoopLogger by default and a TestProbe factory handy.
 *
 * Typical usage:
 *
 *   const tk = TestKit.create('my-spec');
 *   const probe = tk.createTestProbe();
 *   const ref = tk.system.actorOf(Props.create(() => new Worker(probe)), 'worker');
 *   ref.tell('go');
 *   await probe.expectMsg('done');
 *   await tk.shutdown();
 */
export class TestKit {
  readonly system: ActorSystem;

  private constructor(system: ActorSystem) {
    this.system = system;
  }

  static create(name: string = 'test-kit', options: TestKitOptions = {}): TestKit {
    const quiet = options.quiet ?? true;
    const system = ActorSystem.create(name, {
      ...options,
      logger: options.logger ?? (quiet ? new NoopLogger() : undefined),
      logLevel: options.logLevel ?? (quiet ? LogLevel.Off : undefined),
    });
    return new TestKit(system);
  }

  /** Create a TestProbe scoped to this kit's system. */
  createTestProbe(opts: TestProbeOptions = {}): TestProbe {
    return new TestProbe(this.system, opts);
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
    options: Omit<TestKitOptions, 'scheduler'> = {},
  ): { kit: TestKit; scheduler: ManualScheduler } {
    const scheduler = new ManualScheduler();
    const kit = TestKit.create(name, { ...options, scheduler });
    return { kit, scheduler };
  }
}
