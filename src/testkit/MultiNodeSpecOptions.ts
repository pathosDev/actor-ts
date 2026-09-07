import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { ClusterOptionsType } from '../cluster/ClusterOptions.js';
import type { DowningProvider } from '../cluster/downing/index.js';
import type { LogLevel } from '../Logger.js';

type AddressMap = Readonly<Record<string, { host: string; port: number }>>;

/** Plain options-object shape accepted by a {@link MultiNodeSpec}. */
export type MultiNodeSpecOptionsType = {
  /** Role names — also act as system names; must be unique within the spec. */
  readonly roles: ReadonlyArray<string>;
  /** Roles that act as bootstrap seeds.  Defaults to `[roles[0]]`. */
  readonly seedRoles?: ReadonlyArray<string>;
  /** Per-role address overrides.  Auto-allocated if omitted. */
  readonly addresses?: AddressMap;
  /** Failure-detector overrides (tests usually tighten the detector). */
  readonly failureDetector?: ClusterOptionsType['failureDetector'];
  /** Gossip interval, default 100 ms (vs production 1 s). */
  readonly gossipIntervalMs?: number;
  /** How long synchronous `await*` helpers wait before throwing.  Default 10 s. */
  readonly awaitTimeoutMs?: number;
  /** Log level — defaults to a quiet NoopLogger. */
  readonly logLevel?: LogLevel;
  /** Per-role split-brain resolver factory. */
  readonly downing?: (role: string) => DowningProvider | undefined;
  /**
   * When the resolver is consulted, as opposed to which one (#839).
   *
   * A spec that partitions and then asserts on the outcome has to say this:
   * the production default is 20 s, which is longer than any test wants to
   * wait, and the window is deliberately not something a strategy carries — it
   * belongs to the cluster.  A test with a real partition sets a window wider
   * than the spread between its own detections and shorter than its patience.
   */
  readonly splitBrainResolver?: ClusterOptionsType['splitBrainResolver'];
};

/** Fluent builder for {@link MultiNodeSpecOptionsType}. */
export class MultiNodeSpecOptionsBuilder extends OptionsBuilder<MultiNodeSpecOptionsType> {
  /** Start a fresh builder. */
  static create(): MultiNodeSpecOptionsBuilder {
    return new MultiNodeSpecOptionsBuilder();
  }

  /** Role names (also system names); must be unique.  Required. */
  withRoles(roles: ReadonlyArray<string>): this {
    return this.set('roles', roles);
  }

  /** Roles that act as bootstrap seeds.  Defaults to the first role. */
  withSeedRoles(seedRoles: ReadonlyArray<string>): this {
    return this.set('seedRoles', seedRoles);
  }

  /** Per-role address overrides. */
  withAddresses(addresses: AddressMap): this {
    return this.set('addresses', addresses);
  }

  /** Failure-detector overrides. */
  withFailureDetector(failureDetector: ClusterOptionsType['failureDetector']): this {
    return this.set('failureDetector', failureDetector);
  }

  /** Gossip interval in ms.  Default 100. */
  withGossipIntervalMs(gossipIntervalMs: number): this {
    return this.set('gossipIntervalMs', gossipIntervalMs);
  }

  /** `await*` helper timeout in ms.  Default 10 000. */
  withAwaitTimeoutMs(awaitTimeoutMs: number): this {
    return this.set('awaitTimeoutMs', awaitTimeoutMs);
  }

  /** Log level.  Default quiet. */
  withLogLevel(logLevel: LogLevel): this {
    return this.set('logLevel', logLevel);
  }

  /** Per-role split-brain resolver factory. */
  withDowning(downing: (role: string) => DowningProvider | undefined): this {
    return this.set('downing', downing);
  }

  /** How long the view must be unchanged before the resolver decides. */
  withSplitBrainResolver(
    splitBrainResolver: ClusterOptionsType['splitBrainResolver'],
  ): this {
    return this.set('splitBrainResolver', splitBrainResolver);
  }
}

/**
 * Accepted input for a {@link MultiNodeSpec}: the fluent
 * {@link MultiNodeSpecOptionsBuilder} OR a plain {@link MultiNodeSpecOptionsType}.
 */
export type MultiNodeSpecOptions = MultiNodeSpecOptionsBuilder | Partial<MultiNodeSpecOptionsType>;
/** Value alias so `MultiNodeSpecOptions.create()` / `new MultiNodeSpecOptions()` resolve to the builder. */
export const MultiNodeSpecOptions = MultiNodeSpecOptionsBuilder;
