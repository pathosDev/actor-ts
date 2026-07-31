import { Actor } from '../Actor.js';
import {
  defaultStrategy,
  OneForOneStrategy,
  Directive,
  SupervisorStrategy,
} from '../Supervision.js';

/**
 * The guardian actors (root, user, system) are invisible to user code but
 * sit in the supervisor chain so that exceptions can always escalate to a
 * real policy rather than crashing the runtime.
 */
export class Guardian extends Actor<unknown> {
  constructor(private readonly _strategy: SupervisorStrategy = defaultStrategy) { super(); }

  override supervisorStrategy(): SupervisorStrategy { return this._strategy; }

  override async onReceive(_message: unknown): Promise<void> {
    // Guardians never receive user messages normally; drop silently.
  }
}

/** Name of the guardian that owns everything the application spawns. */
export const USER_GUARDIAN_NAME = 'user';

/** Name of the guardian that owns everything the framework spawns. */
export const SYSTEM_GUARDIAN_NAME = 'system';

/**
 * Order in which the root guardian stops its children — `/user` fully
 * drained before `/system` starts.
 *
 * The application talks to the framework, not the other way round, so
 * anything a user actor does on the way out (a `postStop` that unsubscribes
 * from the pub-sub mediator, hands a shard back, or writes a last event) needs
 * that framework actor to still be alive.  Stopping both at once — which is
 * what an ordinary actor does with its children, and what the root did before
 * — turns those into dead letters, non-deterministically.
 *
 * Derived from the names above so the order cannot drift from the guardians
 * that actually exist: a rename that missed this list would silently stop
 * ordering anything.
 */
export const GUARDIAN_SHUTDOWN_ORDER: ReadonlyArray<string> = [
  USER_GUARDIAN_NAME,
  SYSTEM_GUARDIAN_NAME,
];

/** The user-guardian default keeps restarting children. */
export const userGuardianStrategy: SupervisorStrategy = defaultStrategy;

/** The system guardian stops failing children — system-level internals shouldn't restart themselves. */
export const systemGuardianStrategy: SupervisorStrategy = new OneForOneStrategy(
  () => Directive.Stop,
);
