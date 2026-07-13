import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Plain settings-object shape accepted by a {@link TestProbe}. */
export interface TestProbeOptionsType {
  /** Default timeout used when a caller doesn't specify one. */
  readonly defaultTimeoutMs?: number;
  /** Visible name of the probe (default: auto-generated). */
  readonly name?: string;
}

/** Fluent builder for {@link TestProbeOptionsType}. */
export class TestProbeOptionsBuilder extends OptionsBuilder<TestProbeOptionsType> {
  /** Start a fresh builder.  Equivalent to `new TestProbeOptionsBuilder()`. */
  static create(): TestProbeOptionsBuilder {
    return new TestProbeOptionsBuilder();
  }

  /** Default timeout (ms) used when an expect/receive call omits one.  Default 3000. */
  withDefaultTimeoutMs(defaultTimeoutMs: number): this {
    return this.set('defaultTimeoutMs', defaultTimeoutMs);
  }

  /** Visible name of the probe (default: auto-generated). */
  withName(name: string): this {
    return this.set('name', name);
  }
}

/** Validates resolved {@link TestProbeOptionsType} settings. */
export class TestProbeOptionsValidator extends OptionsValidator<TestProbeOptionsType> {
  constructor() {
    super('TestProbeOptions');
  }
  protected rules(_s: Partial<TestProbeOptionsType>): void {
    this.positiveNumber('defaultTimeoutMs');
  }
}

/**
 * Accepted input for a {@link TestProbe}: the fluent
 * {@link TestProbeOptionsBuilder} OR a plain {@link TestProbeOptionsType}
 * object.
 */
export type TestProbeOptions = TestProbeOptionsBuilder | Partial<TestProbeOptionsType>;
/** Value alias so `TestProbeOptions.create()` / `new TestProbeOptions()` resolve to the builder. */
export const TestProbeOptions = TestProbeOptionsBuilder;
