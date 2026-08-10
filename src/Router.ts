import { Actor, type ActorClassOrFactory, type ActorFactory } from './Actor.js';
import type { ActorOptions } from './ActorOptions.js';
import type { ActorRef } from './ActorRef.js';
import { LocalActorRef } from './internal/LocalActorRef.js';
import type { ScatterGatherOptions } from './ScatterGatherOptions.js';
import { scatterGatherRouterFactory } from './ScatterGatherRouter.js';
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

/**
 * Queued user messages for a routee, or `null` when the depth is unreadable.
 *
 * Only a locally-hosted actor has a mailbox this process can look into, and
 * the depth lives on the cell rather than on `ActorRef` on purpose — see
 * `ActorCell.mailboxSize`.  A pool router spawns its own children, so inside
 * `Router.smallestMailbox` this never returns `null`; the guard is here
 * because {@link smallestMailboxStrategy} is exported on its own and
 * `RoutingStrategy` is handed a plain `ActorRef`.
 */
function mailboxDepthOf(routee: ActorRef): number | null {
  return routee instanceof LocalActorRef ? routee.getCell().mailboxSize : null;
}

/**
 * Smallest mailbox: one routee per message, the one with the shortest queue.
 *
 * Balances by *backlog* instead of by message count, which is the thing
 * round-robin cannot do — one expensive message no longer parks the next
 * 1-in-N arrivals behind it, because a routee that is still working stops
 * being the shallowest and drops out of the running until it catches up.
 * The cost is a read of every routee's depth per message, so the pool size
 * is now a per-message factor; round-robin remains the cheaper default for
 * workloads whose per-message cost is roughly uniform.
 *
 * **Ties rotate.**  An idle pool has every depth at `0`, so a plain
 * "first minimum wins" scan would pin every message to `routee-1` whenever
 * the pool drains between arrivals.  Starting the scan at
 * `messageIndex % routees.length` and keeping the comparison strict (`<`)
 * makes an all-equal pool behave exactly like round-robin.
 *
 * That is also the answer for a **saturated** pool: when every bounded
 * mailbox sits at its capacity the depths are equal again, so the rotation
 * takes over and the overflow spreads evenly rather than piling onto one
 * routee.  The strategy has no notion of "full" and deliberately does not
 * grow one — refusing to route would invent back-pressure the caller never
 * configured, and what should happen to a message that does not fit is
 * already decided by the mailbox's own overflow policy (`drop-head` /
 * `drop-new` / `reject`).
 *
 * If no depth is readable at all the scan falls back to the rotation, so the
 * strategy still routes rather than dropping when it is used outside a local
 * pool.
 *
 * The scan stops at the first empty mailbox, which is what keeps the `O(N)`
 * worst case off the healthy path: a pool that is keeping up with its load
 * hits a zero on the first routee it looks at, so the common case is one read
 * regardless of pool size.  Only a pool that is genuinely behind pays for the
 * full sweep — and that is the pool the strategy exists for.
 */
export function smallestMailboxStrategy(): RoutingStrategy {
  return (routees, state) => {
    if (routees.length === 0) return [];
    const start = state.messageIndex % routees.length;
    let shallowest: ActorRef | null = null;
    let shallowestDepth = 0;
    for (let offset = 0; offset < routees.length; offset++) {
      const routee = routees[(start + offset) % routees.length];
      const depth = mailboxDepthOf(routee);
      if (depth === null) continue;
      if (shallowest === null || depth < shallowestDepth) {
        shallowest = routee;
        shallowestDepth = depth;
        // A depth is never negative, so nothing later in the scan could win
        // under the strict `<` above.  Breaking here is an optimisation, not
        // a behaviour change — the rotation already picked this routee.
        if (depth === 0) break;
      }
    }
    return [shallowest ?? routees[start]];
  };
}

type RouterConfig<TMessage> = {
  size: number;
  routee: ActorClassOrFactory<TMessage>;
  routeeOptions: ActorOptions<TMessage> | undefined;
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
      const routee = this.context.spawn(this.config.routee, `routee-${i + 1}`, this.config.routeeOptions);
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
    // Identity, not `equals`.  `ActorRef.equals` compares addresses, and a
    // restarted pool re-spawns its routees at exactly the same addresses — so
    // an address match lets the *previous* incarnation's notification, still
    // queued from before the restart, prune the live routee that now occupies
    // that name, leaving the pool silently empty.  The router owns the refs it
    // spawned, so the ref it was handed is the one that actually died.
    const index = this.routees.indexOf(message.actor as ActorRef<TMessage>);
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
 * Shared by the five strategy factories, so the size guard cannot be forgotten
 * by a sixth.  The guard runs *here* and not inside the returned closure: it has
 * always thrown at the `Router.roundRobin(...)` call that got the size wrong,
 * and deferring it into the factory would move the failure into `preStart`.
 *
 * The cast is needed because the router's `onReceive` accepts the `Terminated`
 * the system delivers for a watched routee.  That is not part of the router's
 * public protocol — callers send `TMessage` or a `Broadcast` — so it is kept
 * out of the type they see.
 */
function routerFactory<TMessage>(config: RouterConfig<TMessage>): ActorFactory<TMessage | Broadcast<TMessage>> {
  assertPoolSize(config.size);
  return () => new RouterActor<TMessage>(config) as unknown as Actor<TMessage | Broadcast<TMessage>>;
}

/**
 * Helpers that return a ready-to-spawn actor factory for pool-style routers.
 * Example:
 *   const pool = system.spawnAnonymous(Router.roundRobin(5, Worker));
 *   pool.tell('work');
 *   pool.tell(new Broadcast('announce'));
 *
 * The routee is given the same way any actor is — the class itself, or a
 * factory when it needs dependencies — with its own optional spawn options.
 */
export const Router = {
  roundRobin<TMessage>(size: number, routee: ActorClassOrFactory<TMessage>, routeeOptions?: ActorOptions<TMessage>): ActorFactory<TMessage | Broadcast<TMessage>> {
    return routerFactory({ size, routee, routeeOptions, strategy: roundRobinStrategy() });
  },

  random<TMessage>(size: number, routee: ActorClassOrFactory<TMessage>, routeeOptions?: ActorOptions<TMessage>): ActorFactory<TMessage | Broadcast<TMessage>> {
    return routerFactory({ size, routee, routeeOptions, strategy: randomStrategy() });
  },

  broadcast<TMessage>(size: number, routee: ActorClassOrFactory<TMessage>, routeeOptions?: ActorOptions<TMessage>): ActorFactory<TMessage | Broadcast<TMessage>> {
    return routerFactory({ size, routee, routeeOptions, strategy: broadcastStrategy() });
  },

  smallestMailbox<TMessage>(size: number, routee: ActorClassOrFactory<TMessage>, routeeOptions?: ActorOptions<TMessage>): ActorFactory<TMessage | Broadcast<TMessage>> {
    return routerFactory({ size, routee, routeeOptions, strategy: smallestMailboxStrategy() });
  },

  custom<TMessage>(size: number, routee: ActorClassOrFactory<TMessage>, strategy: RoutingStrategy, routeeOptions?: ActorOptions<TMessage>): ActorFactory<TMessage | Broadcast<TMessage>> {
    return routerFactory({ size, routee, routeeOptions, strategy });
  },

  /**
   * Send every message to **all** routees and answer the caller with the
   * **first** reply — Akka's `ScatterGatherFirstCompletedPool`, the hedged-request
   * pattern:
   *
   *     const hedgeOptions = ScatterGatherOptions.create().withTimeoutMs(250);
   *     const replicas = system.spawn(
   *       Router.scatterGatherFirstCompleted(3, Replica, hedgeOptions),
   *       'replicas',
   *     );
   *     const value = await replicas.ask<string>({ kind: 'read', key: 'a' });
   *
   * Unlike the five strategy factories this one is *reply-shaped*: the router
   * intercepts the routee replies to pick a winner, so it has to be asked (or
   * `tell`'d with an explicit sender).  It returns `ActorFactory<TMessage>`
   * rather than `ActorFactory<TMessage | Broadcast<TMessage>>` — a `Broadcast`
   * wrapper would mean nothing to a router that already broadcasts.
   *
   * The scatter/gather settings take the third argument and per-routee spawn
   * options move to the fourth, the same shape `Router.custom` already has:
   * the two configure different things — how the router behaves, and how each
   * routee is spawned — so folding them into one bag would make a single
   * argument mean two scopes.
   */
  scatterGatherFirstCompleted<TMessage>(size: number, routee: ActorClassOrFactory<TMessage>, options?: ScatterGatherOptions, routeeOptions?: ActorOptions<TMessage>): ActorFactory<TMessage> {
    assertPoolSize(size);
    return scatterGatherRouterFactory(size, routee, options, routeeOptions);
  },
};
