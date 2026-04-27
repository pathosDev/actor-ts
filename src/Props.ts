import type { Actor } from './Actor.js';
import type { Dispatcher } from './Dispatcher.js';
import type { Mailbox } from './internal/Mailbox.js';
import type { SupervisorStrategy } from './Supervision.js';

export type ActorFactory<TMsg> = () => Actor<TMsg>;
export type MailboxFactory<TMsg> = () => Mailbox<TMsg>;

export interface PropsConfig<TMsg> {
  readonly factory: ActorFactory<TMsg>;
  readonly supervisorStrategy?: SupervisorStrategy;
  readonly dispatcher?: Dispatcher;
  readonly mailboxCapacity?: number;
  /**
   * Custom mailbox factory — use `BoundedMailbox` or `PriorityMailbox` for
   * non-default queueing.  When omitted the default `Mailbox` is used.
   */
  readonly mailbox?: MailboxFactory<TMsg>;
}

/**
 * Immutable configuration describing how to create an actor.
 * Use `Props.create(() => new MyActor(...))` and chain `with…` for
 * additional configuration.
 */
export class Props<TMsg = unknown> {
  constructor(public readonly config: PropsConfig<TMsg>) {}

  static create<TMsg>(factory: ActorFactory<TMsg>): Props<TMsg> {
    return new Props({ factory });
  }

  withSupervisorStrategy(strategy: SupervisorStrategy): Props<TMsg> {
    return new Props({ ...this.config, supervisorStrategy: strategy });
  }

  withDispatcher(dispatcher: Dispatcher): Props<TMsg> {
    return new Props({ ...this.config, dispatcher });
  }

  withMailboxCapacity(capacity: number): Props<TMsg> {
    return new Props({ ...this.config, mailboxCapacity: capacity });
  }

  withMailbox(factory: MailboxFactory<TMsg>): Props<TMsg> {
    return new Props({ ...this.config, mailbox: factory });
  }
}
