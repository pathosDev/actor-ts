import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { Member } from '../cluster/Member.js';
import type { NodeAddress } from '../cluster/NodeAddress.js';
import type { Option } from '../util/Option.js';

/** Plain options-object shape accepted by a {@link MockCluster}. */
export interface MockClusterOptionsType {
  /** Self address — what `selfAddress` returns. */
  readonly selfAddress: NodeAddress;
  /** Initial members.  Self is added automatically if not present. */
  readonly initialMembers?: ReadonlyArray<Member>;
  /** Initial leader.  Defaults to the lowest address. */
  readonly initialLeader?: Option<Member>;
}

/** Fluent builder for {@link MockClusterOptionsType}. */
export class MockClusterOptionsBuilder extends OptionsBuilder<MockClusterOptionsType> {
  /** Start a fresh builder. */
  static create(): MockClusterOptionsBuilder {
    return new MockClusterOptionsBuilder();
  }

  /** Self address — what `selfAddress` returns.  Required. */
  withSelfAddress(selfAddress: NodeAddress): this {
    return this.set('selfAddress', selfAddress);
  }

  /** Initial members (self added automatically if absent). */
  withInitialMembers(initialMembers: ReadonlyArray<Member>): this {
    return this.set('initialMembers', initialMembers);
  }

  /** Initial leader.  Defaults to the lowest address. */
  withInitialLeader(initialLeader: Option<Member>): this {
    return this.set('initialLeader', initialLeader);
  }
}

/**
 * Accepted input for a {@link MockCluster}: the fluent
 * {@link MockClusterOptionsBuilder} OR a plain {@link MockClusterOptionsType}.
 */
export type MockClusterOptions = MockClusterOptionsBuilder | Partial<MockClusterOptionsType>;
/** Value alias so `MockClusterOptions.create()` / `new MockClusterOptions()` resolve to the builder. */
export const MockClusterOptions = MockClusterOptionsBuilder;
