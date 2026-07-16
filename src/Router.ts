import { Actor } from './Actor.js';
import type { ActorRef } from './ActorRef.js';
import { Props } from './Props.js';

/** Message that tells a router to send the payload to every routee. */
export class Broadcast<T = unknown> {
  constructor(public readonly message: T) {}
}

/** Strategy that picks the next routee(s) for a message. */
export type RoutingStrategy = (
  routees: ReadonlyArray<ActorRef>,
  state: RouterState,
) => Iterable<ActorRef>;

export interface RouterState {
  readonly messageIndex: number;
}

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

interface RouterConfig<TMessage> {
  size: number;
  routeeProps: Props<TMessage>;
  strategy: RoutingStrategy;
}

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

  override onReceive(message: TMessage | Broadcast<TMessage>): void {
    const senderRef = this.sender.toNullable();
    if (message instanceof Broadcast) {
      for (const routee of this.routees) routee.tell(message.message, senderRef);
      return;
    }
    const targets = this.config.strategy(this.routees, { messageIndex: this.counter++ });
    for (const target of targets) target.tell(message as TMessage, senderRef);
  }
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
    return Props.create(() => new RouterActor<TMessage>({ size, routeeProps, strategy: roundRobinStrategy() }));
  },

  random<TMessage>(size: number, routeeProps: Props<TMessage>): Props<TMessage | Broadcast<TMessage>> {
    return Props.create(() => new RouterActor<TMessage>({ size, routeeProps, strategy: randomStrategy() }));
  },

  broadcast<TMessage>(size: number, routeeProps: Props<TMessage>): Props<TMessage | Broadcast<TMessage>> {
    return Props.create(() => new RouterActor<TMessage>({ size, routeeProps, strategy: broadcastStrategy() }));
  },

  custom<TMessage>(size: number, routeeProps: Props<TMessage>, strategy: RoutingStrategy): Props<TMessage | Broadcast<TMessage>> {
    return Props.create(() => new RouterActor<TMessage>({ size, routeeProps, strategy }));
  },
};
