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

interface RouterConfig<TMsg> {
  size: number;
  routeeProps: Props<TMsg>;
  strategy: RoutingStrategy;
}

class RouterActor<TMsg> extends Actor<TMsg | Broadcast<TMsg>> {
  private routees: ActorRef<TMsg>[] = [];
  private counter = 0;

  constructor(private readonly cfg: RouterConfig<TMsg>) { super(); }

  override async preStart(): Promise<void> {
    for (let i = 0; i < this.cfg.size; i++) {
      const routee = this.context.spawn(this.cfg.routeeProps, `routee-${i + 1}`);
      this.routees.push(routee as ActorRef<TMsg>);
      this.context.watch(routee);
    }
  }

  override onReceive(message: TMsg | Broadcast<TMsg>): void {
    const senderRef = this.sender.toNullable();
    if (message instanceof Broadcast) {
      for (const r of this.routees) r.tell(message.message, senderRef);
      return;
    }
    const targets = this.cfg.strategy(this.routees, { messageIndex: this.counter++ });
    for (const t of targets) t.tell(message as TMsg, senderRef);
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
  roundRobin<TMsg>(size: number, routeeProps: Props<TMsg>): Props<TMsg | Broadcast<TMsg>> {
    return Props.create(() => new RouterActor<TMsg>({ size, routeeProps, strategy: roundRobinStrategy() }));
  },

  random<TMsg>(size: number, routeeProps: Props<TMsg>): Props<TMsg | Broadcast<TMsg>> {
    return Props.create(() => new RouterActor<TMsg>({ size, routeeProps, strategy: randomStrategy() }));
  },

  broadcast<TMsg>(size: number, routeeProps: Props<TMsg>): Props<TMsg | Broadcast<TMsg>> {
    return Props.create(() => new RouterActor<TMsg>({ size, routeeProps, strategy: broadcastStrategy() }));
  },

  custom<TMsg>(size: number, routeeProps: Props<TMsg>, strategy: RoutingStrategy): Props<TMsg | Broadcast<TMsg>> {
    return Props.create(() => new RouterActor<TMsg>({ size, routeeProps, strategy }));
  },
};
