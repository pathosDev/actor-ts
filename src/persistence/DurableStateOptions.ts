import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { DurableStateStore } from './DurableStateStore.js';

export interface DurableStateOptionsType<S> {
  readonly persistenceId: string;
  readonly store: DurableStateStore;
  /** Factory invoked when no record exists yet. */
  readonly emptyState: () => S;
}

/**
 * Fluent builder for {@link DurableStateOptionsType}.  A concrete
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
export class DurableStateOptionsBuilder<S> extends OptionsBuilder<DurableStateOptionsType<S>> {
  /** Start a fresh builder.  Equivalent to `new DurableStateOptionsBuilder<S>()`. */
  static create<S>(): DurableStateOptionsBuilder<S> {
    return new DurableStateOptionsBuilder<S>();
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

/**
 * Accepted input for a `DurableStateActor` subclass constructor: the fluent
 * {@link DurableStateOptionsBuilder} OR a plain {@link DurableStateOptionsType} object.
 */
export type DurableStateOptions<S> = DurableStateOptionsBuilder<S> | Partial<DurableStateOptionsType<S>>;
/** Value alias so `DurableStateOptions.create()` / `new DurableStateOptions()` resolve to the builder. */
export const DurableStateOptions = DurableStateOptionsBuilder;
