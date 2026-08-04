import type { Actor } from './Actor.js';
import type { Dispatcher } from './Dispatcher.js';
import type { EntityContext } from './EntityContext.js';
import type { Mailbox } from './internal/Mailbox.js';
import type { SupervisorStrategy } from './Supervision.js';

export type ActorFactory<TMessage> = () => Actor<TMessage>;
export type MailboxFactory<TMessage> = () => Mailbox<TMessage>;

export type PropsConfig<TMessage> = {
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

  /**
   * Human-readable name for logs and the DevTools tree —
   * see {@link Props.withDisplayName}.
   */
  readonly displayName?: string;

  /**
   * Spawn this actor as a sharded entity with the given identity —
   * see {@link Props.withEntity}.
   */
  readonly entity?: EntityContext;
};

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

  /**
   * Name this actor in log lines and in the DevTools tree (#891) —
   * the spawn-site counterpart to overriding `Actor.displayName()`, for
   * a framework-constructed actor with no subclass of your own: a
   * `Behaviors` actor, a sharded entity, a singleton.
   *
   *     const props = typedProps(counter(0)).withDisplayName('counter');
   *
   * Outranks the method, exactly as `withSupervisorStrategy` outranks
   * `Actor.supervisorStrategy()`.  Purely cosmetic — the path stays the
   * identity everywhere that routes or correlates.
   */
  withDisplayName(name: string): Props<TMessage> {
    return new Props({ ...this.config, displayName: name });
  }

  /**
   * Spawn this actor as a sharded entity, so it can read its own identity
   * back off `this.entityId` / `this.context.entity`.
   *
   * `ClusterSharding` calls this itself for every entity a shard creates.
   * It is public for the test bench: an entity that derives its
   * `persistenceId` from `this.entityId` is otherwise unspawnable without a
   * cluster standing behind it.
   */
  withEntity(entity: EntityContext): Props<TMessage> {
    return new Props({ ...this.config, entity });
  }
}
