import type { Actor } from './Actor.js';
import type { Dispatcher } from './Dispatcher.js';
import type { Mailbox } from './internal/Mailbox.js';
import type { SupervisorStrategy } from './Supervision.js';

export type ActorFactory<TMessage> = () => Actor<TMessage>;
export type MailboxFactory<TMessage> = () => Mailbox<TMessage>;

export interface PropsConfig<TMessage> {
  readonly factory: ActorFactory<TMessage>;
  readonly supervisorStrategy?: SupervisorStrategy;
  readonly dispatcher?: Dispatcher;
  readonly mailboxCapacity?: number;
  /**
   * Custom mailbox factory — use `BoundedMailbox` or `PriorityMailbox` for
   * non-default queueing.  When omitted the default `Mailbox` is used.
   */
  readonly mailbox?: MailboxFactory<TMessage>;
  /**
   * This actor belongs to the tooling, not to the application.
   *
   * Whole-system instrumentation skips it, which is what keeps a
   * debugger from observing itself: DevTools' own hub publishes the
   * spans it just recorded, so tracing it feeds its own output back in.
   * Children inherit the mark — a tooling actor's children are tooling.
   */
  readonly internal?: boolean;
}

/**
 * Immutable configuration describing how to create an actor.
 * Use `Props.create(() => new MyActor(...))` and chain `with…` for
 * additional configuration.
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

  /** Mark this actor as tooling — see {@link PropsConfig.internal}. */
  asInternal(): Props<TMessage> {
    return new Props({ ...this.config, internal: true });
  }
}
