import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { FAULT_POINTS, type FaultPoint } from './internal/FaultScript.js';

/** The `SnapshotStore` operations a `FaultInjectingSnapshotStore` can be scripted to fail. */
export type SnapshotStoreOperation = 'save' | 'loadLatest' | 'loadBefore' | 'delete';

const SNAPSHOT_STORE_OPERATIONS: ReadonlyArray<SnapshotStoreOperation> = ['save', 'loadLatest', 'loadBefore', 'delete'];

/** Plain options-object shape accepted by a `FaultInjectingSnapshotStore`. */
export type FaultInjectingSnapshotStoreOptionsType = {
  /**
   * The operations that may fail.  Unset or empty: none do, and the store
   * behaves exactly as the one it wraps.
   */
  readonly failOn?: ReadonlyArray<SnapshotStoreOperation>;
  /**
   * How many calls to an operation in {@link failOn} succeed before the
   * failures begin, counted across all of them together.  Default 0.
   */
  readonly failAfterCalls?: number;
  /** Fail one call and then pass every later one through.  Default `false`. */
  readonly failOnce?: boolean;
  /**
   * Build the error a failing call rejects with.  Default: an
   * `InjectedFaultError` naming the operation and the call number.
   */
  readonly error?: (operation: SnapshotStoreOperation) => Error;
  /**
   * Whether a failing call reaches the wrapped store first.  Default
   * `'before-operation'`.  `'after-operation'` saves the snapshot and then
   * rejects — a write that landed and whose answer was lost.
   */
  readonly failurePoint?: FaultPoint;
};

/** Fluent builder for {@link FaultInjectingSnapshotStoreOptionsType}. */
export class FaultInjectingSnapshotStoreOptionsBuilder extends OptionsBuilder<FaultInjectingSnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new FaultInjectingSnapshotStoreOptionsBuilder()`. */
  static create(): FaultInjectingSnapshotStoreOptionsBuilder {
    return new FaultInjectingSnapshotStoreOptionsBuilder();
  }

  /** The operations that may fail.  Default: none. */
  withFailOn(...failOn: SnapshotStoreOperation[]): this {
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
  withError(error: (operation: SnapshotStoreOperation) => Error): this {
    return this.set('error', error);
  }

  /** Whether a failing call reaches the wrapped store first.  Default `'before-operation'`. */
  withFailurePoint(failurePoint: FaultPoint): this {
    return this.set('failurePoint', failurePoint);
  }
}

/** Bounds on the script — see `FaultInjectingJournalOptionsValidator` for why names are checked. */
export class FaultInjectingSnapshotStoreOptionsValidator
  extends OptionsValidator<FaultInjectingSnapshotStoreOptionsType> {
  constructor() {
    super('FaultInjectingSnapshotStoreOptions');
  }

  protected rules(settings: Partial<FaultInjectingSnapshotStoreOptionsType>): void {
    this.nonNegativeInt('failAfterCalls');
    this.oneOf('failurePoint', FAULT_POINTS);
    for (const operation of settings.failOn ?? []) {
      if (!SNAPSHOT_STORE_OPERATIONS.includes(operation)) {
        this.fail(
          'failOn',
          `must name snapshot-store operations — one of ${SNAPSHOT_STORE_OPERATIONS.join(', ')}`,
          operation,
        );
      }
    }
  }
}

/**
 * Accepted input for a `FaultInjectingSnapshotStore`: the fluent
 * {@link FaultInjectingSnapshotStoreOptionsBuilder} OR a plain
 * {@link FaultInjectingSnapshotStoreOptionsType}.
 */
export type FaultInjectingSnapshotStoreOptions =
  | FaultInjectingSnapshotStoreOptionsBuilder
  | FaultInjectingSnapshotStoreOptionsType;
/** Value alias so `FaultInjectingSnapshotStoreOptions.create()` resolves to the builder. */
export const FaultInjectingSnapshotStoreOptions = FaultInjectingSnapshotStoreOptionsBuilder;
