import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { KeepOldestSettings } from './KeepOldest.js';

/**
 * Fluent builder for {@link KeepOldestSettings}:
 *
 *     new KeepOldest(KeepOldestOptions.create().withRole('backend'));
 */
export class KeepOldestOptions extends OptionsBuilder<KeepOldestSettings> {
  /** Start a fresh builder. */
  static create(): KeepOldestOptions {
    return new KeepOldestOptions();
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
