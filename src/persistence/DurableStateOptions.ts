import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { DurableStateStore } from './DurableStateStore.js';
import { persistenceIdRejection } from './storage/PersistenceIdValidator.js';

export type DurableStateOptionsType<S> = {
  readonly persistenceId: string;
  readonly store: DurableStateStore;
  /** Factory invoked when no record exists yet. */
  readonly emptyState: () => S;
};

/**
 * Fluent builder for {@link DurableStateOptionsType}.  A concrete
 * `DurableStateActor` subclass takes a `DurableStateOptions<S>` and hands
 * it to `super(...)`:
 *
 *     class KVActor extends DurableStateActor<Command, KV> {
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
 * Rejects a `persistenceId` that cannot be a storage key (#133).
 *
 * The rules themselves live in `PersistenceIdValidator` — shared with
 * `PersistentActor`, `ReplicatedEventSourcedActor` and the journals, so
 * the three actor flavours cannot drift on what an id may look like.  Only
 * the *error type* differs: here the id arrives as an option, so a
 * violation is an `OptionsError` reported against the `persistenceId`
 * field, consistent with every other `XOptionsValidator`.
 *
 * An unset `persistenceId` passes, as every check helper does on
 * `undefined` — required-ness is not this validator's job.  There is no
 * separate `nonEmptyString` call: the shared rule already rejects `''`
 * with the same wording, and stating it twice invites the two to drift.
 */
export class DurableStateOptionsValidator<S> extends OptionsValidator<DurableStateOptionsType<S>> {
  constructor() { super('DurableStateOptions'); }

  protected rules(s: Partial<DurableStateOptionsType<S>>): void {
    if (s.persistenceId === undefined) return;
    const reason = persistenceIdRejection(s.persistenceId);
    if (reason !== null) this.fail('persistenceId', reason, s.persistenceId);
  }
}

/**
 * Accepted input for a `DurableStateActor` subclass constructor: the fluent
 * {@link DurableStateOptionsBuilder} OR a plain {@link DurableStateOptionsType} object.
 */
export type DurableStateOptions<S> = DurableStateOptionsBuilder<S> | Partial<DurableStateOptionsType<S>>;
/** Value alias so `DurableStateOptions.create()` / `new DurableStateOptions()` resolve to the builder. */
export const DurableStateOptions = DurableStateOptionsBuilder;
