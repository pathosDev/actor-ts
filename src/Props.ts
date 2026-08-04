import type { ActorFactory } from './Actor.js';
import type { MailboxFactory } from './ActorOptions.js';
import type { EntityContext } from './EntityContext.js';
import type { Dispatcher } from './Dispatcher.js';
import type { ActorBlueprint } from './internal/ActorBlueprint.js';
import type { SupervisorStrategy } from './Supervision.js';

export type { ActorFactory, MailboxFactory };

/**
 * @deprecated Being removed — see #547.  Spawn with the actor class or a
 * factory and an optional `ActorOptions` instead:
 * `system.spawn(() => new Worker(db), 'w', workerOptions)`.
 *
 * Structurally identical to {@link ActorBlueprint}, which is what the cell
 * actually keeps; the alias is what lets both APIs coexist while the call
 * sites migrate.
 */
export type PropsConfig<TMessage> = ActorBlueprint<TMessage>;

/**
 * @deprecated Being removed — see #547.  `Props.create(() => new X())`
 * collapses to passing `X` (or `() => new X(deps)`) straight to `spawn`; the
 * `with…` builders move into a third `ActorOptions` argument.
 *
 * Immutable configuration describing how to create an actor.
 */
export class Props<TMessage = unknown> {
  constructor(public readonly config: PropsConfig<TMessage>) {}

  static create<TMessage>(factory: ActorFactory<TMessage>): Props<TMessage> {
    return new Props({ factory });
  }

  withSupervisorStrategy(strategy: SupervisorStrategy): Props<TMessage> {
    return new Props({ ...this.config, supervisorStrategy: strategy });
  }

  withDispatcher(dispatcher: Dispatcher): Props<TMessage> {
    return new Props({ ...this.config, dispatcher });
  }

  withMailboxCapacity(capacity: number): Props<TMessage> {
    return new Props({ ...this.config, mailboxCapacity: capacity });
  }

  withMailbox(factory: MailboxFactory<TMessage>): Props<TMessage> {
    return new Props({ ...this.config, mailbox: factory });
  }

  /** Mark this actor as tooling — see `ActorOptionsType.internal`. */
  asInternal(): Props<TMessage> {
    return new Props({ ...this.config, internal: true });
  }

  /** Spawn this actor as a sharded entity — see `ActorOptionsType.entity`. */
  withEntity(entity: EntityContext): Props<TMessage> {
    return new Props({ ...this.config, entity });
  }
}
