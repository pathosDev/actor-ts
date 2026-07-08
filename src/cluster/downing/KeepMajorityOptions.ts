import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/** Plain options-object shape accepted by {@link KeepMajority}. */
export interface KeepMajorityOptionsType {
  /** If set, only members carrying this role count toward the majority. */
  readonly role?: string;
}

/**
 * Fluent builder for {@link KeepMajorityOptionsType}:
 *
 *     new KeepMajority(KeepMajorityOptions.create().withRole('backend'));
 */
export class KeepMajorityOptionsBuilder extends OptionsBuilder<KeepMajorityOptionsType> {
  /** Start a fresh builder. */
  static create(): KeepMajorityOptionsBuilder {
    return new KeepMajorityOptionsBuilder();
  }

  /** Only members carrying this role count toward the majority. */
  withRole(role: string): this {
    return this.set('role', role);
  }
}

/**
 * Accepted input for the {@link KeepMajority} constructor: the fluent
 * {@link KeepMajorityOptionsBuilder} OR a plain {@link KeepMajorityOptionsType}
 * object.
 */
export type KeepMajorityOptions = KeepMajorityOptionsBuilder | Partial<KeepMajorityOptionsType>;
/** Value alias so `KeepMajorityOptions.create()` / `new KeepMajorityOptions()` resolve to the builder. */
export const KeepMajorityOptions = KeepMajorityOptionsBuilder;
