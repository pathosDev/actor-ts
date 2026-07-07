import { ActorSystemOptionsBuilder } from '../ActorSystemOptions.js';
import type { ActorSystemOptionsType } from '../ActorSystemOptions.js';

/** Plain settings-object shape accepted by {@link TestKit.create}. */
export interface TestKitOptionsType extends ActorSystemOptionsType {
  /** When true, install a NoopLogger if the caller didn't provide one. */
  readonly quiet?: boolean;
}

/**
 * Fluent builder for {@link TestKitOptionsType}, passed to {@link TestKit.create}.
 * Inherits every {@link ActorSystemOptionsBuilder} setter (`withLogger`,
 * `withScheduler`, `withConfig`, …) and adds the TestKit-only `withQuiet`.
 */
export class TestKitOptionsBuilder extends ActorSystemOptionsBuilder<TestKitOptionsType> {
  /** Start a fresh builder.  Equivalent to `new TestKitOptionsBuilder()`. */
  static create(): TestKitOptionsBuilder {
    return new TestKitOptionsBuilder();
  }

  /** Install a NoopLogger + LogLevel.Off unless a logger/level is set.  Default `true`. */
  withQuiet(quiet = true): this {
    return this.set('quiet', quiet);
  }
}

/**
 * Accepted input for {@link TestKit.create}: the fluent
 * {@link TestKitOptionsBuilder} OR a plain {@link TestKitOptionsType} object.
 */
export type TestKitOptions = TestKitOptionsBuilder | Partial<TestKitOptionsType>;
/** Value alias so `TestKitOptions.create()` / `new TestKitOptions()` resolve to the builder. */
export const TestKitOptions = TestKitOptionsBuilder;
