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
