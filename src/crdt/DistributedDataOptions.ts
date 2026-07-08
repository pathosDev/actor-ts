import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { DurableStateStore } from '../persistence/DurableStateStore.js';

/** Plain settings-object shape accepted by {@link DistributedData.start}. */
export interface DistributedDataOptionsType {
  /** Period between gossip pushes.  Default: 1 s. */
  readonly gossipInterval?: number;
  /**
   * Optional durable backend.  When provided, the local CRDT view
   * is loaded from the store on `preStart` and re-saved after every
   * mutation (local update, gossip merge, delete).  Without this,
   * `DistributedData` is purely in-memory — a full cluster restart
   * (deploy / outage) starts every replica empty.
   *
   * The store is keyed by replica id, so each cluster member owns
   * its own durable record.  CRDT semantics handle convergence
   * across replicas via gossip — durability is per-replica.
   *
   * Plug in any of the existing `DurableStateStore` implementations:
   * `InMemoryDurableStateStore` for tests, the SQLite / Cassandra /
   * S3 / filesystem backends for production.
   */
  readonly durableStore?: DurableStateStore;
}

/**
 * Fluent builder for {@link DistributedDataOptionsType}.  Fed to
 * `DistributedData.start(cluster, options)`; the `cluster` stays a
 * positional argument (it's the identity the store binds to, not a
 * tunable), while the tunables below are accumulated here.
 *
 *     dd.start(cluster, DistributedDataOptions.create()
 *       .withGossipInterval(500)
 *       .withDurableStore(store));
 */
export class DistributedDataOptionsBuilder extends OptionsBuilder<DistributedDataOptionsType> {
  /** Start a fresh builder.  Equivalent to `new DistributedDataOptionsBuilder()`. */
  static create(): DistributedDataOptionsBuilder {
    return new DistributedDataOptionsBuilder();
  }

  /** Period between gossip pushes in milliseconds.  Default 1 s. */
  withGossipInterval(ms: number): this {
    return this.set('gossipInterval', ms);
  }

  /** Durable per-replica backend — load on start, re-save after each mutation. */
  withDurableStore(store: DurableStateStore): this {
    return this.set('durableStore', store);
  }
}

/** Validates resolved {@link DistributedDataOptionsType} settings. */
export class DistributedDataOptionsValidator extends OptionsValidator<DistributedDataOptionsType> {
  constructor() {
    super('DistributedDataOptions');
  }
  protected rules(_s: Partial<DistributedDataOptionsType>): void {
    this.positiveNumber('gossipInterval');
  }
}

/**
 * Accepted input for {@link DistributedData.start}: the fluent
 * {@link DistributedDataOptionsBuilder} OR a plain
 * {@link DistributedDataOptionsType} object.
 */
export type DistributedDataOptions = DistributedDataOptionsBuilder | Partial<DistributedDataOptionsType>;
/** Value alias so `DistributedDataOptions.create()` / `new DistributedDataOptions()` resolve to the builder. */
export const DistributedDataOptions = DistributedDataOptionsBuilder;
