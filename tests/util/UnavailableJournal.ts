/**
 * Journals that are *down* rather than wrong — the two shapes a backend
 * outage actually takes, and the doubles #1024 records as missing.
 *
 * The distinction matters because only one of them is caught by anything the
 * suite had before.  A journal that **rejects** is already reachable with a
 * one-line inline fake and half a dozen tests write one.  A journal that
 * **never settles** is not: it is the failure a circuit breaker's
 * `call-timeout` exists for, it is what leaves `PersistentActor._persisting`
 * true forever, and an inline version of it hangs the test file rather than
 * failing it unless every caller remembers the same three precautions.  Both
 * live here so a test can name the outage it means instead of building one.
 *
 * Shared on purpose, so the next suite that needs "the journal is gone" does
 * not write a seventh variant with slightly different semantics.  The partial
 * outages — a journal that reads but cannot write, a replay held at a gate, a
 * snapshot store that is gone while the journal is fine — live here for the
 * same reason, since more than one actor class is tested against each of them.
 */
import type { Journal } from '../../src/persistence/Journal.js';
import type { JournalEntry, PersistentEvent, Snapshot } from '../../src/persistence/JournalTypes.js';
import type { SnapshotStore } from '../../src/persistence/SnapshotStore.js';
import type { Option } from '../../src/util/Option.js';

/** Error a {@link RejectingJournal} raises, unless the test supplies its own. */
export class JournalUnavailableError extends Error {
  constructor(operation: string) {
    super(`journal is unavailable (${operation})`);
    this.name = 'JournalUnavailableError';
  }
}

/**
 * Every operation rejects — the connection-refused shape.
 *
 * `errorFor` lets a test decide *which* error, which is what makes the
 * breaker's `isFailure` classifier assertable: hand it a
 * `JournalConcurrencyError` and the breaker must not count it.
 */
export class RejectingJournal implements Journal {
  /** Calls made, in order — `append`, `read`, `highestSeq`, … */
  readonly calls: string[] = [];

  constructor(private readonly errorFor: (operation: string) => Error = (o) => new JournalUnavailableError(o)) {}

  async append<E = unknown>(
    _persistenceId: string,
    _entries: ReadonlyArray<JournalEntry<E>>,
    _expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    return this.fail('append');
  }

  async read<E = unknown>(): Promise<PersistentEvent<E>[]> { return this.fail('read'); }

  async highestSeq(): Promise<number> { return this.fail('highestSeq'); }

  async delete(): Promise<void> { return this.fail('delete'); }

  async persistenceIds(): Promise<string[]> { return this.fail('persistenceIds'); }

  private fail(operation: string): never {
    this.calls.push(operation);
    throw this.errorFor(operation);
  }
}

/**
 * Every operation returns a promise that never settles — the accepted-then-
 * stalled shape, and the one an unbounded `await` cannot survive.
 *
 * The pending promises are held so {@link settleAll} can end them at teardown.
 * Leaving them dangling is not merely untidy: a promise that never settles
 * keeps every closure it captured alive for the rest of the process, and a
 * suite that made a few hundred of them leaks the actors behind them.  Call
 * `settleAll()` in the test's cleanup.
 */
export class StallingJournal implements Journal {
  private readonly pending: Array<(error: Error) => void> = [];

  /** Operations that have been called and are still hanging. */
  get inFlight(): number { return this.pending.length; }

  async append<E = unknown>(
    _persistenceId: string,
    _entries: ReadonlyArray<JournalEntry<E>>,
    _expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    return this.stall();
  }

  async read<E = unknown>(): Promise<PersistentEvent<E>[]> { return this.stall(); }

  async highestSeq(): Promise<number> { return this.stall(); }

  async delete(): Promise<void> { return this.stall(); }

  async persistenceIds(): Promise<string[]> { return this.stall(); }

  /**
   * Reject everything still hanging, so the promises are collectable and any
   * `await` still parked on one unwinds.  Idempotent.
   */
  settleAll(reason = 'StallingJournal.settleAll'): void {
    const parked = this.pending.splice(0, this.pending.length);
    for (const reject of parked) reject(new JournalUnavailableError(reason));
  }

  private stall<T>(): Promise<T> {
    return new Promise<T>((_resolve, reject) => { this.pending.push(reject); });
  }
}

/** A journal whose `read` waits on a gate the test opens — a slow replay. */
export class GatedJournal implements Journal {
  readonly reading: string[] = [];

  constructor(private readonly gate: Promise<void>) {}

  async append<E = unknown>(
    _persistenceId: string,
    _entries: ReadonlyArray<JournalEntry<E>>,
    _expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> { throw new Error('GatedJournal is read-only'); }

  async read<E = unknown>(persistenceId: string): Promise<PersistentEvent<E>[]> {
    this.reading.push(persistenceId);
    await this.gate;
    return [];
  }

  async highestSeq(): Promise<number> { return 0; }
  async delete(): Promise<void> {}
  async persistenceIds(): Promise<string[]> { return []; }
}

/**
 * Reads like an ordinary journal, but every `append` hangs.
 *
 * One object rather than swapping the extension's journal mid-test:
 * `PersistentActor` resolves its journal once in `preStart`, so a later
 * `setJournal` would leave the actor writing to the store it already held —
 * a test that passed for the wrong reason, or in this case did not pass at
 * all.  A store that accepts the connection and then stalls on writes is also
 * the more faithful shape of the outage.
 */
export class AppendStallsJournal implements Journal {
  private readonly pending: Array<(error: Error) => void> = [];

  constructor(private readonly reads: Journal) {}

  async append<E = unknown>(
    _persistenceId: string,
    _entries: ReadonlyArray<JournalEntry<E>>,
    _expectedSeq: number,
  ): Promise<PersistentEvent<E>[]> {
    return new Promise<PersistentEvent<E>[]>((_resolve, reject) => { this.pending.push(reject); });
  }

  read<E = unknown>(persistenceId: string, fromSeq: number, toSeq?: number): Promise<PersistentEvent<E>[]> {
    return this.reads.read<E>(persistenceId, fromSeq, toSeq);
  }

  highestSeq(persistenceId: string): Promise<number> { return this.reads.highestSeq(persistenceId); }
  delete(persistenceId: string, toSeq: number): Promise<void> { return this.reads.delete(persistenceId, toSeq); }
  persistenceIds(): Promise<string[]> { return this.reads.persistenceIds(); }

  /** End the hanging appends so their closures are collectable. */
  settleAll(): void {
    const parked = this.pending.splice(0, this.pending.length);
    for (const reject of parked) reject(new Error('test teardown'));
  }
}

/** A snapshot store whose reads always throw — the store is simply gone. */
export class UnreachableSnapshotStore implements SnapshotStore {
  async save<S>(): Promise<Snapshot<S>> { throw new Error('snapshot store is unreachable'); }
  async loadLatest<S>(): Promise<Option<Snapshot<S>>> { throw new Error('snapshot store is unreachable'); }
  async loadBefore<S>(): Promise<Option<Snapshot<S>>> { throw new Error('snapshot store is unreachable'); }
  async delete(): Promise<void> {}
}
