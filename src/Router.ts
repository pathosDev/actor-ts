import { Actor } from './Actor.js';
import type { ActorRef } from './ActorRef.js';
import { Props } from './Props.js';
import { Terminated } from './SystemMessages.js';
import { OptionsError } from './util/OptionsValidator.js';

/** Message that tells a router to send the payload to every routee. */
export class Broadcast<T = unknown> {
  constructor(public readonly message: T) {}
}

/** Strategy that picks the next routee(s) for a message. */
export type RoutingStrategy = (
  routees: ReadonlyArray<ActorRef>,
  state: RouterState,
) => Iterable<ActorRef>;

export type RouterState = {
  readonly messageIndex: number;
};

/** Round-robin: one routee per message, cycling through the pool. */
export function roundRobinStrategy(): RoutingStrategy {
  return (routees, state) => {
    if (routees.length === 0) return [];
    return [routees[state.messageIndex % routees.length]];
  };
}

/** Random: one routee picked uniformly for each message. */
export function randomStrategy(): RoutingStrategy {
  return (routees) => {
    if (routees.length === 0) return [];
    return [routees[Math.floor(Math.random() * routees.length)]];
  };
}

/** Broadcast: every routee gets every message. */
export function broadcastStrategy(): RoutingStrategy {
  return (routees) => routees;
}

type RouterConfig<TMessage> = {
  size: number;
  routeeProps: Props<TMessage>;
  strategy: RoutingStrategy;
};

/**
 * The class contract stays the caller-facing union — nobody sends a router a
 * `Terminated`, the system does — while `onReceive` widens to accept it, the
 * way `BackoffSupervisor` and `ShardRegion` handle their own watch
 * notifications.
 */
class RouterActor<TMessage> extends Actor<TMessage | Broadcast<TMessage>> {
  private routees: ActorRef<TMessage>[] = [];
  private counter = 0;

  constructor(private readonly config: RouterConfig<TMessage>) { super(); }

  override async preStart(): Promise<void> {
    for (let i = 0; i < this.config.size; i++) {
      const routee = this.context.spawn(this.config.routeeProps, `routee-${i + 1}`);
      this.routees.push(routee as ActorRef<TMessage>);
      this.context.watch(routee);
    }
  }

  override onReceive(message: TMessage | Broadcast<TMessage> | Terminated): void {
    if (message instanceof Terminated) {
      this.onTerminated(message);
      return;
    }
    if (message instanceof Broadcast) {
      this.onBroadcast(message);
      return;
    }
    this.onRoutedMessage(message as TMessage);
  }

  /**
   * Prune a routee that has stopped.
   *
   * `preStart` has always watched every routee, so this notification was
   * already arriving — nothing consumed it.  The pool therefore kept the dead
   * reference and the strategy kept choosing it, sending its share of the
   * traffic silently to dead letters: 1/N under round-robin, and one lost
   * message per `Broadcast`.
   *
   * The unconsumed notification itself was harmless — it fell through to the
   * routing path and was forwarded to some routee, but `ActorCell` only
   * delivers a `Terminated` to an actor that is actually watching the subject,
   * so a routee never saw its sibling's.
   */
  private onTerminated(message: Terminated): void {
    const index = this.routees.findIndex(routee => routee.equals(message.actor));
    if (index >= 0) this.routees.splice(index, 1);
  }

  private onBroadcast(message: Broadcast<TMessage>): void {
    const senderRef = this.sender.toNullable();
    for (const routee of this.routees) routee.tell(message.message, senderRef);
  }

  private onRoutedMessage(message: TMessage): void {
    const senderRef = this.sender.toNullable();
    const targets = this.config.strategy(this.routees, { messageIndex: this.counter++ });
    for (const target of targets) target.tell(message, senderRef);
  }
}

/**
 * Reject a pool size that cannot produce a working router.
 *
 * `preStart` spawns `size` routees in a counting loop, so a non-positive size
 * silently yielded an empty pool: every strategy returns `[]` for it, and each
 * message was dropped to dead letters with nothing reported.  A router that
 * routes nothing is never what the caller meant, so this fails at construction
 * instead — where the stack still points at the offending call.
 */
function assertPoolSize(size: number): void {
  if (!Number.isInteger(size) || size < 1) {
    throw new OptionsError(
      `Router: size must be an integer >= 1 (got ${size})`,
      'Router',
      'size',
      size,
    );
  }
}

/**
 * Shared by all four factories, so the size guard cannot be forgotten by a
 * fifth.
 *
 * The cast is needed because `Props.create` infers the message type from
 * `onReceive`, which accepts the `Terminated` the system delivers for a watched
 * routee.  That is not part of the router's public protocol — callers send
 * `TMessage` or a `Broadcast` — so it is kept out of the type they see.
 */
function routerProps<TMessage>(config: RouterConfig<TMessage>): Props<TMessage | Broadcast<TMessage>> {
  assertPoolSize(config.size);
  return Props.create(() => new RouterActor<TMessage>(config)) as Props<TMessage | Broadcast<TMessage>>;
}

/**
 * Helpers that return ready-to-spawn Props for pool-style routers.
 * Example:
 *   const pool = system.spawnAnonymous(Router.roundRobin(5, Props.create(() => new Worker())));
 *   pool.tell('work');
 *   pool.tell(new Broadcast('announce'));
 */
export const Router = {
  roundRobin<TMessage>(size: number, routeeProps: Props<TMessage>): Props<TMessage | Broadcast<TMessage>> {
    return routerProps({ size, routeeProps, strategy: roundRobinStrategy() });
  },

  random<TMessage>(size: number, routeeProps: Props<TMessage>): Props<TMessage | Broadcast<TMessage>> {
    return routerProps({ size, routeeProps, strategy: randomStrategy() });
  },

  broadcast<TMessage>(size: number, routeeProps: Props<TMessage>): Props<TMessage | Broadcast<TMessage>> {
    return routerProps({ size, routeeProps, strategy: broadcastStrategy() });
  },

  custom<TMessage>(size: number, routeeProps: Props<TMessage>, strategy: RoutingStrategy): Props<TMessage | Broadcast<TMessage>> {
    return routerProps({ size, routeeProps, strategy });
  },
};
