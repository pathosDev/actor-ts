import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/**
 * How long the unreachable set must be **unchanged** before a
 * {@link DowningProvider} is consulted.
 *
 * 20 s, matching the value established split-brain designs use for the same
 * knob, and it has to exceed the spread between the first and last detection
 * of one partition plus the gossip convergence that follows — not merely the
 * duration of a flap.  That is what the measurement behind #839 showed: with
 * no window at all, a 2/2 partition whose two remote peers cross
 * `unreachable-after` on *different* failure-detector ticks is resolved as two
 * successive majority decisions, and both halves survive.
 *
 * The cost is stated rather than hidden: a cluster with a downing provider now
 * waits this long after the view settles before anything is downed, so
 * failover latency grows by up to the window.  A deployment that wants the old
 * behaviour writes `stable-after = 0`, and gets the old defect with it.
 */
export const DEFAULT_SPLIT_BRAIN_RESOLVER_STABLE_AFTER_MS = 20_000;

/** Plain options-object shape for the split-brain resolver's timing. */
export type SplitBrainResolverOptionsType = {
  /**
   * How long the unreachable set must be unchanged before a strategy decides.
   *
   * `0` decides on the first observation, which is what this cluster did
   * before the key existed.
   */
  readonly stableAfterMs: number;
};

/** The built-in defaults, applied wherever an explicit field is unset. */
export const defaultSplitBrainResolverOptions: SplitBrainResolverOptionsType = {
  stableAfterMs: DEFAULT_SPLIT_BRAIN_RESOLVER_STABLE_AFTER_MS,
};

/**
 * Fluent builder for {@link SplitBrainResolverOptionsType}.  Unset fields fall
 * through to {@link defaultSplitBrainResolverOptions}, so a bare
 * `SplitBrainResolverOptions.create()` yields the defaults.
 *
 *     const resolverOptions = SplitBrainResolverOptions.create()
 *       .withStableAfterMs(5_000)
 */
export class SplitBrainResolverOptionsBuilder
  extends OptionsBuilder<SplitBrainResolverOptionsType> {
  /** Start a fresh builder.  Equivalent to `new SplitBrainResolverOptionsBuilder()`. */
  static create(): SplitBrainResolverOptionsBuilder {
    return new SplitBrainResolverOptionsBuilder();
  }

  /** How long the unreachable set must be unchanged before a strategy decides. */
  withStableAfterMs(ms: number): this {
    return this.set('stableAfterMs', ms);
  }
}

/**
 * Validates resolved {@link SplitBrainResolverOptionsType} settings.
 *
 * `0` is admitted deliberately — it is the documented spelling of "decide on
 * the first observation", which is the behaviour every release before this key
 * had, so a deployment must be able to ask for it explicitly rather than by
 * omission.  Negative is refused: a window measured backwards has no reading.
 */
export class SplitBrainResolverOptionsValidator
  extends OptionsValidator<SplitBrainResolverOptionsType> {
  constructor() {
    super('SplitBrainResolverOptions');
  }

  protected rules(): void {
    this.nonNegativeNumber('stableAfterMs');
  }
}

/**
 * Accepted input wherever the resolver's timing is configurable: the fluent
 * {@link SplitBrainResolverOptionsBuilder} OR a plain
 * {@link SplitBrainResolverOptionsType} object.
 */
export type SplitBrainResolverOptions =
  | SplitBrainResolverOptionsBuilder
  | Partial<SplitBrainResolverOptionsType>;
/** Value alias so `SplitBrainResolverOptions.create()` resolves to the builder. */
export const SplitBrainResolverOptions = SplitBrainResolverOptionsBuilder;
