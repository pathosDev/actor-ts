import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import { stripUndefined } from '../../util/OptionsMerge.js';

/**
 * Built-in default for {@link SplitBrainResolverOptionsType.stableAfterMs} —
 * how long the membership *and* reachability view must hold still before the
 * configured {@link DowningProvider} is consulted at all (#839).
 *
 * 20 s is chosen against what a decision costs when it is wrong rather than
 * against how fast one could be made.  Every bundled strategy is a pure
 * function of one view, so a view captured mid-churn — half the peers already
 * marked `unreachable`, the other half about to be — is a decision made on
 * evidence that was never true at any instant.  Twenty seconds is several
 * failure-detector rounds on the shipped cadence (`unreachable-after = 2s`,
 * `down-after = 5s`), which is long enough for a transient blip to have healed
 * and short enough that a genuine partition is arbitrated inside the window an
 * operator would call an outage.
 *
 * It is only expressible at all since #929.  Before it, the failure detector
 * deleted an unreachable peer at `down-after` whether or not a resolver was
 * configured, so `view.unreachable` was empty again `down-after` minus
 * `unreachable-after` — 3 s on the reference defaults — after the partition
 * appeared, and any window longer than that could never elapse with a
 * partition in view.  The detector now parks the peer at `unreachable` and
 * evicts nothing, so the window has no upper bound imposed by the detector and
 * this file states none.
 *
 * Lives here rather than in `src/cluster/Constants.ts` because it is the
 * built-in default of a field declared in this file, which is the first rule
 * the constants policy names.
 */
export const DEFAULT_STABLE_AFTER_MS = 20_000;

/**
 * Built-in default for
 * {@link SplitBrainResolverOptionsType.downAllWhenUnstable} — **off**.
 *
 * Escalation is the one action in this subsystem that stops the whole cluster,
 * self included, and it is reached by a *timer* rather than by a strategy's
 * verdict.  On by default would mean any churn outlasting the escalation
 * deadline converts a recoverable outage into a total one without anyone
 * having asked for it — a rolling restart whose replacements arrive less than
 * `stable-after` apart is exactly that shape.  So the shipped value is the one
 * every release before this key behaved as, and turning it on is a deployment
 * saying out loud that it would rather be down than be uncertain.
 */
export const DEFAULT_DOWN_ALL_WHEN_UNSTABLE = false;

/**
 * How many whole {@link DEFAULT_STABLE_AFTER_MS} windows of uninterrupted
 * churn {@link SplitBrainResolverOptionsType.downAllWhenUnstable} tolerates
 * before it escalates — see {@link unstableEscalationDeadlineMs}.
 *
 * A multiple rather than a fourth HOCON key, deliberately.  The margin is not
 * an independent quantity: it only ever means "several times however long this
 * deployment thinks a view needs to settle", so a separate key would be one
 * more number to keep consistent with `stable-after` and one more thing to get
 * wrong — a margin *below* the window would escalate before a single quiet
 * window could ever be observed, which no operator wants and no validator
 * could infer they did not.
 *
 * Three, because one window is the ordinary cost of a single partition event
 * settling and two leaves no room for a second event landing on the first.
 * Three consecutive windows in which the view never once held still is a
 * cluster that is not converging at all, which is the only state this switch
 * exists for.
 */
export const DEFAULT_UNSTABLE_ESCALATION_FACTOR = 3;

/**
 * How long a run of uninterrupted view changes may last before
 * `down-all-when-unstable` escalates, derived from the configured window.
 *
 * A function rather than a constant so the derivation has exactly one home:
 * `Cluster` reads it, the tests read it, and the docs quote it, and a second
 * copy of `stableAfterMs * 3` somewhere else is how the published rule and the
 * shipped one drift apart.
 */
export function unstableEscalationDeadlineMs(stableAfterMs: number): number {
  return stableAfterMs * DEFAULT_UNSTABLE_ESCALATION_FACTOR;
}

/**
 * How many whole windows a peer must have been **continuously** unreachable
 * before the resolver is consulted even though the view is still moving — the
 * bound on how long churn elsewhere may starve arbitration here.
 *
 * The window's premise is that a view read mid-transition is evidence of
 * nothing.  Its first implementation drew that from the *whole* view, which
 * makes any join, leave or status change anywhere in the cluster restart it:
 * a deployment whose membership moves more often than `stable-after` — an
 * autoscaling group, a rolling deploy, one flapping node — then never
 * arbitrates a partition at all, and since #929 nothing else does either,
 * because the detector parks an unreachable peer instead of evicting it
 * whenever a provider is configured.  A window with no ceiling is not a
 * conservative version of arbitration; it is the absence of arbitration.
 *
 * Two, and the two neighbouring numbers are why.  It is strictly *above* one
 * window, so a view that does settle is always arbitrated through the ordinary
 * path first and this bound never becomes the normal case.  It is strictly
 * *below* {@link DEFAULT_UNSTABLE_ESCALATION_FACTOR}, so a strategy is asked
 * before `down-all-when-unstable` stops the cluster — the escalation exists
 * for a view no strategy could decide on, and a peer that has held one status
 * for two whole windows is not that.
 *
 * Measured against a *single* peer's uninterrupted unreachability rather than
 * against the whole view, because that is the fact the resolver is being asked
 * about.  Nothing here weakens the pre-#839 disposition: before the window,
 * the provider was consulted on **every** tick that saw a partition.
 */
export const DEFAULT_UNREACHABLE_ARBITRATION_FACTOR = 2;

/**
 * How long one peer must have been continuously unreachable before the
 * resolver is consulted despite a view that keeps moving, derived from the
 * configured window.
 *
 * A function beside {@link unstableEscalationDeadlineMs} for the same reason
 * that one is: the derivation has exactly one home, so the published rule and
 * the shipped one cannot drift apart.
 */
export function unreachableArbitrationDeadlineMs(stableAfterMs: number): number {
  return stableAfterMs * DEFAULT_UNREACHABLE_ARBITRATION_FACTOR;
}

/**
 * Split-brain **policy** — how the cluster decides *when* to ask a
 * {@link DowningProvider}, as against which one it asks (#839).
 *
 * Which strategy runs is `split-brain-resolver.active-strategy`, read by
 * `readDowningFromConfig` into `ClusterOptionsType.downing`; the two settings
 * here sit in the same HOCON block because an operator tunes them together,
 * but they configure `Cluster.evaluateDowning` rather than any strategy.  No
 * bundled provider sees either value, and a custom one does not have to know
 * they exist.
 */
export type SplitBrainResolverOptionsType = {
  /**
   * How long the membership and reachability view must be unchanged before
   * the resolver is consulted.  Default: {@link DEFAULT_STABLE_AFTER_MS}.
   *
   * The clock is the failure-detection tick, so the effective resolution is
   * `failure-detector.heartbeat-interval` (500 ms shipped) — irrelevant at
   * twenty seconds, worth knowing at two.
   *
   * It is a preference, not a precondition: a peer that has been continuously
   * unreachable for {@link unreachableArbitrationDeadlineMs} is arbitrated
   * even if the rest of the view is still moving.  Without that ceiling a
   * cluster whose membership changes more often than this value would never
   * arbitrate a partition at all.
   */
  readonly stableAfterMs?: number;
  /**
   * Down **every** member, self included, when the view has failed to hold
   * still for one whole {@link stableAfterMs} across a run of changes longer
   * than {@link unstableEscalationDeadlineMs}.  Default:
   * {@link DEFAULT_DOWN_ALL_WHEN_UNSTABLE} (off).
   *
   * Only ever reached while something is unreachable: a cluster whose view
   * moves because members are joining and leaving cleanly is churning, not
   * partitioned, and stopping it would answer a question nobody asked.
   */
  readonly downAllWhenUnstable?: boolean;
};

/**
 * Fluent builder for {@link SplitBrainResolverOptionsType} — the value
 * `ClusterOptions.withSplitBrainResolver(…)` takes.
 *
 *     const resolverPolicy = SplitBrainResolverOptions.create()
 *       .withStableAfterMs(30_000)
 *       .withDownAllWhenUnstable(true);
 */
export class SplitBrainResolverOptionsBuilder extends OptionsBuilder<SplitBrainResolverOptionsType> {
  /** Start a fresh builder.  Equivalent to `new SplitBrainResolverOptionsBuilder()`. */
  static create(): SplitBrainResolverOptionsBuilder {
    return new SplitBrainResolverOptionsBuilder();
  }

  /** How long the view must hold still before the resolver is consulted. */
  withStableAfterMs(ms: number): this {
    return this.set('stableAfterMs', ms);
  }

  /** Escalate to downing the whole cluster when the view will not settle. */
  withDownAllWhenUnstable(downAllWhenUnstable: boolean): this {
    return this.set('downAllWhenUnstable', downAllWhenUnstable);
  }
}

/**
 * Validates resolved {@link SplitBrainResolverOptionsType} settings.
 *
 * One rule, and the absence of a second one is the interesting half.  There is
 * deliberately **no** upper bound tying `stableAfterMs` to
 * `failure-detector.down-after`: since #929 the detector parks an unreachable
 * peer and evicts nothing whenever a provider is configured, so the window has
 * no deadline to out-run.  A bound written here would have to be re-derived
 * from a block this file cannot see, and it would be wrong.
 *
 * `0` is refused rather than read as "no window".  That meaning already has a
 * spelling — `active-strategy = off`, which stops the resolver being consulted
 * at all — and a second one would let a deployment turn the arbitration it
 * asked for into a decision made on the first mid-partition tick, which is the
 * behaviour this whole key exists to remove.
 */
export class SplitBrainResolverOptionsValidator
  extends OptionsValidator<SplitBrainResolverOptionsType> {
  constructor() {
    super('SplitBrainResolverOptions');
  }

  protected rules(): void {
    this.positiveNumber('stableAfterMs');
  }
}

/**
 * Read the policy half of `actor-ts.cluster.split-brain-resolver` — the two
 * leaves that configure `Cluster.evaluateDowning` rather than a strategy.
 *
 * Only the keys actually present are returned, and the caller folds the result
 * in only when it is non-empty, so an absent leaf falls through to the
 * built-in default instead of landing as an explicit `undefined`.  That is the
 * same omit-when-empty rule `readFailureDetectorFromConfig` follows one block
 * over, and it is what lets `withClusterConfigDefaults` give the field
 * per-field precedence.
 *
 * Separate from {@link readDowningFromConfig}, which reads the *selector* out
 * of the same block: that one answers "which provider" and returns a
 * constructed object, this one answers "when to ask it" and returns values.
 * One reader for both would have to return two unrelated shapes.
 */
export function readSplitBrainResolverOptionsFromConfig(
  config: Config,
): Partial<SplitBrainResolverOptionsType> {
  const keys = ConfigKeys.cluster.splitBrainResolver;
  const out: {
    -readonly [K in keyof SplitBrainResolverOptionsType]?: SplitBrainResolverOptionsType[K]
  } = {};
  if (config.hasPath(keys.stableAfter)) out.stableAfterMs = config.getDuration(keys.stableAfter);
  // `getBoolean`, not `getString`: this leaf really is a boolean, and HOCON
  // spells one `true`, `on` or `yes`.  The sibling `active-strategy` reads its
  // `off` as a *string* for the opposite reason — there the word is one member
  // of a five-name vocabulary, not a negation.
  if (config.hasPath(keys.downAllWhenUnstable)) {
    out.downAllWhenUnstable = config.getBoolean(keys.downAllWhenUnstable);
  }
  return stripUndefined(out);
}

/**
 * Accepted input wherever the resolver policy is configured: the fluent
 * {@link SplitBrainResolverOptionsBuilder} OR a plain
 * {@link SplitBrainResolverOptionsType} object.
 */
export type SplitBrainResolverOptions =
  SplitBrainResolverOptionsBuilder | Partial<SplitBrainResolverOptionsType>;
/** Value alias so `SplitBrainResolverOptions.create()` resolves to the builder. */
export const SplitBrainResolverOptions = SplitBrainResolverOptionsBuilder;
