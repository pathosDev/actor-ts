import type { Lease } from '../../coordination/Lease.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { LeaseMajoritySettings } from './LeaseMajority.js';

/**
 * Fluent builder for {@link LeaseMajoritySettings}:
 *
 *     new LeaseMajority(
 *       LeaseMajorityOptions.create()
 *         .withLease(kubernetesLease)
 *         .withAcquireTimeoutMs(5_000),
 *     );
 */
export class LeaseMajorityOptions extends OptionsBuilder<LeaseMajoritySettings> {
  /** Start a fresh builder. */
  static create(): LeaseMajorityOptions {
    return new LeaseMajorityOptions();
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
