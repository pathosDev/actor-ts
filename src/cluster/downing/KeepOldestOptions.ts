import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/** Plain options-object shape accepted by {@link KeepOldest}. */
export interface KeepOldestOptionsType {
  /** If set, only members with this role are eligible "oldest". */
  readonly role?: string;
  /**
   * When true, if the oldest member is unreachable the *other* side wins
   * (this flips the rule for paranoid setups where the oldest might be
   * the one that failed).  Default: false.
   */
  readonly downIfAlone?: boolean;
}

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

  /** When true, if the oldest member is unreachable the other side wins.  Default false. */
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
