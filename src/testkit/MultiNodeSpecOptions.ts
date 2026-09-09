import type { Scheduler } from '../Scheduler.js';
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
  /**
   * One scheduler shared by every node in the spec.  Default: each node system
   * builds its own wall-clock one.
   *
   * Pass a `ManualScheduler` and the whole cluster runs on one virtual clock —
   * gossip, heartbeats, failure detection and downing all advance together
   * through {@link MultiNodeSpec.advance}, which is the only way to make a
   * convergence question deterministic rather than a race against a budget.
   *
   * Sharing one across four systems is what made the ownership rule in
   * `ActorSystem` matter: a borrowed scheduler is not shut down by the first
   * node that terminates (#1424).
   */
  readonly scheduler?: Scheduler;
  /** Log level — defaults to a quiet NoopLogger. */
  readonly logLevel?: LogLevel;
  /** Per-role split-brain resolver factory. */
  readonly downing?: (role: string) => DowningProvider | undefined;
  /**
   * How long the membership view must hold still before {@link downing} is
   * consulted, in ms.  Default 100 (vs production 20 s) — #839.
   *
   * Scaled down for the same reason {@link gossipIntervalMs} and the harness's
   * seed-retry interval are: a spec's whole point is to partition a cluster
   * and assert on what happens next, and the shipped window is twice the
   * default {@link awaitTimeoutMs}, so a spec that inherited it would time out
   * before its resolver was asked anything.  Raise it in a spec that is
   * *about* the window.
   */
  readonly stableAfterMs?: number;
  /**
   * Seed for every transport fault this spec injects — see
   * `MultiNodeSpec.degrade`.  Default `DEFAULT_TRANSPORT_FAULT_SEED`.
   *
   * Fixed rather than random on purpose: an unreproducible chaos test is a
   * flake generator, and this repository has a flake catalogue it is trying to
   * shrink.  A failing spec names this number in its timeout message, so the
   * red run reproduces from the log alone (#1023).
   */
  readonly faultSeed?: number;
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
  /** One scheduler shared by every node — pass a `ManualScheduler` for virtual time. */
  withScheduler(scheduler: Scheduler): this {
    return this.set('scheduler', scheduler);
  }

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

  /** Stability window before the resolver is consulted, in ms.  Default 100. */
  withStableAfterMs(stableAfterMs: number): this {
    return this.set('stableAfterMs', stableAfterMs);
  }

  /** Seed for every injected transport fault.  Default `DEFAULT_TRANSPORT_FAULT_SEED`. */
  withFaultSeed(faultSeed: number): this {
    return this.set('faultSeed', faultSeed);
  }
}

/**
 * Accepted input for a {@link MultiNodeSpec}: the fluent
 * {@link MultiNodeSpecOptionsBuilder} OR a plain {@link MultiNodeSpecOptionsType}.
 */
export type MultiNodeSpecOptions = MultiNodeSpecOptionsBuilder | Partial<MultiNodeSpecOptionsType>;
/** Value alias so `MultiNodeSpecOptions.create()` / `new MultiNodeSpecOptions()` resolve to the builder. */
export const MultiNodeSpecOptions = MultiNodeSpecOptionsBuilder;
