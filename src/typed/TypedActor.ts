import { match } from 'ts-pattern';
import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import { Directive, RestartBudget } from '../Supervision.js';
import { DeadLetter, Terminated } from '../SystemMessages.js';
import { LocalActorRef } from '../internal/LocalActorRef.js';
import {
  StashOverflowError,
  type TimerScheduler,
} from '../ActorContext.js';
import { Behaviors } from './Behaviors.js';
import type {
  Behavior,
  BehaviorInterceptor,
  ReceiveBehavior,
  SameBehavior,
  StashBuffer,
  StoppedBehavior,
  SuperviseBehavior,
  Signal,
  UnhandledBehavior,
  EmptyBehavior,
  IgnoreBehavior,
} from './Behavior.js';
import type { TypedActorContext } from './TypedActorContext.js';

/**
 * The "resolved" shape a Behavior collapses to — setup/supervise/withTimers
 * wrappers are unwrapped into one of these leaf nodes.  `same` is never a
 * valid current value (it means "keep whatever we had"), so it's excluded.
 *
 * `intercept` is the one wrapper that is *not* collapsed: it has to run on
 * every message, so it stays in the resolved tree around its already-resolved
 * inner behavior.
 */
type ConcreteBehavior<T> =
  | ReceiveBehavior<T>
  | ConcreteInterceptBehavior<T>
  | StoppedBehavior
  | UnhandledBehavior
  | EmptyBehavior
  | IgnoreBehavior;

/**
 * An `InterceptBehavior` whose inner behavior is itself already resolved.
 * Structurally an `InterceptBehavior<T>`, but with the stronger `inner` type
 * the interpreter relies on to descend a nest of interceptors without
 * re-resolving on every message.
 */
type ConcreteInterceptBehavior<T> = {
  readonly kind: 'intercept';
  readonly inner: ConcreteBehavior<T>;
  readonly interceptor: BehaviorInterceptor<T>;
};

/** Kept for resolve()'s return when it does encounter a bare `same`. */
type ResolvedBehavior<T> = ConcreteBehavior<T> | SameBehavior;

/**
 * Runtime host for a Behavior<T>.  Bridges the typed DSL to the OO Actor —
 * the actor's `onReceive` delegates into whichever Behavior is currently
 * active, and transitions follow whatever the handler returns.
 *
 * The class is internal; users create actors via `spawn(behavior)` on the
 * typed context or `typedActor(behavior)` at the system level.
 */
export class TypedActor<T> extends Actor<T> {
  private current!: ConcreteBehavior<T>;
  private activeSupervise: SuperviseBehavior<T> | null = null;
  /**
   * Restart allowance for {@link activeSupervise}'s strategy.
   *
   * Written in lockstep with that field and meaningful only while it is
   * non-null.  It has to be a sibling field rather than something derived per
   * failure, because the whole point of a budget is that it *accumulates*
   * across the restarts it is counting — and a typed restart never leaves this
   * instance, so nothing else would carry the tally.
   */
  private restartBudget: RestartBudget | null = null;
  /**
   * How many interceptor layers of `current` sit *outside* `activeSupervise`.
   *
   * A restart re-resolves `supervise.child`, which rebuilds every interceptor
   * that lives *inside* the wrapper — so only the ones above it still have to
   * be put back.  Counted while resolving because that is the only place the
   * nesting is visible: once resolved, an interceptor around `supervise` and
   * one under it are the same node.
   */
  private superviseInterceptorDepth = 0;
  private readonly stashBuffers: StashBufferImplementation<T>[] = [];
  private typedContext!: TypedActorContext<T>;
  private signalHandler: ((context: TypedActorContext<T>, signal: Signal) => Behavior<T>) | null = null;

  constructor(private readonly initial: Behavior<T>) { super(); }

  override preStart(): void {
    this.typedContext = new TypedActorContextImplementation<T>(this.context);
    const resolved = this.resolve(this.initial);
    // `same` on the initial behavior makes no sense — treat as empty so the
    // actor exists but drops messages (surfaces the user error as silence).
    this.current = resolved.kind === 'same' ? { kind: 'empty' } : resolved;
    this.maybeHandleTerminalSentinel();
  }

  override onReceive(message: T): void {
    // A watched actor's death arrives as a user message, but it is a lifecycle
    // signal — route it to `onSignal` before the behavior sees it.
    //
    // A `watchWith` death never reaches this branch: the cell has already
    // swapped the `Terminated` for the caller's own message, which is the
    // whole point — the caller asked for a protocol message, so sending it to
    // the signal handler instead would defeat the registration.  Keep the test
    // for `Terminated` as the gate; do not widen it to "was this a death".
    if (message instanceof Terminated && this.signalHandler) {
      this.onTerminatedSignal(message);
      return;
    }

    // The behavior that handles this message is also the one whose interceptor
    // stack the transition below re-installs — and that transition overwrites
    // `current`, so hold on to it first.
    const active = this.current;

    let next: Behavior<T>;
    try {
      next = this.deliver(active, this.typedContext, message);
    } catch (err) {
      if (this.handleSupervise(err as Error)) return;
      throw err;
    }

    if (next.kind === 'same') return;
    if (next.kind === 'unhandled') { this.forwardToDeadLetters(message); return; }

    // `active`'s own layers are re-installed below, so a `supervise` inside
    // `next` is nested under all of them — that is the depth resolve must
    // record for it.
    const resolved = this.resolve(next, interceptorDepthOf(active));
    if (resolved.kind === 'same') return; // defensive — resolve shouldn't produce 'same'
    this.current = this.reinstallInterceptors(active, resolved);
    this.maybeHandleTerminalSentinel();
  }

  override postStop(): void {
    this.notifySignalHandler({ kind: 'post-stop' });
    // After the handler, so a `post-stop` that still calls `unstashAll()`
    // wins over the drain — and so the ordering matches `ActorCell.postStop`,
    // which dead-letters its own stash once `Actor.postStop` has returned.
    this.deadLetterStashBuffers();
  }

  override preRestart(reason: Error, _message?: T): void {
    this.notifySignalHandler({ kind: 'pre-restart', reason });
    this.deadLetterStashBuffers();
  }

  /* ---------------- internal ---------------- */

  /**
   * Hand a terminal signal to the user's handler, if one is registered.
   *
   * Whatever it returns is discarded: both callers sit on a path where this
   * instance is going away, so there is nothing to transition into.  A throw
   * is swallowed for the same reason — failing while stopping would only mask
   * why the actor was stopping.
   */
  private notifySignalHandler(signal: Signal): void {
    if (!this.signalHandler) return;
    try { this.signalHandler(this.typedContext, signal); }
    catch { /* swallow — see above */ }
  }

  /**
   * Send whatever the typed stash buffers still hold to dead letters.
   *
   * The typed counterpart of `ActorCell.deadLetterStash`, and it has to be a
   * counterpart rather than a delegation: these buffers live on this
   * instance, not in the cell's `_stashBuffer`, so the cell's own drain never
   * sees them.  Until this existed they were simply garbage-collected on both
   * the stop and the restart path (#639) — the worst shape a lost message can
   * take, because a stashed message arrived *before* everything still queued
   * and is the one a sender is most likely waiting on.
   *
   * The dead letter cannot name the original sender the way the cell's can:
   * `StashBuffer.stash(message)` takes any value, not necessarily the one
   * being handled, so there is no one sender to attribute it to.
   */
  private deadLetterStashBuffers(): void {
    for (const buffer of this.stashBuffers) {
      for (const message of buffer.drain()) {
        this.system.deadLetters.tell(new DeadLetter(message, null, this.self));
      }
    }
  }

  /**
   * Run one message against an already-resolved behavior and answer what its
   * handler returned — an unresolved `Behavior<T>`, exactly as user code wrote
   * it.  The caller resolves it and decides what becomes current.
   *
   * Interceptors are descended outermost-first: each one is handed a `next`
   * that continues into the behavior it wraps, so an interceptor that never
   * calls `next` short-circuits everything below it.  The context is a
   * parameter rather than a field read because an interceptor may hand a
   * different one down.
   *
   * The sentinels answer for themselves, which is what makes them work
   * *inside* a wrapper too: an interceptor over `Behaviors.empty` still runs
   * and can still veto, it just has nothing to delegate to.  `stopped` answers
   * `unhandled` because a message that arrives after the actor decided to stop
   * belongs in dead letters, and the caller already routes `unhandled` there.
   */
  private deliver(behavior: ConcreteBehavior<T>, context: TypedActorContext<T>, message: T): Behavior<T> {
    return match(behavior)
      .with({ kind: 'receive' }, (b) => b.handler(context, message))
      .with({ kind: 'intercept' }, (b) => b.interceptor(
        context,
        message,
        (innerContext, innerMessage) => this.deliver(b.inner, innerContext, innerMessage),
      ))
      .with({ kind: 'ignore' }, () => Behaviors.same)
      .with({ kind: 'empty' }, () => Behaviors.same)
      .with({ kind: 'unhandled' }, () => Behaviors.unhandled)
      .with({ kind: 'stopped' }, () => Behaviors.unhandled)
      .exhaustive();
  }

  /**
   * Put the interceptors that were wrapped around `previous` back around the
   * behavior it became.
   *
   * This is what makes `Behaviors.intercept` a decorator rather than a one-shot
   * hook.  `resolve()` collapses every other wrapper into the leaf it produced,
   * and a transition replaces `current` wholesale — so without re-wrapping, an
   * interceptor would survive exactly until the behavior underneath it first
   * swapped itself out, which for a state-machine actor is the very first
   * message.
   *
   * The walk rebuilds the whole stack, so nested interceptors keep their order.
   *
   * `layers` caps how far down it goes, counted from the outside.  A plain
   * transition wants the whole stack (the default); a restart wants only the
   * layers above the `supervise` wrapper, because re-resolving its child has
   * already rebuilt everything below.
   */
  private reinstallInterceptors(
    previous: ConcreteBehavior<T>,
    next: ConcreteBehavior<T>,
    layers = Number.POSITIVE_INFINITY,
  ): ConcreteBehavior<T> {
    if (layers <= 0 || previous.kind !== 'intercept') return next;
    return wrapIntercepted(previous.interceptor, this.reinstallInterceptors(previous.inner, next, layers - 1));
  }

  /**
   * Deliver a watched actor's termination to `onSignal` as
   * `{ kind: 'terminated', ref }`.
   *
   * The signal kind was declared and documented from the start but never
   * constructed anywhere, so `onSignal` was simply never called for it: the
   * `Terminated` that `ActorCell` enqueues went to the *receive* handler
   * instead, typed as `T`, where a handler written against the declared
   * protocol had no reason to look for it.
   *
   * Unlike `post-stop` and `pre-restart`, the returned behavior matters here —
   * the actor keeps running afterwards, so a handler answering
   * `Behaviors.stopped()` to a child's death has to be honoured.  Hence the
   * same resolve-and-transition tail as `onReceive`.
   *
   * Only reached when a signal handler is registered; without one the message
   * keeps flowing to the receive handler exactly as before, which keeps this
   * change additive for existing code.  `ActorCell` delivers a `Terminated`
   * only to an actor that is actually watching the subject, so this cannot
   * fire for an unrelated actor's death.
   */
  private onTerminatedSignal(message: Terminated): void {
    const active = this.current;
    let next: Behavior<T>;
    try {
      next = this.signalHandler!(this.typedContext, { kind: 'terminated', ref: message.actor });
    } catch (err) {
      if (this.handleSupervise(err as Error)) return;
      throw err;
    }

    if (next.kind === 'same' || next.kind === 'unhandled') return;
    const resolved = this.resolve(next, interceptorDepthOf(active));
    if (resolved.kind === 'same') return;
    this.current = this.reinstallInterceptors(active, resolved);
    this.maybeHandleTerminalSentinel();
  }

  private handleSupervise(err: Error): boolean {
    if (!this.activeSupervise) return false;
    const supervise = this.activeSupervise;
    const directive = supervise.strategy.decider(err);
    return match(directive)
      .with(Directive.Resume, () => true)
      .with(Directive.Restart, () => this.onRestart(supervise))
      .with(Directive.Stop, () => {
        this.context.stopSelf();
        return true;
      })
      .with(Directive.Escalate, () => false)
      .exhaustive();
  }

  /**
   * Restart the supervised behavior in place — unless the strategy's restart
   * budget is spent, in which case the failure escalates.
   *
   * Escalating rather than stopping is the deliberate half of this: a typed
   * `supervise` is not a separate supervisor actor, it is a wrapper *inside*
   * the failing actor, so `stopSelf()` here would kill the actor silently and
   * throw the error away — nobody upstream would ever learn why it went.
   * Answering `false` is the same answer `Directive.Escalate` gives, so
   * `onReceive` rethrows and the failure travels the ordinary supervision
   * hierarchy: the cell's parent applies *its* strategy, logs, and gets to
   * decide.  (`ActorCell.registerRestart` stops instead, but there the
   * decision is made by a live parent that stays around to observe the
   * `Terminated`; here there would be no such observer.)
   *
   * The two budgets then compose rather than compete: a restart the cell
   * grants builds a *fresh* `TypedActor` via the factory, so this per-instance
   * allowance starts over and the outer bound is the parent's strategy
   * (10 restarts/minute by default).  A behavior that always throws therefore
   * stops looping in place after `maxRetries`, and stops entirely once the
   * parent's own budget runs out.
   */
  private onRestart(supervise: SuperviseBehavior<T>): boolean {
    if (this.restartBudget && !this.restartBudget.registerRestart()) {
      const { maxRetries, withinTimeRangeMs } = supervise.strategy;
      this.log.warn(
        `Typed supervise restart budget exhausted (${maxRetries} in ${withinTimeRangeMs}ms) — escalating`,
      );
      return false;
    }
    // Read the depth before resolving: a nested `supervise` inside the
    // child would overwrite the field on the way through.
    const outerLayers = this.superviseInterceptorDepth;
    // A typed restart re-resolves `supervise.child` in place — the cell
    // never sees it, so `onRecreate`'s drain does not run.  The stash
    // still cannot carry over (the re-resolved behavior has none of the
    // state that made those messages un-handleable), so it goes to dead
    // letters here for exactly the reason it does there.
    this.deadLetterStashBuffers();
    const resolved = this.resolve(supervise.child, outerLayers);
    const restarted: ConcreteBehavior<T> = resolved.kind === 'same' ? { kind: 'empty' } : resolved;
    // Interceptors installed *outside* the supervise wrapper are not part
    // of what restarts — they keep observing the fresh behavior.  The ones
    // *inside* it are, and `restarted` already carries them, so only the
    // outer layers go back on; re-installing the whole stack would add a
    // second copy of every inner interceptor on every restart.
    this.current = this.reinstallInterceptors(this.current, restarted, outerLayers);
    this.maybeHandleTerminalSentinel();
    return true;
  }

  /**
   * `interceptorDepth` is how many interceptor layers the caller will end up
   * wrapping around whatever this call returns.  It exists only so a
   * `supervise` node can record how deeply it is nested — see
   * `superviseInterceptorDepth`.
   */
  private resolve(b: Behavior<T>, interceptorDepth = 0): ResolvedBehavior<T> {
    // Resolve chained deferred wrappers (setup inside withTimers inside supervise…).
    // Each wrapper contributes its side-effect (capturing timers, installing
    // supervise, …) exactly once; leaf behaviors end the loop.  We thread the
    // iteration through a tagged ResolveStep so the match() stays exhaustive.
    type ResolveStep =
      | { readonly step: 'continue'; readonly next: Behavior<T> }
      | { readonly step: 'done'; readonly final: ResolvedBehavior<T> };

    let cur: Behavior<T> = b;
    for (let hops = 0; hops < 64; hops++) {
      const step: ResolveStep = match(cur)
        .with({ kind: 'setup' }, (n): ResolveStep => ({
          step: 'continue', next: n.factory(this.typedContext),
        }))
        .with({ kind: 'with-timers' }, (n): ResolveStep => ({
          step: 'continue', next: n.factory(this.context.timers as TimerScheduler<T>),
        }))
        .with({ kind: 'with-stash' }, (n): ResolveStep => {
          const buffer = new StashBufferImplementation<T>(n.capacity, this.self);
          this.stashBuffers.push(buffer);
          return { step: 'continue', next: n.factory(buffer) };
        })
        .with({ kind: 'supervise' }, (n): ResolveStep => {
          // Keyed on node identity, not on the strategy: a *different*
          // `supervise` node is a different supervision scope and starts with
          // a full allowance, while the same node keeps the tally it has built
          // up.  That distinction is what makes the budget bite at all — a
          // restart re-resolves `supervise.child`, never the wrapper, so the
          // node reaching here twice means user code really did install a new
          // scope rather than the supervisor merely doing its job.
          if (this.activeSupervise !== n) this.restartBudget = new RestartBudget(n.strategy);
          this.activeSupervise = n;
          this.superviseInterceptorDepth = interceptorDepth;
          return { step: 'continue', next: n.child };
        })
        // The one wrapper that does not collapse: resolve what it wraps (its
        // own hop budget) and keep the interceptor around the result — one
        // layer deeper, for anything below that counts its nesting.
        .with({ kind: 'intercept' }, (n): ResolveStep => ({
          step: 'done', final: wrapIntercepted(n.interceptor, this.resolve(n.inner, interceptorDepth + 1)),
        }))
        .with({ kind: 'receive' }, (n): ResolveStep => {
          if (n.onSignal) this.signalHandler = n.onSignal;
          return { step: 'done', final: n };
        })
        .with({ kind: 'same' }, (n): ResolveStep => ({ step: 'done', final: n }))
        .with({ kind: 'stopped' }, (n): ResolveStep => ({ step: 'done', final: n }))
        .with({ kind: 'unhandled' }, (n): ResolveStep => ({ step: 'done', final: n }))
        .with({ kind: 'empty' }, (n): ResolveStep => ({ step: 'done', final: n }))
        .with({ kind: 'ignore' }, (n): ResolveStep => ({ step: 'done', final: n }))
        .exhaustive();

      if (step.step === 'done') return step.final;
      cur = step.next;
    }
    throw new Error('Behavior resolution exceeded 64 hops — likely a cycle between deferred factories');
  }

  private maybeHandleTerminalSentinel(): void {
    if (this.current.kind === 'stopped') this.context.stopSelf();
  }

  private forwardToDeadLetters(message: T): void {
    this.system.deadLetters.tell(message as never);
  }
}

/**
 * Wrap an already-resolved behavior back into its interceptor.
 *
 * Two inners are special.  `stopped` drops the wrapper: the actor is on its way
 * out, `maybeHandleTerminalSentinel` has to see the sentinel at the top, and
 * there is nothing left to intercept anyway.  A bare `same` is a user error
 * (`intercept(Behaviors.same, …)` wraps nothing) and becomes `empty`, the same
 * reading `preStart` gives a `same` initial behavior: the actor exists and
 * drops messages, so the mistake surfaces as silence rather than as a crash.
 */
function wrapIntercepted<T>(
  interceptor: BehaviorInterceptor<T>,
  inner: ResolvedBehavior<T>,
): ConcreteBehavior<T> {
  if (inner.kind === 'stopped') return inner;
  return { kind: 'intercept', interceptor, inner: inner.kind === 'same' ? { kind: 'empty' } : inner };
}

/** How many interceptor wrappers an already-resolved behavior carries on top. */
function interceptorDepthOf<T>(behavior: ConcreteBehavior<T>): number {
  let depth = 0;
  let node: ConcreteBehavior<T> = behavior;
  while (node.kind === 'intercept') {
    depth++;
    node = node.inner;
  }
  return depth;
}

/* ---------------- Context ---------------- */

class TypedActorContextImplementation<T> implements TypedActorContext<T> {
  constructor(private readonly oo: import('../ActorContext.js').ActorContext<T>) {}
  get self(): ActorRef<T> { return this.oo.self; }
  get path(): import('../ActorPath.js').ActorPath { return this.oo.path; }
  get system(): import('../ActorSystem.js').ActorSystem { return this.oo.system; }
  get log(): import('../Logger.js').Logger { return this.oo.log; }
  setDisplayName(name: string): void { this.oo.setDisplayName(name); }

  spawn<U>(behavior: Behavior<U>, name?: string): ActorRef<U> {
    const actor = (): TypedActor<U> => new TypedActor<U>(behavior);
    return name !== undefined ? this.oo.spawn(actor, name) : this.oo.spawnAnonymous(actor);
  }

  stop(ref: ActorRef): void { this.oo.stop(ref); }
  watch(ref: ActorRef): void { this.oo.watch(ref); }
  watchWith(ref: ActorRef, message: T): void { this.oo.watchWith(ref, message); }
  unwatch(ref: ActorRef): void { this.oo.unwatch(ref); }
  get timers(): TimerScheduler<T> { return this.oo.timers; }
}

/* ---------------- StashBuffer ---------------- */

/**
 * The typed DSL's own stash.
 *
 * It keeps an array rather than delegating to `context.stash()` because the
 * OO API cannot serve either half of this contract: `stash(message)` takes an
 * arbitrary value where the cell can only park the envelope it is currently
 * handling, and the capacity is declared per `withStash` behavior where the
 * cell has one compiled-in default for the whole actor.
 *
 * The *replay*, though, is the cell's.  `self.tell` appends to the tail of the
 * user queue, so every message that arrived while the stash was filling got
 * handled before the replay did — the exact inversion stashing exists to
 * prevent (#639).  `prependUserMessages` puts them back at the head instead,
 * matching `ActorContext.unstashAll`.
 */
class StashBufferImplementation<T> implements StashBuffer<T> {
  private readonly buffer: T[] = [];
  constructor(
    private readonly capacity: number,
    private readonly self: ActorRef<T>,
  ) {}

  stash(message: T): void {
    if (this.buffer.length >= this.capacity) throw new StashOverflowError(this.capacity);
    this.buffer.push(message);
  }

  unstashAll(): void {
    const drained = this.drain();
    if (drained.length === 0) return;
    // A `TypedActor`'s `self` is minted by its own cell, so this is the branch
    // that actually runs.  The `tell` fallback covers an `ActorRef` the
    // framework did not produce, where appending is at least better than
    // dropping the replay on the floor.
    if (this.self instanceof LocalActorRef) {
      this.self.getCell().prependUserMessages(drained);
      return;
    }
    for (const message of drained) this.self.tell(message);
  }

  /**
   * Empty the buffer and answer what it held.
   *
   * Not part of {@link StashBuffer} — it exists for `TypedActor`'s stop and
   * restart paths, which have to take the contents *away* from the buffer to
   * dead-letter them, and for `unstashAll` itself.
   */
  drain(): T[] {
    return this.buffer.splice(0, this.buffer.length);
  }

  get isEmpty(): boolean { return this.buffer.length === 0; }
  get isFull(): boolean { return this.buffer.length >= this.capacity; }
  get size(): number { return this.buffer.length; }
}
