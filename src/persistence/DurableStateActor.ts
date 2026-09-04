import { Actor } from '../Actor.js';
import {
  DurableStateConcurrencyError,
  type DurableStateRecord,
} from './DurableStateStore.js';
import type {
  CompressionConfig,
  EncryptionConfig,
  IntegrityConfig,
  PersistenceOptions,
} from './PersistenceOptions.js';
import type { StateAdapter } from './migration/Adapter.js';
import { decodeState, encodeState } from './migration/Envelope.js';
import type { DurableStateOptions, DurableStateOptionsType } from './DurableStateOptions.js';
import { DurableStateOptionsValidator } from './DurableStateOptions.js';
import { PersistenceExtensionId } from './PersistenceExtension.js';

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
export abstract class DurableStateActor<Command, S> extends Actor<Command> {
  private _record: DurableStateRecord<S> | null = null;
  private _persisting: Promise<void> | null = null;
  public readonly options: DurableStateOptionsType<S>;

  constructor(options: DurableStateOptions<S>) {
    super();
    this.options = options as DurableStateOptionsType<S>;
    // Consume-time validation, per the options convention: the builder, a
    // plain object and a HOCON-sourced shape all end up here.  Earlier
    // than `preStart` on purpose — an id that can never address a record
    // is worth refusing before the actor is wired to a store (#133).
    new DurableStateOptionsValidator<S>().validate(this.options);
  }

  /** Current state snapshot — safe to read inside a handler. */
  protected get state(): S {
    if (!this._record) {
      // emptyState served as the first value before any persist() completed.
      return this.options.emptyState();
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
   * Per-actor compression — overrides the plugin default.  Default
   * `undefined` defers to the plugin.
   *
   * **Only the object-storage durable-state store compresses.**  Nine of the
   * ten durable-state stores accept `PersistenceOptions` and never read it,
   * so setting an algorithm here buys nothing on SQLite, Postgres, MariaDB,
   * MSSQL, libSQL, D1, Mongo, DynamoDB or the in-memory reference store.
   * Unlike the two hooks below it does not refuse the actor — it is a
   * performance hint — so it logs one warning naming the store and the
   * record is written uncompressed (#960).
   */
  protected compression(): CompressionConfig | undefined { return undefined; }

  /**
   * Per-actor encryption — overrides the plugin default.  Used on both
   * the write path (encrypt) and the read path (decrypt).  Default
   * `undefined` defers to the plugin.
   *
   * **Only the object-storage durable-state store encrypts.**  Setting this
   * on an actor backed by any other shipped store now **refuses the actor at
   * start** with an `UnsupportedPersistenceOptionError` naming the store
   * (#960).  The refusal precedes `preStart`'s load, not just the first
   * write: a durable-state actor reads before it writes, and reading against
   * a store that cannot decrypt returns a plaintext record the actor would
   * treat as having been ciphertext.  `{ mode: 'none' }` is accepted
   * everywhere.
   */
  protected encryption(): EncryptionConfig | undefined { return undefined; }

  /**
   * Per-actor body integrity — overrides the plugin default.  Used on the
   * write path (sign) and the read path (verify).  Default `undefined`
   * defers to the plugin.
   *
   * **Only the object-storage durable-state store signs and verifies.**
   * Same refusal as `encryption()` above: configuring `hmac-sha256` against
   * a store that does not implement it throws
   * `UnsupportedPersistenceOptionError` at start instead of silently buying
   * no tamper detection (#960).  A store is asked through its
   * `persistenceOptionSupport` declaration, so a third-party store that
   * declares nothing is treated as unknown and is never refused.
   */
  protected integrity(): IntegrityConfig | undefined { return undefined; }

  override async preStart(): Promise<void> {
    // The storage-locality latch (#1356) — same seam as `PersistentActor`:
    // the store the options carry is in actual use from here on.
    const persistence = this.system.extension(PersistenceExtensionId);
    persistence.noteStoreUse('durable-state-store', this.options.store);
    // The capability check (#960) has to precede the load below, not merely
    // the first `persist`: loading with `encryption()` set against a store
    // that cannot decrypt returns a plaintext record the actor then treats
    // as having been ciphertext all along.
    persistence.assertPersistenceOptionsSupported(
      'durable-state-store', this.options.store, this.persistenceOptions(),
    );
    const adapter = this.stateAdapter();
    const loaded = await this.options.store.load<unknown>(
      this.options.persistenceId, this.persistenceOptions(),
    );
    const option = loaded.toNullable();
    if (!option) { this._record = null; return; }
    const decoded = decodeState<S>(option.state, adapter);
    this._record = {
      persistenceId: option.persistenceId,
      revision: option.revision,
      state: decoded,
      timestamp: option.timestamp,
    };
  }

  override async onReceive(command: Command): Promise<void> {
    if (this._persisting) await this._persisting;
    await this.onCommand(command);
  }

  /** User handler — invoked once `preStart` has loaded the record. */
  abstract onCommand(command: Command): void | Promise<void>;

  /** Persist the new state atomically; rejects on concurrency conflict. */
  protected async persist(next: S): Promise<DurableStateRecord<S>> {
    const expected = this.revision;
    const adapter = this.stateAdapter();
    const wire = adapter ? encodeState(next, adapter) : next;
    // Store sees an envelope (or raw value when no adapter).  We re-stamp
    // the local record with the original `next` so callers see the
    // current-version domain shape.
    const upsertPromise = this.options.store.upsert<unknown>(
      this.options.persistenceId,
      expected,
      wire,
      this.persistenceOptions(),
    );
    this._persisting = upsertPromise.then(() => undefined, () => undefined);
    try {
      const record = await upsertPromise;
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
    await this.options.store.delete(this.options.persistenceId);
    this._record = null;
  }

  /**
   * Build per-call `PersistenceOptions` from this actor's hooks.
   * Returns `undefined` when no hook is set.
   */
  private persistenceOptions(): PersistenceOptions | undefined {
    const compression = this.compression();
    const encryption = this.encryption();
    const integrity = this.integrity();
    if (!compression && !encryption && !integrity) return undefined;
    return { compression, encryption, integrity };
  }
}
