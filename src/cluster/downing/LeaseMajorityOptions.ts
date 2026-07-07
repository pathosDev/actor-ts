import type { Lease } from '../../coordination/Lease.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/** Plain settings-object shape accepted by {@link LeaseMajority}. */
export interface LeaseMajorityOptionsType {
  /**
   * External arbiter — typically a `KubernetesLease` so both sides
   * of a partition reach the same K8s API and only one acquires.
   * Each replica owns its own `Lease` instance with a distinct
   * `owner` (its node address); the underlying lease record is
   * shared (same `name`).
   */
  readonly lease: Lease;
  /**
   * Hard ceiling on a single `acquire()` attempt.  After this we
   * return no decision and let the next failure-detection tick
   * trigger a fresh attempt.  Default: 5 s.
   */
  readonly acquireTimeoutMs?: number;
  /** If set, only members carrying this role count toward the majority. */
  readonly role?: string;
}

/**
 * Fluent builder for {@link LeaseMajorityOptionsType}:
 *
 *     new LeaseMajority(
 *       LeaseMajorityOptions.create()
 *         .withLease(kubernetesLease)
 *         .withAcquireTimeoutMs(5_000),
 *     );
 */
export class LeaseMajorityOptionsBuilder extends OptionsBuilder<LeaseMajorityOptionsType> {
  /** Start a fresh builder. */
  static create(): LeaseMajorityOptionsBuilder {
    return new LeaseMajorityOptionsBuilder();
  }

  /** External arbiter lease — both sides of a partition contend for it. */
  withLease(lease: Lease): this {
    return this.set('lease', lease);
  }

  /** Hard ceiling on a single `acquire()` attempt in ms.  Default 5 s. */
  withAcquireTimeoutMs(ms: number): this {
    return this.set('acquireTimeoutMs', ms);
  }

  /** Only members carrying this role count toward the majority. */
  withRole(role: string): this {
    return this.set('role', role);
  }
}

/**
 * Accepted input for the {@link LeaseMajority} constructor: the fluent
 * {@link LeaseMajorityOptionsBuilder} OR a plain {@link LeaseMajorityOptionsType}
 * object.
 */
export type LeaseMajorityOptions = LeaseMajorityOptionsBuilder | Partial<LeaseMajorityOptionsType>;
/** Value alias so `LeaseMajorityOptions.create()` / `new LeaseMajorityOptions()` resolve to the builder. */
export const LeaseMajorityOptions = LeaseMajorityOptionsBuilder;
