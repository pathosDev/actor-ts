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

/** The user-guardian default keeps restarting children. */
export const userGuardianStrategy: SupervisorStrategy = defaultStrategy;

/** The system guardian stops failing children — system-level internals shouldn't restart themselves. */
export const systemGuardianStrategy: SupervisorStrategy = new OneForOneStrategy(
  () => Directive.Stop,
);
