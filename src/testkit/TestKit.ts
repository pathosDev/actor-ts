import { ActorSystem, ActorSystemOptions, type ActorSystemSettings } from '../ActorSystem.js';
import { LogLevel, NoopLogger } from '../Logger.js';
import { ManualScheduler } from './ManualScheduler.js';
import { TestProbe, TestProbeOptions } from './TestProbe.js';

export interface TestKitSettings extends ActorSystemSettings {
  /** When true, install a NoopLogger if the caller didn't provide one. */
  readonly quiet?: boolean;
}

/**
 * Fluent builder for {@link TestKitSettings}, passed to {@link TestKit.create}.
 * Inherits every {@link ActorSystemOptions} setter (`withLogger`,
 * `withScheduler`, `withConfig`, …) and adds the TestKit-only `withQuiet`.
 */
export class TestKitOptions extends ActorSystemOptions<TestKitSettings> {
  /** Start a fresh builder.  Equivalent to `new TestKitOptions()`. */
  static create(): TestKitOptions {
    return new TestKitOptions();
  }

  /** Install a NoopLogger + LogLevel.Off unless a logger/level is set.  Default `true`. */
  withQuiet(quiet = true): this {
    return this.set('quiet', quiet);
  }
}

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

  static create(name: string = 'test-kit', options: TestKitOptions = TestKitOptions.create()): TestKit {
    const s = options.build();
    const quiet = s.quiet ?? true;
    // Quiet default: install a NoopLogger + LogLevel.Off unless the caller
    // already set a logger / level.  Mutate the builder in place, then feed it
    // to the (builder-only) ActorSystem.create — the extra `quiet` field the
    // builder carries is ignored by the system constructor.
    if (quiet && s.logger === undefined) options.withLogger(new NoopLogger());
    if (quiet && s.logLevel === undefined) options.withLogLevel(LogLevel.Off);
    const system = ActorSystem.create(name, options as unknown as ActorSystemOptions);
    return new TestKit(system);
  }

  /** Create a TestProbe scoped to this kit's system. */
  createTestProbe(options: TestProbeOptions = TestProbeOptions.create()): TestProbe {
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
    options: TestKitOptions = TestKitOptions.create(),
  ): { kit: TestKit; scheduler: ManualScheduler } {
    const scheduler = new ManualScheduler();
    const kit = TestKit.create(name, options.withScheduler(scheduler));
    return { kit, scheduler };
  }
}
