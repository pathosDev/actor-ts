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
 * not write a seventh variant with slightly different semantics.
 */
import type { Journal } from '../../src/persistence/Journal.js';
import type { JournalEntry, PersistentEvent } from '../../src/persistence/JournalTypes.js';

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
