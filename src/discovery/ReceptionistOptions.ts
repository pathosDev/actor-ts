import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { Cluster } from '../cluster/Cluster.js';

/** Plain options-object shape accepted by a {@link Receptionist}. */
export interface ReceptionistOptionsType {
  readonly cluster?: Cluster | null;
  readonly gossipIntervalMs?: number;
}

/**
 * Fluent builder for {@link ReceptionistOptionsType}.  Normally you don't
 * touch this directly — `system.extension(ReceptionistId).start(cluster,
 * options)` supplies the `cluster` positionally and only the tunables
 * (`withGossipIntervalMs`) come through the builder.
 */
export class ReceptionistOptionsBuilder extends OptionsBuilder<ReceptionistOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ReceptionistOptionsBuilder()`. */
  static create(): ReceptionistOptionsBuilder {
    return new ReceptionistOptionsBuilder();
  }

  /** The cluster this receptionist gossips over.  `null` = single-node (no gossip). */
  withCluster(cluster: Cluster | null): this {
    return this.set('cluster', cluster);
  }

  /** Interval between gossip pushes in milliseconds.  Default: cluster gossip interval. */
  withGossipIntervalMs(gossipIntervalMs: number): this {
    return this.set('gossipIntervalMs', gossipIntervalMs);
  }
}

/** Validates resolved {@link ReceptionistOptionsType} settings. */
export class ReceptionistOptionsValidator extends OptionsValidator<ReceptionistOptionsType> {
  constructor() {
    super('ReceptionistOptions');
  }
  protected rules(_s: Partial<ReceptionistOptionsType>): void {
    this.positiveNumber('gossipIntervalMs');
  }
}

/**
 * Accepted input for the {@link Receptionist} constructor: the fluent
 * {@link ReceptionistOptionsBuilder} OR a plain {@link ReceptionistOptionsType}
 * object.
 */
export type ReceptionistOptions = ReceptionistOptionsBuilder | Partial<ReceptionistOptionsType>;
/** Value alias so `ReceptionistOptions.create()` / `new ReceptionistOptions()` resolve to the builder. */
export const ReceptionistOptions = ReceptionistOptionsBuilder;
