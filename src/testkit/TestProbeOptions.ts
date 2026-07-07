import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { TestProbeSettings } from './TestProbe.js';

/** Fluent builder for {@link TestProbeSettings}. */
export class TestProbeOptions extends OptionsBuilder<TestProbeSettings> {
  /** Start a fresh builder.  Equivalent to `new TestProbeOptions()`. */
  static create(): TestProbeOptions {
    return new TestProbeOptions();
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
