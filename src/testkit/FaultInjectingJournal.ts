import type { Journal } from '../persistence/Journal.js';
import type { JournalEventBus } from '../persistence/JournalEventBus.js';
import type { JournalEntry, PersistentEvent } from '../persistence/JournalTypes.js';
import type { StorageLocality } from '../persistence/StorageLocality.js';
import {
  FaultInjectingJournalOptionsValidator,
  type FaultInjectingJournalOptions,
  type FaultInjectingJournalOptionsType,
  type JournalOperation,
} from './FaultInjectingJournalOptions.js';
import { FaultScript } from './internal/FaultScript.js';

/**
 * Wrap any {@link Journal} so that chosen operations fail on a script
 * (#1024).
 *
 * ## Why a decorator at the `Journal` seam
 *
 * Every persistence test used to run against a store that worked, so no test
 * had seen `PersistentActor` react to a store error at all.  The one failure
 * injector the suite had sat a level lower, inside one backend's driver, and
 * nothing above that journal ever saw it.  Decorating the interface the
 * framework actually calls means one double covers every backend and every
 * path above it: wrap an `InMemoryJournal` for an actor test, or a real
 * backend for a contract scenario.
 *
 * ## Scripted, not random
 *
 * Which call fails is fixed by {@link FaultInjectingJournalOptionsType}: the
 * operations, how many of their calls pass first, whether only one fails.
 * There is no probability anywhere — a persistence failure test that fails
 * differently on each run cannot tell a fixed defect from a lucky one.
 *
 * ## Two kinds of fault
 *
 * A failing call rejects either before the wrapped journal is reached (the
 * write did not happen) or after it returned (the write happened and its
 * answer was lost) — see `failurePoint`.  Separately, `gapAfterSeq` hides one
 * event from every read, for a history with a hole nothing announced.
 *
 * Optional members of the wrapped journal are forwarded as they are, and a
 * member the wrapped journal leaves out is left out here too — absence is
 * meaningful for `raiseCompactionMark`, so the decorator must not invent one.
 *
 * ```ts
 * const journalFaults = FaultInjectingJournalOptions.create()
 *   .withFailOn('append')
 *   .withFailOnce();
 * const journal = new FaultInjectingJournal(new InMemoryJournal(), journalFaults);
 * system.extension(PersistenceExtensionId).setJournal(journal);
 * ```
 */
export class FaultInjectingJournal implements Journal {
  private readonly settings: FaultInjectingJournalOptionsType;
  private readonly script: FaultScript<JournalOperation>;

  readonly raiseCompactionMark?: (persistenceId: string, throughSeq: number) => Promise<void>;
  readonly persistenceIdsPaginated?: (afterPersistenceId: string | undefined, limit: number) => Promise<string[]>;
  readonly storageIdentity?: () => Promise<string>;
  readonly start?: () => Promise<void>;
  readonly close?: () => Promise<void>;

  /**
   * @param inner the journal that actually stores the events
   * @param options which operations fail, when, and how
   */
  constructor(
    private readonly inner: Journal,
    options: FaultInjectingJournalOptions = {},
  ) {
    const settings = { ...(options as Partial<FaultInjectingJournalOptionsType>) };
    new FaultInjectingJournalOptionsValidator().validate(settings);
    this.settings = settings;
    this.script = new FaultScript<JournalOperation>(settings);
    if (inner.raiseCompactionMark !== undefined) {
      this.raiseCompactionMark = (persistenceId, throughSeq) => inner.raiseCompactionMark!(persistenceId, throughSeq);
    }
    if (inner.persistenceIdsPaginated !== undefined) {
      this.persistenceIdsPaginated = (after, limit) => inner.persistenceIdsPaginated!(after, limit);
    }
    if (inner.storageIdentity !== undefined) this.storageIdentity = () => inner.storageIdentity!();
    if (inner.start !== undefined) this.start = () => inner.start!();
    if (inner.close !== undefined) this.close = () => inner.close!();
  }

  /**
   * Read through rather than copied, so a fixture that changes the wrapped
   * journal's locality after construction is seen here too.
   */
  get storageLocality(): StorageLocality | undefined { return this.inner.storageLocality; }

  /** The wrapped journal's event bus, so push-based queries keep working. */
  get events(): JournalEventBus | undefined { return this.inner.events; }

  /** How many failures this journal has injected so far. */
  get failuresInjected(): number { return this.script.failuresInjected; }

  /** How many times `operation` was called, failing calls included. */
  callsTo(operation: JournalOperation): number { return this.script.callsTo(operation); }

  append<E = unknown>(
    persistenceId: string,
    entries: ReadonlyArray<JournalEntry<E>>,
    expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    return this.script.run('append', () => this.inner.append(persistenceId, entries, expectedSeq));
  }

  async read<E = unknown>(
    persistenceId: string,
    fromSeq: number,
    toSeq?: number,
  ): Promise<PersistentEvent<E>[]> {
    const events = await this.script.run('read', () => this.inner.read<E>(persistenceId, fromSeq, toSeq));
    const gapAfterSeq = this.settings.gapAfterSeq;
    return gapAfterSeq === undefined ? events : events.filter((event) => event.sequenceNr !== gapAfterSeq + 1);
  }

  highestSeq(persistenceId: string): Promise<number> {
    return this.script.run('highestSeq', () => this.inner.highestSeq(persistenceId));
  }

  delete(persistenceId: string, toSeq: number): Promise<void> {
    return this.script.run('delete', () => this.inner.delete(persistenceId, toSeq));
  }

  persistenceIds(): Promise<string[]> {
    return this.inner.persistenceIds();
  }
}
