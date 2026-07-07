import { ActorSystemOptions } from '../ActorSystemOptions.js';
import type { TestKitSettings } from './TestKit.js';

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
