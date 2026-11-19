import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { FAULT_POINTS, type FaultPoint } from './internal/FaultScript.js';

/** The `Journal` operations a `FaultInjectingJournal` can be scripted to fail. */
export type JournalOperation = 'append' | 'read' | 'highestSeq' | 'delete';

const JOURNAL_OPERATIONS: ReadonlyArray<JournalOperation> = ['append', 'read', 'highestSeq', 'delete'];

/** Plain options-object shape accepted by a `FaultInjectingJournal`. */
export type FaultInjectingJournalOptionsType = {
  /**
   * The operations that may fail.  Unset or empty: none do, and the journal
   * behaves exactly as the one it wraps (apart from {@link gapAfterSeq}).
   */
  readonly failOn?: ReadonlyArray<JournalOperation>;
  /**
   * How many calls to an operation in {@link failOn} succeed before the
   * failures begin.  Default 0 — the first such call fails.
   *
   * Counted across every operation in `failOn` together, so "the second read
   * of a recovery" is `failOn: ['read'], failAfterCalls: 1`.
   */
  readonly failAfterCalls?: number;
  /**
   * Fail one call and then pass every later one through.  Default `false` —
   * every scripted call after {@link failAfterCalls} fails.
   *
   * The transient fault: the shape that tells a restart which recovers from
   * one which loops.
   */
  readonly failOnce?: boolean;
  /**
   * Build the error a failing call rejects with.  Default: an
   * `InjectedFaultError` naming the operation and the call number.
   */
  readonly error?: (operation: JournalOperation) => Error;
  /**
   * Whether a failing call reaches the wrapped journal first.  Default
   * `'before-operation'` — it does not.  `'after-operation'` performs the
   * call and then rejects: an append that committed and whose answer was
   * lost.
   */
  readonly failurePoint?: FaultPoint;
  /**
   * Leave the event at `gapAfterSeq + 1` out of every `read` result, so a
   * stream of 1, 2, 3, 4 reads back as 1, 2, 4 with `gapAfterSeq: 2`.
   *
   * The row is left where it is — `highestSeq` still reports the true head —
   * which is the shape of a store that lost a row, a manual repair, or a
   * batch applied partially: the history has a hole that nothing announced.
   */
  readonly gapAfterSeq?: number;
};

/** Fluent builder for {@link FaultInjectingJournalOptionsType}. */
export class FaultInjectingJournalOptionsBuilder extends OptionsBuilder<FaultInjectingJournalOptionsType> {
  /** Start a fresh builder.  Equivalent to `new FaultInjectingJournalOptionsBuilder()`. */
  static create(): FaultInjectingJournalOptionsBuilder {
    return new FaultInjectingJournalOptionsBuilder();
  }

  /** The operations that may fail.  Default: none. */
  withFailOn(...failOn: JournalOperation[]): this {
    return this.set('failOn', failOn);
  }

  /** Scripted calls that succeed before the failures begin.  Default 0. */
  withFailAfterCalls(failAfterCalls: number): this {
    return this.set('failAfterCalls', failAfterCalls);
  }

  /** Fail one call, then pass every later one through.  Default `false`. */
  withFailOnce(failOnce = true): this {
    return this.set('failOnce', failOnce);
  }

  /** Build the error a failing call rejects with.  Default `InjectedFaultError`. */
  withError(error: (operation: JournalOperation) => Error): this {
    return this.set('error', error);
  }

  /** Whether a failing call reaches the wrapped journal first.  Default `'before-operation'`. */
  withFailurePoint(failurePoint: FaultPoint): this {
    return this.set('failurePoint', failurePoint);
  }

  /** Leave the event at `gapAfterSeq + 1` out of every `read` result. */
  withGapAfterSeq(gapAfterSeq: number): this {
    return this.set('gapAfterSeq', gapAfterSeq);
  }
}

/**
 * Bounds on the script.  An operation name the journal does not have would
 * otherwise script nothing, and a test asserting a failure path would pass
 * against a store that never failed.
 */
export class FaultInjectingJournalOptionsValidator extends OptionsValidator<FaultInjectingJournalOptionsType> {
  constructor() {
    super('FaultInjectingJournalOptions');
  }

  protected rules(settings: Partial<FaultInjectingJournalOptionsType>): void {
    this.nonNegativeInt('failAfterCalls');
    this.nonNegativeInt('gapAfterSeq');
    this.oneOf('failurePoint', FAULT_POINTS);
    for (const operation of settings.failOn ?? []) {
      if (!JOURNAL_OPERATIONS.includes(operation)) {
        this.fail('failOn', `must name journal operations — one of ${JOURNAL_OPERATIONS.join(', ')}`, operation);
      }
    }
  }
}

/**
 * Accepted input for a `FaultInjectingJournal`: the fluent
 * {@link FaultInjectingJournalOptionsBuilder} OR a plain
 * {@link FaultInjectingJournalOptionsType}.
 */
export type FaultInjectingJournalOptions = FaultInjectingJournalOptionsBuilder | FaultInjectingJournalOptionsType;
/** Value alias so `FaultInjectingJournalOptions.create()` resolves to the builder. */
export const FaultInjectingJournalOptions = FaultInjectingJournalOptionsBuilder;
