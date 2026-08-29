/** Supervisor directives decide what happens to a failing child actor. */
export enum Directive {
  /** Ignore the failure and keep the actor state; resume message processing. */
  Resume = 'resume',
  /** Destroy and recreate the actor, losing its state. */
  Restart = 'restart',
  /** Stop the failing actor permanently. */
  Stop = 'stop',
  /** Escalate the failure to the supervisor's own supervisor. */
  Escalate = 'escalate',
}

export type Decider = (error: Error) => Directive;

/** Descriptor for a supervision strategy. */
export type SupervisorStrategy = {
  readonly scope: 'one-for-one' | 'all-for-one';
  readonly decider: Decider;
  /** Maximum number of restarts tolerated within the time window. -1 = unlimited. */
  readonly maxRetries: number;
  /** Sliding time window in ms. 0 = no window (counts are never reset). */
  readonly withinTimeRangeMs: number;
};

export type StrategyOptions = {
  maxRetries?: number;
  withinTimeRangeMs?: number;
};

/** Applies the directive only to the failing child. */
export class OneForOneStrategy implements SupervisorStrategy {
  readonly scope = 'one-for-one' as const;
  readonly maxRetries: number;
  readonly withinTimeRangeMs: number;
  constructor(public readonly decider: Decider, options: StrategyOptions = {}) {
    this.maxRetries = options.maxRetries ?? -1;
    this.withinTimeRangeMs = options.withinTimeRangeMs ?? 0;
  }
}

/** Applies the directive to every child when any one fails. */
export class AllForOneStrategy implements SupervisorStrategy {
  readonly scope = 'all-for-one' as const;
  readonly maxRetries: number;
  readonly withinTimeRangeMs: number;
  constructor(public readonly decider: Decider, options: StrategyOptions = {}) {
    this.maxRetries = options.maxRetries ?? -1;
    this.withinTimeRangeMs = options.withinTimeRangeMs ?? 0;
  }
}

/**
 * Sliding-window restart tally for one supervision scope.
 *
 * Kept apart from {@link SupervisorStrategy} on purpose: a strategy is a
 * *description* — immutable, and shared by design, since `defaultStrategy` is
 * a module-level singleton handed to every actor that does not override it.
 * A counter living on the strategy would therefore make the whole process
 * share one allowance.  The tally belongs to whoever is doing the supervising,
 * so each supervisor owns its own budget over a strategy it merely reads.
 *
 * `maxRetries` is read literally: **`maxRetries` restarts are granted**, and
 * the attempt that would be number `maxRetries + 1` is refused.  Only granted
 * restarts are recorded, which is what makes `maxRetries: 0` mean "never
 * restart" rather than "restart once".
 *
 * The array is bounded by `maxRetries` for the same reason — once the budget
 * is full nothing more is pushed — so it cannot grow for the lifetime of the
 * process even with `withinTimeRangeMs: 0`, where no pruning ever happens.
 *
 * `now` is injectable so the window can be exercised without sleeping: the
 * only alternative is a real `withinTimeRangeMs` wait per assertion, which is
 * both slow and the classic source of a timing-flaky suite.
 */
export class RestartBudget {
  private failureTimes: number[] = [];

  constructor(
    /**
     * Only the two allowance fields are read, and the parameter says so: the
     * worker mesh budgets its slot respawns through this class (#734) and has
     * neither an actor to apply a `Directive` to nor a supervision scope to
     * name, so requiring a whole `SupervisorStrategy` would only have it
     * fabricate both.  A `SupervisorStrategy` still satisfies it.
     */
    private readonly strategy: Pick<SupervisorStrategy, 'maxRetries' | 'withinTimeRangeMs'>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Ask for one restart: `true` when it is granted and recorded, `false` when
   * the budget is spent and the caller has to do something other than restart.
   *
   * An unlimited strategy (`maxRetries < 0`) answers before touching the
   * array, so the common case costs nothing and records nothing.
   */
  registerRestart(): boolean {
    if (this.strategy.maxRetries < 0) return true;
    const now = this.now();
    if (this.strategy.withinTimeRangeMs > 0) {
      const threshold = now - this.strategy.withinTimeRangeMs;
      this.failureTimes = this.failureTimes.filter((timestamp) => timestamp >= threshold);
    }
    if (this.failureTimes.length >= this.strategy.maxRetries) return false;
    this.failureTimes.push(now);
    return true;
  }

  /** How many restarts are currently on record — for diagnostics and tests. */
  get recordedRestarts(): number { return this.failureTimes.length; }
}

/** Default: restart failing child, up to 10 times per minute. */
export const defaultStrategy: SupervisorStrategy = new OneForOneStrategy(
  () => Directive.Restart,
  { maxRetries: 10, withinTimeRangeMs: 60_000 },
);

/** Always stop failing children. Useful for "let it crash" setups where a parent replaces children lazily. */
export const stoppingStrategy: SupervisorStrategy = new OneForOneStrategy(
  () => Directive.Stop,
);

/** Always escalate. */
export const escalatingStrategy: SupervisorStrategy = new OneForOneStrategy(
  () => Directive.Escalate,
);

/**
 * Build a decider from a list of {errorType, directive} mappings, falling back
 * to a configurable default.
 */
export function decideBy(
  cases: Array<{ match: new (...args: any[]) => Error; then: Directive }>,
  fallback: Directive = Directive.Restart,
): Decider {
  return (err: Error): Directive => {
    for (const matcher of cases) {
      if (err instanceof matcher.match) return matcher.then;
    }
    return fallback;
  };
}

/* -------------------------- Standard error types -------------------------- */

/** Raised when preStart / actor construction fails. */
export class ActorInitializationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ActorInitializationError';
  }
}

/**
 * Death-pact failure: a watcher decides it cannot carry on without the actor
 * whose `Terminated` it just received.
 *
 * **The runtime never raises this.**  It is exported for an application to
 * `throw` deliberately from its own `Terminated` handler, from where it
 * travels through supervision like any other failure — so pair it with a
 * decider that stops or escalates, or the default strategy will simply
 * restart the watcher.
 *
 * Ignoring a `Terminated` is not a failure here, and that is deliberate
 * rather than an oversight: `Actor.onReceive` returns `void`, so the cell
 * that dispatched the signal has no return channel telling it whether the
 * handler acted on it.  There is nothing to hang an automatic pact on until
 * a dedicated termination hook exists (see #662), and adding one would turn
 * today's no-op into a supervision fault for every actor that watches and
 * ignores.
 */
export class DeathPactError extends Error {
  constructor(public readonly actorPath: string) {
    super(`Death pact with terminated actor ${actorPath}`);
    this.name = 'DeathPactError';
  }
}
