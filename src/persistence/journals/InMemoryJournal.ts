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
  readonly events: JournalEventBus = new InProcessJournalEventBus();

  async append<E>(
    pid: string,
    events: ReadonlyArray<E>,
    expectedSeq: number,
    tags?: ReadonlyArray<string>,
  ): Promise<PersistentEvent<E>[]> {
    const stream = this.streams.get(pid) ?? [];
    const actualSeq = stream.length === 0 ? 0 : stream[stream.length - 1]!.sequenceNr;
    if (actualSeq !== expectedSeq) {
      throw new JournalConcurrencyError(pid, expectedSeq, actualSeq);
    }
    const now = Date.now();
    const appended: PersistentEvent<E>[] = [];
    let seq = actualSeq;
    for (const ev of events) {
      seq++;
      const pe: PersistentEvent<E> = {
        persistenceId: pid,
        sequenceNr: seq,
        event: ev,
        timestamp: now,
        tags: tags ? [...tags] : undefined,
      };
      appended.push(pe);
      stream.push(pe as PersistentEvent<unknown>);
    }
    this.streams.set(pid, stream);
    // Publish AFTER the in-memory state is updated so subscribers
    // that immediately re-read see the events they were notified
    // about.
    for (const pe of appended) this.events.publish(pe as PersistentEvent<unknown>);
    return appended;
  }

  async read<E>(pid: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    const stream = this.streams.get(pid);
    if (!stream) return [];
    const to = toSeq ?? (stream.length === 0 ? 0 : stream[stream.length - 1]!.sequenceNr);
    return stream
      .filter(e => e.sequenceNr >= fromSeq && e.sequenceNr <= to)
      .map(e => e as PersistentEvent<E>);
  }

  async highestSeq(pid: string): Promise<number> {
    const stream = this.streams.get(pid);
    if (!stream || stream.length === 0) return 0;
    return stream[stream.length - 1]!.sequenceNr;
  }

  async delete(pid: string, toSeq: number): Promise<void> {
    const stream = this.streams.get(pid);
    if (!stream) return;
    const next = stream.filter(e => e.sequenceNr > toSeq);
    this.streams.set(pid, next);
  }

  async persistenceIds(): Promise<string[]> {
    return Array.from(this.streams.keys());
  }

  async close(): Promise<void> { this.streams.clear(); }

  /**
   * Migration hook (#9).  Applies `transform` to every persisted
   * event's payload under `pid`, rewriting in place — sequence numbers,
   * timestamps, tags are preserved.  Used by `migrateInMemoryJournal`
   * to wrap legacy raw events into the `_v/_t/_e` envelope when an
   * actor is retro-fitted with an `EventAdapter`.
   *
   * **Internal API.**  Callers should reach for the documented
   * `migrateInMemoryJournal` helper instead of calling this directly;
   * the underscored prefix marks it as a migration-only escape hatch.
   */
  async _remapForMigration<E, F>(pid: string, transform: (e: E) => F): Promise<void> {
    const stream = this.streams.get(pid);
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
