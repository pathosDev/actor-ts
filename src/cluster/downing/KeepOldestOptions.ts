import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/** Plain options-object shape accepted by {@link KeepOldest}. */
export type KeepOldestOptionsType = {
  /** If set, only members with this role are eligible "oldest". */
  readonly role?: string;
  /**
   * Whether the oldest member loses when it is alone: the only member on its
   * side of the split, against two or more on the other.  On by default
   * ({@link DEFAULT_KEEP_OLDEST_DOWN_IF_ALONE}).
   */
  readonly downIfAlone?: boolean;
};

/**
 * Built-in default for {@link KeepOldestOptionsType.downIfAlone} — on (#932).
 *
 * The rule without it is "the side holding the oldest survives", and a crashed
 * oldest is on nobody's side: every survivor finds it unreachable and downs
 * itself, so the crash of one node — the lowest-addressed, which is also the
 * leader — takes the whole cluster down.  With it, an oldest that stands alone
 * against a group loses, whether it crashed or was cut off on its own, and the
 * group carries on.  Two sides of one member each are not "alone against a
 * group", so a two-node cluster still keeps the oldest.
 *
 * Off restores the strict rule, for a deployment that would rather stop than
 * run without the node it pinned as oldest.
 */
export const DEFAULT_KEEP_OLDEST_DOWN_IF_ALONE = true;

/**
 * Fluent builder for {@link KeepOldestOptionsType}:
 *
 *     new KeepOldest(KeepOldestOptions.create().withRole('backend'));
 */
export class KeepOldestOptionsBuilder extends OptionsBuilder<KeepOldestOptionsType> {
  /** Start a fresh builder. */
  static create(): KeepOldestOptionsBuilder {
    return new KeepOldestOptionsBuilder();
  }

  /** Only members with this role are eligible to be the "oldest". */
  withRole(role: string): this {
    return this.set('role', role);
  }

  /** Whether an oldest member alone on its side of a split loses.  Default true. */
  withDownIfAlone(downIfAlone = true): this {
    return this.set('downIfAlone', downIfAlone);
  }
}

/**
 * Accepted input for the {@link KeepOldest} constructor: the fluent
 * {@link KeepOldestOptionsBuilder} OR a plain {@link KeepOldestOptionsType}
 * object.
 */
export type KeepOldestOptions = KeepOldestOptionsBuilder | Partial<KeepOldestOptionsType>;
/** Value alias so `KeepOldestOptions.create()` / `new KeepOldestOptions()` resolve to the builder. */
export const KeepOldestOptions = KeepOldestOptionsBuilder;
