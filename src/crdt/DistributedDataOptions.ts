import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { DurableStateStore } from '../persistence/DurableStateStore.js';
import type { DistributedDataSettings } from './DistributedData.js';

/**
 * Fluent builder for {@link DistributedDataSettings}.  Fed to
 * `DistributedData.start(cluster, options)`; the `cluster` stays a
 * positional argument (it's the identity the store binds to, not a
 * tunable), while the tunables below are accumulated here.
 *
 *     dd.start(cluster, DistributedDataOptions.create()
 *       .withGossipInterval(500)
 *       .withDurableStore(store));
 */
export class DistributedDataOptions extends OptionsBuilder<DistributedDataSettings> {
  /** Start a fresh builder.  Equivalent to `new DistributedDataOptions()`. */
  static create(): DistributedDataOptions {
    return new DistributedDataOptions();
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
