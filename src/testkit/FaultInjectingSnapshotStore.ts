import type { Snapshot } from '../persistence/JournalTypes.js';
import type { PersistenceOptionSupport } from '../persistence/PersistenceCapabilities.js';
import type { PersistenceOptions } from '../persistence/PersistenceOptions.js';
import type { SnapshotStore } from '../persistence/SnapshotStore.js';
import type { StorageLocality } from '../persistence/StorageLocality.js';
import type { Option } from '../util/Option.js';
import {
  FaultInjectingSnapshotStoreOptionsValidator,
  type FaultInjectingSnapshotStoreOptions,
  type FaultInjectingSnapshotStoreOptionsType,
  type SnapshotStoreOperation,
} from './FaultInjectingSnapshotStoreOptions.js';
import { FaultScript } from './internal/FaultScript.js';

/**
 * Wrap any {@link SnapshotStore} so that chosen operations fail on a script
 * (#1024) — the snapshot half of `FaultInjectingJournal`, with the same
 * counting rules and the same two failure points.
 *
 * The case it exists for is the one an always-working store hides: a
 * snapshot write that fails *after* the journal append it follows has
 * succeeded, so the event is durable while the command that wrote it fails.
 *
 * Optional members — `persistenceOptionSupport` above all, which decides
 * whether an actor with `encryption()` is refused at start — are forwarded
 * from the wrapped store unchanged, so wrapping a store never changes what
 * the framework believes it can do.
 *
 * ```ts
 * const snapshotFaults = FaultInjectingSnapshotStoreOptions.create().withFailOn('save');
 * const snapshots = new FaultInjectingSnapshotStore(new InMemorySnapshotStore(), snapshotFaults);
 * system.extension(PersistenceExtensionId).setSnapshotStore(snapshots);
 * ```
 */
export class FaultInjectingSnapshotStore implements SnapshotStore {
  private readonly script: FaultScript<SnapshotStoreOperation>;

  readonly encryptsAtRest?: (persistenceId: string) => boolean | undefined;
  readonly storageIdentity?: () => Promise<string>;
  readonly start?: () => Promise<void>;
  readonly close?: () => Promise<void>;

  /**
   * @param inner the store that actually keeps the snapshots
   * @param options which operations fail, when, and how
   */
  constructor(
    private readonly inner: SnapshotStore,
    options: FaultInjectingSnapshotStoreOptions = {},
  ) {
    const settings = { ...(options as Partial<FaultInjectingSnapshotStoreOptionsType>) };
    new FaultInjectingSnapshotStoreOptionsValidator().validate(settings);
    this.script = new FaultScript<SnapshotStoreOperation>(settings);
    if (inner.encryptsAtRest !== undefined) this.encryptsAtRest = (persistenceId) => inner.encryptsAtRest!(persistenceId);
    if (inner.storageIdentity !== undefined) this.storageIdentity = () => inner.storageIdentity!();
    if (inner.start !== undefined) this.start = () => inner.start!();
    if (inner.close !== undefined) this.close = () => inner.close!();
  }

  /** Read through rather than copied — see `FaultInjectingJournal.storageLocality`. */
  get storageLocality(): StorageLocality | undefined { return this.inner.storageLocality; }

  /** The wrapped store's declaration, so the capability check at start answers as it would unwrapped. */
  get persistenceOptionSupport(): PersistenceOptionSupport | undefined { return this.inner.persistenceOptionSupport; }

  /** How many failures this store has injected so far. */
  get failuresInjected(): number { return this.script.failuresInjected; }

  /** How many times `operation` was called, failing calls included. */
  callsTo(operation: SnapshotStoreOperation): number { return this.script.callsTo(operation); }

  save<S = unknown>(
    persistenceId: string,
    seq: number,
    state: S,
    options?: PersistenceOptions,
  ): Promise<Snapshot<S>> {
    return this.script.run('save', () => this.inner.save(persistenceId, seq, state, options));
  }

  loadLatest<S = unknown>(persistenceId: string, options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    return this.script.run('loadLatest', () => this.inner.loadLatest<S>(persistenceId, options));
  }

  loadBefore<S = unknown>(
    persistenceId: string,
    seq: number,
    options?: PersistenceOptions,
  ): Promise<Option<Snapshot<S>>> {
    return this.script.run('loadBefore', () => this.inner.loadBefore<S>(persistenceId, seq, options));
  }

  delete(persistenceId: string, toSeq: number): Promise<void> {
    return this.script.run('delete', () => this.inner.delete(persistenceId, toSeq));
  }
}
