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
export interface SupervisorStrategy {
  readonly scope: 'one-for-one' | 'all-for-one';
  readonly decider: Decider;
  /** Maximum number of restarts tolerated within the time window. -1 = unlimited. */
  readonly maxRetries: number;
  /** Sliding time window in ms. 0 = no window (counts are never reset). */
  readonly withinTimeRangeMs: number;
}

export interface StrategyOptions {
  maxRetries?: number;
  withinTimeRangeMs?: number;
}

/** Applies the directive only to the failing child. */
export class OneForOneStrategy implements SupervisorStrategy {
  readonly scope = 'one-for-one' as const;
  readonly maxRetries: number;
  readonly withinTimeRangeMs: number;
  constructor(public readonly decider: Decider, opts: StrategyOptions = {}) {
    this.maxRetries = opts.maxRetries ?? -1;
    this.withinTimeRangeMs = opts.withinTimeRangeMs ?? 0;
  }
}

/** Applies the directive to every child when any one fails. */
export class AllForOneStrategy implements SupervisorStrategy {
  readonly scope = 'all-for-one' as const;
  readonly maxRetries: number;
  readonly withinTimeRangeMs: number;
  constructor(public readonly decider: Decider, opts: StrategyOptions = {}) {
    this.maxRetries = opts.maxRetries ?? -1;
    this.withinTimeRangeMs = opts.withinTimeRangeMs ?? 0;
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

/** Raised when an actor explicitly watches another that terminates and does not handle Terminated. */
export class DeathPactError extends Error {
  constructor(public readonly actorPath: string) {
    super(`Death pact with terminated actor ${actorPath}`);
    this.name = 'DeathPactError';
  }
}
