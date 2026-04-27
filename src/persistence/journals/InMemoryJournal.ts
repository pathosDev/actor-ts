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
 */
export class InMemoryJournal implements Journal {
  private readonly streams = new Map<string, PersistentEvent<unknown>[]>();

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
}
