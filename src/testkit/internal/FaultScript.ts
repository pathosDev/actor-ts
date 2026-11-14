/**
 * The scripting half shared by `FaultInjectingJournal` and
 * `FaultInjectingSnapshotStore` (#1024): which calls fail, how often, and on
 * which side of the wrapped operation.
 *
 * One implementation for both decorators so "the third scripted call fails,
 * once" means the same thing against a journal and a snapshot store — a test
 * that scripts both at once must not have to learn two counting rules.
 */

/**
 * Which side of the wrapped call a scripted failure lands on.
 *
 * - `'before-operation'` — the store is never reached.  The write did not
 *   happen and the caller is told so: the plain refusal.
 * - `'after-operation'` — the store performs the call and the caller is told
 *   it failed anyway.  This is the lost acknowledgement — a timeout after the
 *   commit, a connection dropped between the write and its answer — and it is
 *   the case that tells a store which retries safely from one that does not.
 */
export type FaultPoint = 'before-operation' | 'after-operation';

/** Every point a scripted failure can land on, for the validators. */
export const FAULT_POINTS: ReadonlyArray<FaultPoint> = ['before-operation', 'after-operation'];

/**
 * The error a fault-injecting store throws when the test supplied no
 * `withError` factory.
 *
 * A class of its own so a test can tell the failure it scripted from one the
 * framework produced on its way — `instanceof InjectedFaultError` is the
 * difference between "supervision saw my fault" and "supervision saw
 * something".
 */
export class InjectedFaultError extends Error {
  constructor(
    /** The store operation that was scripted to fail (`'append'`, `'save'`, …). */
    readonly operation: string,
    /** One-based count of calls to that operation, the failing one included. */
    readonly callNumber: number,
  ) {
    super(`[testkit] injected ${operation} failure (call ${callNumber})`);
    this.name = 'InjectedFaultError';
  }
}

/** What the script needs from either decorator's options. */
export type FaultScriptSettings<Operation extends string> = {
  readonly failOn?: ReadonlyArray<Operation>;
  readonly failAfterCalls?: number;
  readonly failOnce?: boolean;
  readonly error?: (operation: Operation) => Error;
  readonly failurePoint?: FaultPoint;
};

/**
 * Decides, call by call, whether a store operation fails.
 *
 * Deterministic by construction: the decision depends only on the count of
 * scripted calls made so far, never on a clock or a random draw — a
 * persistence failure test has to fail the same way on every run, or a red
 * run teaches nothing.
 */
export class FaultScript<Operation extends string> {
  private readonly calls = new Map<Operation, number>();
  private scriptedCalls = 0;
  private injected = 0;

  constructor(private readonly settings: FaultScriptSettings<Operation>) {}

  /** How many failures this script has injected so far. */
  get failuresInjected(): number { return this.injected; }

  /** How many times `operation` was called, failing calls included. */
  callsTo(operation: Operation): number { return this.calls.get(operation) ?? 0; }

  /**
   * Run `call` as `operation`, failing it if the script says so.
   *
   * The count that `failAfterCalls` reads is shared across every operation
   * in `failOn`: `failOn('read', 'highestSeq')` with `failAfterCalls(2)` lets
   * the first two of those calls through, whichever they were, and fails the
   * third.  Operations outside `failOn` are counted by {@link callsTo} but
   * never advance the script.
   */
  async run<T>(operation: Operation, call: () => Promise<T>): Promise<T> {
    const callNumber = this.callsTo(operation) + 1;
    this.calls.set(operation, callNumber);
    if (!this.shouldFail(operation)) return call();
    this.injected++;
    if (this.settings.failurePoint === 'after-operation') await call();
    throw this.settings.error?.(operation) ?? new InjectedFaultError(operation, callNumber);
  }

  private shouldFail(operation: Operation): boolean {
    if (!(this.settings.failOn ?? []).includes(operation)) return false;
    this.scriptedCalls++;
    if (this.scriptedCalls <= (this.settings.failAfterCalls ?? 0)) return false;
    return !(this.settings.failOnce === true && this.injected > 0);
  }
}
