import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { DurableStateStore } from './DurableStateStore.js';
import type { DurableStateSettings } from './DurableStateActor.js';

/**
 * Fluent builder for {@link DurableStateSettings}.  A concrete
 * `DurableStateActor` subclass takes a `DurableStateOptions<S>` and hands
 * it to `super(...)`:
 *
 *     class KVActor extends DurableStateActor<Cmd, KV> {
 *       constructor(store: DurableStateStore) {
 *         super(DurableStateOptions.create<KV>()
 *           .withPersistenceId('kv-1')
 *           .withStore(store)
 *           .withEmptyState(() => ({ map: {} })));
 *       }
 *     }
 */
export class DurableStateOptions<S> extends OptionsBuilder<DurableStateSettings<S>> {
  /** Start a fresh builder.  Equivalent to `new DurableStateOptions<S>()`. */
  static create<S>(): DurableStateOptions<S> {
    return new DurableStateOptions<S>();
  }

  /** Stable identity of the state record. */
  withPersistenceId(persistenceId: string): this {
    return this.set('persistenceId', persistenceId);
  }

  /** The backing store the state is persisted to / loaded from. */
  withStore(store: DurableStateStore): this {
    return this.set('store', store);
  }

  /** Factory invoked when no record exists yet. */
  withEmptyState(emptyState: () => S): this {
    return this.set('emptyState', emptyState);
  }
}
