import { Actor } from '../Actor.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import {
  DurableStateConcurrencyError,
  type DurableStateRecord,
  type DurableStateStore,
} from './DurableStateStore.js';
import type {
  CompressionConfig,
  EncryptionConfig,
  PersistenceOptions,
} from './PersistenceOptions.js';
import type { StateAdapter } from './migration/Adapter.js';
import { decodeState, encodeState } from './migration/Envelope.js';

export interface DurableStateSettings<S> {
  readonly persistenceId: string;
  readonly store: DurableStateStore;
  /** Factory invoked when no record exists yet. */
  readonly emptyState: () => S;
}

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

/**
 * Base class for actors that persist a single state value per
 * `persistenceId` instead of an event log.  State is loaded on startup
 * (or an `emptyState` snapshot is used) and persisted after each
 * mutation via `persist(newState)`.
 *
 * User code overrides `onCommand` with the command handler and calls
 * `this.state` to read, `this.persist(next)` to write.  Writes are
 * optimistic — concurrent writers receive `DurableStateConcurrencyError`.
 */
export abstract class DurableStateActor<Cmd, S> extends Actor<Cmd> {
  private _record: DurableStateRecord<S> | null = null;
  private _persisting: Promise<void> | null = null;
  public readonly settings: DurableStateSettings<S>;

  constructor(options: DurableStateOptions<S>) {
    super();
    this.settings = options.build() as DurableStateSettings<S>;
  }

  /** Current state snapshot — safe to read inside a handler. */
  protected get state(): S {
    if (!this._record) {
      // emptyState served as the first value before any persist() completed.
      return this.settings.emptyState();
    }
    return this._record.state;
  }

  protected get revision(): number {
    return this._record?.revision ?? 0;
  }

  /**
   * Optional state adapter for schema evolution.  When defined, the
   * persisted state is wrapped in a `{ _v, _t, _e }` envelope on
   * `persist()` and unwrapped (with up-casting through the adapter) in
   * `preStart()`.  Strict on read: a non-envelope state with adapter
   * present throws `MigrationError`.  See `src/persistence/migration/`.
   */
  protected stateAdapter(): StateAdapter<S> | undefined { return undefined; }

  /**
   * Per-actor compression — overrides the plugin default.  Stores that
   * don't compress ignore it.  Default `undefined` defers to the plugin.
   */
  protected compression(): CompressionConfig | undefined { return undefined; }

  /**
   * Per-actor encryption — overrides the plugin default.  Used on both
   * the write path (encrypt) and the read path (decrypt).  Default
   * `undefined` defers to the plugin.
   */
  protected encryption(): EncryptionConfig | undefined { return undefined; }

  override async preStart(): Promise<void> {
    const adapter = this.stateAdapter();
    const loaded = await this.settings.store.load<unknown>(
      this.settings.persistenceId, this.persistenceOptions(),
    );
    const opt = loaded.toNullable();
    if (!opt) { this._record = null; return; }
    const decoded = decodeState<S>(opt.state, adapter);
    this._record = {
      persistenceId: opt.persistenceId,
      revision: opt.revision,
      state: decoded,
      timestamp: opt.timestamp,
    };
  }

  override async onReceive(cmd: Cmd): Promise<void> {
    if (this._persisting) await this._persisting;
    await this.onCommand(cmd);
  }

  /** User handler — invoked once `preStart` has loaded the record. */
  abstract onCommand(cmd: Cmd): void | Promise<void>;

  /** Persist the new state atomically; rejects on concurrency conflict. */
  protected async persist(next: S): Promise<DurableStateRecord<S>> {
    const expected = this.revision;
    const adapter = this.stateAdapter();
    const wire = adapter ? encodeState(next, adapter) : next;
    // Store sees an envelope (or raw value when no adapter).  We re-stamp
    // the local record with the original `next` so callers see the
    // current-version domain shape.
    const p = this.settings.store.upsert<unknown>(
      this.settings.persistenceId,
      expected,
      wire,
      this.persistenceOptions(),
    );
    this._persisting = p.then(() => undefined, () => undefined);
    try {
      const record = await p;
      const local: DurableStateRecord<S> = {
        persistenceId: record.persistenceId,
        revision: record.revision,
        state: next,
        timestamp: record.timestamp,
      };
      this._record = local;
      return local;
    } catch (err) {
      if (err instanceof DurableStateConcurrencyError) throw err;
      throw err;
    } finally {
      this._persisting = null;
    }
  }

  /** Delete the underlying record and reset to emptyState in memory. */
  protected async deleteRecord(): Promise<void> {
    await this.settings.store.delete(this.settings.persistenceId);
    this._record = null;
  }

  /**
   * Build per-call `PersistenceOptions` from this actor's hooks.
   * Returns `undefined` when neither hook is set.
   */
  private persistenceOptions(): PersistenceOptions | undefined {
    const compression = this.compression();
    const encryption = this.encryption();
    if (!compression && !encryption) return undefined;
    return { compression, encryption };
  }
}
