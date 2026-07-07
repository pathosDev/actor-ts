import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/** Plain settings-object shape accepted by {@link StaticQuorum}. */
export interface StaticQuorumOptionsType {
  /** Exact size of the quorum needed on the reachable side. */
  readonly quorumSize: number;
  /** If set, only members carrying this role count toward quorum. */
  readonly role?: string;
}

/**
 * Fluent builder for {@link StaticQuorumOptionsType}:
 *
 *     new StaticQuorum(StaticQuorumOptions.create().withQuorumSize(3));
 */
export class StaticQuorumOptionsBuilder extends OptionsBuilder<StaticQuorumOptionsType> {
  /** Start a fresh builder. */
  static create(): StaticQuorumOptionsBuilder {
    return new StaticQuorumOptionsBuilder();
  }

  /** Exact size of the quorum needed on the reachable side. */
  withQuorumSize(quorumSize: number): this {
    return this.set('quorumSize', quorumSize);
  }

  /** Only members carrying this role count toward quorum. */
  withRole(role: string): this {
    return this.set('role', role);
  }
}

/**
 * Accepted input for the {@link StaticQuorum} constructor: the fluent
 * {@link StaticQuorumOptionsBuilder} OR a plain {@link StaticQuorumOptionsType}
 * object.
 */
export type StaticQuorumOptions = StaticQuorumOptionsBuilder | Partial<StaticQuorumOptionsType>;
/** Value alias so `StaticQuorumOptions.create()` / `new StaticQuorumOptions()` resolve to the builder. */
export const StaticQuorumOptions = StaticQuorumOptionsBuilder;
