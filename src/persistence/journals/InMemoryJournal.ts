import { InProcessJournalEventBus, type JournalEventBus } from '../JournalEventBus.js';
import type { Journal } from '../Journal.js';
import {
  JournalConcurrencyError,
  type PersistentEvent,
} from '../JournalTypes.js';

/**
 * In-process journal backed by plain arrays.  The default plug-in used by
 * tests and dev-mode; data lives only as long as the process and is NOT
 * shared across ActorSystem instances.  Serves as reference semantics for
 * all other Journal implementations.
 *
 * Exposes an in-process `JournalEventBus` so the query layer can do
 * sub-poll-interval push delivery (see #42).
 */
export class InMemoryJournal implements Journal {
  private readonly streams = new Map<string, PersistentEvent<unknown>[]>();
  /**
   * Highest sequence number ever assigned per persistenceId — the "high
   * water mark".  Kept separate from `streams` so `delete` (compaction)
   * can drop events without rewinding the counter: sequence numbers must
   * never be reused, even after every event for a pid is deleted (Akka
   * semantics).  Mirrors the relational backends' `_meta.deleted_to`.
   */
  private readonly highWater = new Map<string, number>();
  readonly events: JournalEventBus = new InProcessJournalEventBus();

  async append<E>(
    persistenceId: string,
    events: ReadonlyArray<E>,
    expectedSeq: number,
    tags?: ReadonlyArray<string>,
  ): Promise<PersistentEvent<E>[]> {
    const stream = this.streams.get(persistenceId) ?? [];
    const actualSeq = this.highWater.get(persistenceId) ?? 0;
    if (actualSeq !== expectedSeq) {
      throw new JournalConcurrencyError(persistenceId, expectedSeq, actualSeq);
    }
    const now = Date.now();
    const appended: PersistentEvent<E>[] = [];
    let seq = actualSeq;
    for (const ev of events) {
      seq++;
      const pe: PersistentEvent<E> = {
        persistenceId: persistenceId,
        sequenceNr: seq,
        event: ev,
        timestamp: now,
        tags: tags ? [...tags] : undefined,
      };
      appended.push(pe);
      stream.push(pe as PersistentEvent<unknown>);
    }
    this.streams.set(persistenceId, stream);
    this.highWater.set(persistenceId, seq);
    // Publish AFTER the in-memory state is updated so subscribers
    // that immediately re-read see the events they were notified
    // about.
    for (const pe of appended) this.events.publish(pe as PersistentEvent<unknown>);
    return appended;
  }

  async read<E>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    const stream = this.streams.get(persistenceId);
    if (!stream) return [];
    const to = toSeq ?? (this.highWater.get(persistenceId) ?? 0);
    return stream
      .filter(e => e.sequenceNr >= fromSeq && e.sequenceNr <= to)
      .map(e => e as PersistentEvent<E>);
  }

  async highestSeq(persistenceId: string): Promise<number> {
    return this.highWater.get(persistenceId) ?? 0;
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    const stream = this.streams.get(persistenceId);
    if (!stream) return;
    // Drop the events but keep the high-water mark — sequence numbers never
    // rewind, so a subsequent append still expects seq > the highest ever.
    const next = stream.filter(e => e.sequenceNr > toSeq);
    this.streams.set(persistenceId, next);
  }

  async persistenceIds(): Promise<string[]> {
    return Array.from(this.streams.keys());
  }

  async close(): Promise<void> { this.streams.clear(); this.highWater.clear(); }

  /**
   * Migration hook (#9).  Applies `transform` to every persisted
   * event's payload under `persistenceId`, rewriting in place — sequence numbers,
   * timestamps, tags are preserved.  Used by `migrateInMemoryJournal`
   * to wrap legacy raw events into the `_v/_t/_e` envelope when an
   * actor is retro-fitted with an `EventAdapter`.
   *
   * **Internal API.**  Callers should reach for the documented
   * `migrateInMemoryJournal` helper instead of calling this directly;
   * the underscored prefix marks it as a migration-only escape hatch.
   */
  async _remapForMigration<E, F>(persistenceId: string, transform: (e: E) => F): Promise<void> {
    const stream = this.streams.get(persistenceId);
    if (!stream) return;
    for (let i = 0; i < stream.length; i++) {
      const pe = stream[i]!;
      stream[i] = {
        persistenceId: pe.persistenceId,
        sequenceNr: pe.sequenceNr,
        event: transform(pe.event as E),
        timestamp: pe.timestamp,
        tags: pe.tags,
      } as PersistentEvent<unknown>;
    }
  }
}
