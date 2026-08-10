import { Actor, type ActorClassOrFactory, type ActorFactory } from './Actor.js';
import type { ActorOptions } from './ActorOptions.js';
import type { ActorRef, OmitReplyTo } from './ActorRef.js';
import { metricsOf } from './metrics/MetricsExtension.js';
import {
  ScatterGatherOptionsValidator,
  type ScatterGatherOptions,
  type ScatterGatherOptionsType,
} from './ScatterGatherOptions.js';
import { AskTimeoutError, Terminated } from './SystemMessages.js';

/**
 * Fallback deadline for one scatter.  Deliberately the same 5 s
 * `ActorRef.ask` defaults to: the scatter *is* N asks, and a router that
 * silently outlived the ask it wraps would be the more surprising default.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * How a scatter ended — the `outcome` label on
 * `router_scatter_gather_resolved_total`.
 *
 * `timeout` and `all-failed` are split because they call for different
 * responses: the first says the routees are too slow for the configured
 * budget, the second that they are broken.  A caller cannot tell them apart
 * from the rejection type alone (both are an `AggregateError`), which is
 * exactly why the metric carries the distinction.
 */
type ScatterOutcome = 'first' | 'timeout' | 'all-failed' | 'stopped' | 'no-reply-target';

/**
 * One scatter still waiting on its routees.
 *
 * `settled` is a flag rather than "is it still in the router's `pending`
 * set" because both the promise chain and `postStop` can reach a scatter,
 * and the loser has to be a no-op rather than a second reply to the
 * caller.
 */
type PendingScatter = {
  readonly replyTo: ActorRef;
  readonly startedAtMs: number;
  settled: boolean;
};

/**
 * A routee's reply plus which routee produced it — `Promise.any` reports
 * only the value, and the winner's identity is what the router attributes
 * the reply to.
 */
type ScatterWinner = {
  readonly routee: ActorRef;
  readonly reply: unknown;
};

type ScatterGatherRouterConfig<TMessage> = {
  readonly size: number;
  readonly routee: ActorClassOrFactory<TMessage>;
  readonly routeeOptions: ActorOptions<TMessage> | undefined;
  readonly timeoutMs: number;
};

/**
 * Pool router that sends every message to **all** of its routees and
 * returns the **first** reply to the caller — Akka's
 * `ScatterGatherFirstCompletedPool`, and the "hedged request" pattern
 * generally.
 *
 * The point is tail latency, not throughput: N routees each do the whole
 * job, so the pool costs N times the work of a round-robin pool and buys
 * the *minimum* of N latencies instead of a random one.  That trade only
 * pays when the slow tail is much slower than the median — replica reads,
 * multi-index lookups, speculative execution — and is a straight N-fold
 * waste otherwise.
 *
 * ## Nothing is awaited in the handler
 *
 * The obvious implementation is an `async onReceive` around
 * `Promise.any(...)`, and it is wrong here: `ActorCell` awaits the handler
 * before dequeuing the next message, so a single stalled scatter would
 * hold the router's **whole mailbox** for the full timeout, and concurrent
 * asks would run one after another rather than in parallel.  So the fan-out
 * is fired and the handler returns immediately; the continuation replies
 * from outside the mailbox turn, the way `pipeTo` does — except that this
 * one tells the raw reply rather than wrapping it in `Success`/`Failure`,
 * because the caller's `ask` has to resolve with what the routee actually
 * sent.
 *
 * Doing it that way means the router is *not* single-threaded with respect
 * to its own in-flight scatters: the only mutable state a continuation
 * touches is the `pending` set and the scatter's own `settled` flag, and
 * every JavaScript runtime this framework targets runs those continuations
 * on the same thread as the handler.  There is no interleaving to guard
 * against, only re-entrancy — which `settled` covers.
 */
class ScatterGatherRouterActor<TMessage> extends Actor<TMessage> {
  private readonly routees: ActorRef<TMessage>[] = [];
  private readonly pending = new Set<PendingScatter>();

  constructor(private readonly config: ScatterGatherRouterConfig<TMessage>) { super(); }

  override preStart(): void {
    for (let i = 0; i < this.config.size; i++) {
      const routee = this.context.spawn(this.config.routee, `routee-${i + 1}`, this.config.routeeOptions);
      this.routees.push(routee);
      this.context.watch(routee);
    }
  }

  /**
   * Mirrors `RouterActor.onReceive`: a `Terminated` is delivered by the
   * system for a watched routee and is not part of the protocol callers
   * see, so it is peeled off here rather than widening the public message
   * type.  There is no `Broadcast` arm — this router already sends every
   * message to every routee, so the wrapper would mean nothing.
   */
  override onReceive(message: TMessage | Terminated): void {
    if (message instanceof Terminated) {
      this.onTerminated(message);
      return;
    }
    this.onScatter(message as TMessage);
  }

  /**
   * Prune a routee that has stopped — identity, not `equals`, for the same
   * reason `RouterActor` does: a restarted pool re-spawns routees at the
   * same addresses, so an address match would let a stale notification
   * remove the live routee that inherited the name.
   */
  private onTerminated(message: Terminated): void {
    const index = this.routees.indexOf(message.actor as ActorRef<TMessage>);
    if (index >= 0) this.routees.splice(index, 1);
  }

  /**
   * Fan the message out to every routee and arm the continuation.
   *
   * `routee.ask` synthesises its own reply ref and overwrites any
   * `replyTo` already on the message, so the caller's message can be
   * forwarded unchanged — the routee's reply comes back here rather than
   * going straight to the caller, which is what lets the router pick a
   * winner at all.
   *
   * `Promise.any`, not `Promise.race`: a routee that fails *fast* must not
   * decide the scatter.  First **fulfilment** wins; the scatter fails only
   * when every routee has failed, and then with an `AggregateError`
   * carrying all of them.
   */
  private onScatter(message: TMessage): void {
    const replyTo = this.sender.toNullable();
    if (replyTo === null) {
      this.onScatterWithoutReplyTarget();
      return;
    }
    const scatter: PendingScatter = { replyTo, startedAtMs: performance.now(), settled: false };
    this.pending.add(scatter);
    const attempts = this.routees.map((routee) =>
      routee
        .ask<unknown>(message as OmitReplyTo<TMessage>, this.config.timeoutMs)
        .then((reply): ScatterWinner => ({ routee, reply })),
    );
    if (attempts.length === 0) {
      this.settle(scatter, 'all-failed', emptyPool(this.self.path.toString()));
      return;
    }
    void Promise.any(attempts).then(
      (winner) => this.onFirstReply(scatter, winner),
      (rejection: unknown) => this.onEveryRouteeFailed(scatter, rejection),
    );
  }

  /**
   * A `tell` with no sender has nowhere to return a reply to, and a
   * scatter whose result is discarded is N times the work for nothing —
   * so nothing is sent.
   *
   * Warn rather than throw: throwing would fail the router through
   * supervision, and a restart drops every *other* in-flight scatter with
   * it.  One caller's mistake taking down the pool's live traffic is a far
   * worse failure mode than a log line, and the existing routers do not
   * throw on a routing decision either.
   */
  private onScatterWithoutReplyTarget(): void {
    this.record('no-reply-target', null);
    this.log.warn(
      `Scatter/gather router ${this.self.path} dropped a message sent with no reply target. `
      + 'The router answers with the first routee reply, so it needs somewhere to send it: '
      + 'use `router.ask(message)`, or `router.tell(message, replyToRef)`.',
    );
  }

  /**
   * Attribute the reply to the routee that produced it, not to the router.
   * A caller reading `this.sender` then sees exactly what it would have
   * seen asking that routee directly — the same "a routee is
   * indistinguishable from a non-routed actor" property the other routers
   * keep on the forward path — and for hedged reads it answers the
   * question the pattern raises: which replica won.
   */
  private onFirstReply(scatter: PendingScatter, winner: ScatterWinner): void {
    this.settle(scatter, 'first', winner.reply, winner.routee);
  }

  /**
   * Every routee failed.  `AggregateError.errors` already holds one error
   * per routee in scatter order, so the router only re-labels the failure:
   * an all-timeout scatter is a budget problem, a mixed one is a routee
   * problem, and the message says which.  The rejection type stays
   * `AggregateError` either way — a caller that has to branch on the error
   * *type* to find out how many routees failed learns nothing the `errors`
   * array does not already carry, and `AggregateError` survives the
   * cluster wire (see `JsonTree`).
   */
  private onEveryRouteeFailed(scatter: PendingScatter, rejection: unknown): void {
    const errors: ReadonlyArray<unknown> = rejection instanceof AggregateError
      ? rejection.errors
      : [rejection];
    const timedOut = errors.length > 0 && errors.every((e) => e instanceof AskTimeoutError);
    const path = this.self.path.toString();
    if (timedOut) {
      this.settle(scatter, 'timeout', everyRouteeTimedOut(path, this.config.timeoutMs, errors));
      return;
    }
    this.settle(scatter, 'all-failed', everyRouteeFailed(path, errors));
  }

  /**
   * Fail every scatter that is still open instead of leaving its caller to
   * discover the router is gone when the ask times out.
   *
   * The routees are already stopped by the time this runs, so their asks
   * would each burn the full `timeoutMs` before rejecting — a shutdown
   * that takes as long as the slowest configured deadline, for replies
   * that can no longer arrive.  `preRestart` defaults to `postStop`, so a
   * restarting router fails its in-flight scatters for the same reason:
   * the routees it asked are being torn down and re-spawned.
   */
  override postStop(): void {
    for (const scatter of Array.from(this.pending)) this.onRouterStopped(scatter);
  }

  private onRouterStopped(scatter: PendingScatter): void {
    this.settle(scatter, 'stopped', routerStopped(this.self.path.toString()));
  }

  /**
   * The single exit for a scatter: at most one reply per caller, one
   * metric sample per scatter, no lingering entry in `pending`.
   *
   * `AskResponseRef` already ignores everything after the first message,
   * but the reply target is not always one — `router.tell(message,
   * someActorRef)` hands back a real actor — so the guard lives here.
   */
  private settle(
    scatter: PendingScatter,
    outcome: ScatterOutcome,
    reply: unknown,
    from: ActorRef | null = null,
  ): void {
    if (scatter.settled) return;
    scatter.settled = true;
    this.pending.delete(scatter);
    this.record(outcome, (performance.now() - scatter.startedAtMs) / 1_000);
    scatter.replyTo.tell(reply, from ?? this.self);
  }

  /**
   * `outcome` is the only label: the number of scatter/gather routers in a
   * system is bounded by code, but a per-router label would still multiply
   * a per-message family for a distinction the actor path in the logs
   * already makes.  `latencySeconds` is `null` for an outcome where no
   * scatter ran, so the histogram stays a distribution of real fan-outs.
   */
  private record(outcome: ScatterOutcome, latencySeconds: number | null): void {
    const metrics = metricsOf(this.system);
    metrics.counter(
      'router_scatter_gather_resolved_total', { outcome },
      { help: 'Cumulative count of scatter/gather fan-outs by how they ended.' },
    ).inc();
    if (latencySeconds === null) return;
    metrics.histogram(
      'router_scatter_gather_latency_seconds', {},
      { help: 'Time from scattering a message to answering the caller, in seconds.' },
    ).observe(latencySeconds);
  }
}

/** Nothing left to ask: every routee has stopped and none was re-spawned. */
function emptyPool(routerPath: string): AggregateError {
  return new AggregateError(
    [],
    `Scatter/gather router ${routerPath} has no routees left to scatter to`,
  );
}

function everyRouteeTimedOut(
  routerPath: string,
  timeoutMs: number,
  errors: ReadonlyArray<unknown>,
): AggregateError {
  return new AggregateError(
    errors,
    `Scatter/gather router ${routerPath}: none of ${errors.length} routees replied within ${timeoutMs}ms`,
  );
}

function everyRouteeFailed(routerPath: string, errors: ReadonlyArray<unknown>): AggregateError {
  return new AggregateError(
    errors,
    `Scatter/gather router ${routerPath}: all ${errors.length} routees failed`,
  );
}

function routerStopped(routerPath: string): AggregateError {
  return new AggregateError(
    [],
    `Scatter/gather router ${routerPath} stopped while the scatter was still open`,
  );
}

/**
 * @internal Builds the spawnable factory behind
 * `Router.scatterGatherFirstCompleted(...)`, which is the public entry
 * point and owns the pool-size guard.
 *
 * The options are resolved and validated **here**, not inside the actor:
 * the factory runs at the `Router.scatterGatherFirstCompleted(...)` call
 * site, so a rejected `timeoutMs` throws where the stack still points at
 * the caller — the same reason `assertPoolSize` is not deferred into
 * `preStart`.  Validating in the constructor would also re-run on every
 * restart, for settings that cannot have changed.
 */
export function scatterGatherRouterFactory<TMessage>(
  size: number,
  routee: ActorClassOrFactory<TMessage>,
  options: ScatterGatherOptions | undefined,
  routeeOptions: ActorOptions<TMessage> | undefined,
): ActorFactory<TMessage> {
  const explicit = (options ?? {}) as Partial<ScatterGatherOptionsType>;
  const settings: Required<ScatterGatherOptionsType> = {
    timeoutMs: explicit.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  new ScatterGatherOptionsValidator().validate(settings);
  const config: ScatterGatherRouterConfig<TMessage> = {
    size,
    routee,
    routeeOptions,
    timeoutMs: settings.timeoutMs,
  };
  return () => new ScatterGatherRouterActor<TMessage>(config);
}
