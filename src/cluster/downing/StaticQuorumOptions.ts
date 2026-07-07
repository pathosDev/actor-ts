import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { StaticQuorumSettings } from './StaticQuorum.js';

/**
 * Fluent builder for {@link StaticQuorumSettings}:
 *
 *     new StaticQuorum(StaticQuorumOptions.create().withQuorumSize(3));
 */
export class StaticQuorumOptions extends OptionsBuilder<StaticQuorumSettings> {
  /** Start a fresh builder. */
  static create(): StaticQuorumOptions {
    return new StaticQuorumOptions();
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
