import { match } from 'ts-pattern';
import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import { Props } from '../Props.js';
import { Directive } from '../Supervision.js';
import {
  StashOverflowError,
  type TimerScheduler,
} from '../ActorContext.js';
import type {
  Behavior,
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
 */
type ConcreteBehavior<T> =
  | ReceiveBehavior<T>
  | StoppedBehavior
  | UnhandledBehavior
  | EmptyBehavior
  | IgnoreBehavior;

/** Kept for resolve()'s return when it does encounter a bare `same`. */
type ResolvedBehavior<T> = ConcreteBehavior<T> | SameBehavior;

/**
 * Runtime host for a Behavior<T>.  Bridges the typed DSL to the OO Actor —
 * the actor's `onReceive` delegates into whichever Behavior is currently
 * active, and transitions follow whatever the handler returns.
 *
 * The class is internal; users create actors via `spawn(behavior)` on the
 * typed context or `typedProps(behavior)` at the system level.
 */
export class TypedActor<T> extends Actor<T> {
  private current!: ConcreteBehavior<T>;
  private activeSupervise: SuperviseBehavior<T> | null = null;
  private readonly stashBuffers: StashBufferImplementation<T>[] = [];
  private typedCtx!: TypedActorContext<T>;
  private signalHandler: ((ctx: TypedActorContext<T>, signal: Signal) => Behavior<T>) | null = null;

  constructor(private readonly initial: Behavior<T>) { super(); }

  override preStart(): void {
    this.typedCtx = new TypedActorContextImplementation<T>(this.context);
    const resolved = this.resolve(this.initial);
    // `same` on the initial behavior makes no sense — treat as empty so the
    // actor exists but drops messages (surfaces the user error as silence).
    this.current = resolved.kind === 'same' ? { kind: 'empty' } : resolved;
    this.maybeHandleTerminalSentinel();
  }

  override onReceive(message: T): void {
    // Sentinels that short-circuit without running a handler:
    const shortCircuit = match(this.current)
      .with({ kind: 'ignore' }, () => true as const)
      .with({ kind: 'empty' }, () => true as const)
      .with({ kind: 'unhandled' }, () => { this.forwardToDeadLetters(message); return true as const; })
      .with({ kind: 'stopped' }, () => { this.forwardToDeadLetters(message); return true as const; })
      .with({ kind: 'receive' }, () => false as const)
      .exhaustive();
    if (shortCircuit) return;

    // `current` is narrowed to ReceiveBehavior by the match above, but TS
    // can't carry that across the branch — re-narrow locally.
    const receiveBehavior = this.current;
    if (receiveBehavior.kind !== 'receive') return;

    let next: Behavior<T>;
    try {
      next = receiveBehavior.handler(this.typedCtx, message);
    } catch (err) {
      if (this.handleSupervise(err as Error)) return;
      throw err;
    }

    if (next.kind === 'same') return;
    if (next.kind === 'unhandled') { this.forwardToDeadLetters(message); return; }

    const resolved = this.resolve(next);
    if (resolved.kind === 'same') return; // defensive — resolve shouldn't produce 'same'
    this.current = resolved;
    this.maybeHandleTerminalSentinel();
  }

  override postStop(): void {
    if (this.signalHandler) {
      try {
        const next = this.signalHandler(this.typedCtx, { kind: 'post-stop' });
        void next; // we are stopping anyway — nothing to transition into.
      } catch { /* swallow */ }
    }
  }

  override preRestart(reason: Error, _msg?: T): void {
    if (this.signalHandler) {
      try { this.signalHandler(this.typedCtx, { kind: 'pre-restart', reason }); }
      catch { /* swallow */ }
    }
  }

  /* ---------------- internal ---------------- */

  private handleSupervise(err: Error): boolean {
    if (!this.activeSupervise) return false;
    const supervise = this.activeSupervise;
    const directive = supervise.strategy.decider(err);
    return match(directive)
      .with(Directive.Resume, () => true)
      .with(Directive.Restart, () => {
        const resolved = this.resolve(supervise.child);
        this.current = resolved.kind === 'same' ? { kind: 'empty' } : resolved;
        this.maybeHandleTerminalSentinel();
        return true;
      })
      .with(Directive.Stop, () => {
        this.context.stopSelf();
        return true;
      })
      .with(Directive.Escalate, () => false)
      .exhaustive();
  }

  private resolve(b: Behavior<T>): ResolvedBehavior<T> {
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
          step: 'continue', next: n.factory(this.typedCtx),
        }))
        .with({ kind: 'with-timers' }, (n): ResolveStep => ({
          step: 'continue', next: n.factory(this.context.timers as TimerScheduler<T>),
        }))
        .with({ kind: 'with-stash' }, (n): ResolveStep => {
          const buf = new StashBufferImplementation<T>(n.capacity, this.self);
          this.stashBuffers.push(buf);
          return { step: 'continue', next: n.factory(buf) };
        })
        .with({ kind: 'supervise' }, (n): ResolveStep => {
          this.activeSupervise = n;
          return { step: 'continue', next: n.child };
        })
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

/* ---------------- Context ---------------- */

class TypedActorContextImplementation<T> implements TypedActorContext<T> {
  constructor(private readonly oo: import('../ActorContext.js').ActorContext<T>) {}
  get self(): ActorRef<T> { return this.oo.self; }
  get path(): import('../ActorPath.js').ActorPath { return this.oo.path; }
  get system(): import('../ActorSystem.js').ActorSystem { return this.oo.system; }
  get log(): import('../Logger.js').Logger { return this.oo.log; }

  spawn<U>(behavior: Behavior<U>, name?: string): ActorRef<U> {
    const props = Props.create(() => new TypedActor<U>(behavior));
    return name !== undefined ? this.oo.spawn(props, name) : this.oo.spawnAnonymous(props);
  }

  stop(ref: ActorRef): void { this.oo.stop(ref); }
  watch(ref: ActorRef): void { this.oo.watch(ref); }
  unwatch(ref: ActorRef): void { this.oo.unwatch(ref); }
  get timers(): TimerScheduler<T> { return this.oo.timers; }
}

/* ---------------- StashBuffer ---------------- */

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
    const drained = this.buffer.splice(0, this.buffer.length);
    for (const m of drained) this.self.tell(m);
  }
  get isEmpty(): boolean { return this.buffer.length === 0; }
  get isFull(): boolean { return this.buffer.length >= this.capacity; }
  get size(): number { return this.buffer.length; }
}
