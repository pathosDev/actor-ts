import type { Actor } from '../Actor.js';
import {
  type ActorContext,
  type Receive,
  type ThrottleOnExcess,
  type ThrottleOptions,
  type TimerScheduler,
  StashOutsideHandlerError,
  StashOverflowError,
} from '../ActorContext.js';
import { ActorPath } from '../ActorPath.js';
import { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { LogContext } from '../LogContext.js';
import type { Logger } from '../Logger.js';
import { metricsOf } from '../metrics/MetricsExtension.js';
import { tracerOf } from '../tracing/TracingExtension.js';
import type { Span } from '../tracing/Tracer.js';
import type { Props } from '../Props.js';
import type { Behavior } from '../typed/Behavior.js';
import { typedProps } from '../typed/spawn.js';
import {
  ActorInitializationError,
  defaultStrategy,
  Directive,
  type SupervisorStrategy,
} from '../Supervision.js';
import {
  ActorKilledError,
  DeadLetter,
  Kill,
  PoisonPill,
  ReceiveTimeout,
  Terminated,
} from '../SystemMessages.js';
import { Envelope, Mailbox } from './Mailbox.js';
import { BoundedMailbox } from '../mailbox/BoundedMailbox.js';
import { DEFAULT_MAILBOX_CAPACITY, DEFAULT_MAILBOX_OVERFLOW } from '../util/Constants.js';
import { LocalActorRef } from './LocalActorRef.js';
import type { SystemCommand } from './SystemCommand.js';
import type { Cancellable } from '../Scheduler.js';
import { match } from 'ts-pattern';
import { fromNullable, type Option } from '../util/Option.js';
import { TokenBucket } from '../util/TokenBucket.js';

const DEFAULT_STASH_CAPACITY = 1024;

type CellState =
  | 'creating'
  | 'running'
  | 'suspended'
  | 'terminating'
  | 'terminated';

/**
 * Internal runtime for a single actor.  Bridges the user-visible Actor /
 * ActorContext API with the mailbox, dispatcher and supervision machinery.
 */
export class ActorCell<TMessage = unknown> implements ActorContext<TMessage> {
  readonly self: LocalActorRef<TMessage>;
  readonly path: ActorPath;
  readonly log: Logger;

  private readonly mailbox: Mailbox<TMessage>;
  private actor: Actor<TMessage> | null = null;
  private _parent: ActorCell<unknown> | null;
  private _children = new Map<string, ActorCell<any>>();
  private _anonChildCounter = 0;
  private _childUidCounter = 0;

  private state: CellState = 'creating';
  private processing = false;
  private _currentSender: ActorRef | null = null;
  private behaviorStack: Array<Receive<TMessage>> = [];

  private _watchers = new Set<ActorRef>();
  private _watching = new Map<string, ActorRef>();

  private _failureTimes: number[] = [];

  private _receiveTimeoutMs = 0;
  private _receiveTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  /** Envelope currently being handed to the user — drives `context.stash()`. */
  private _currentEnvelope: Envelope<TMessage> | null = null;
  private _stashBuffer: Array<Envelope<TMessage>> = [];
  private readonly _stashCapacity: number = DEFAULT_STASH_CAPACITY;

  /** Active throttle, if any.  See `throttle()` / `cancelThrottle()`. */
  private _throttleBucket: TokenBucket | null = null;
  private _throttleOnExcess: ThrottleOnExcess = 'pause';
  /** Pending pause-mode resume, so we don't double-schedule. */
  private _throttleResumeTimer: Cancellable | null = null;

  /** Per-actor timer scheduler. */
  readonly timers: TimerScheduler<TMessage> = new CellTimerScheduler<TMessage>(this);

  constructor(
    readonly system: ActorSystem,
    readonly props: Props<TMessage>,
    parent: ActorCell<unknown> | null,
    public readonly name: string,
  ) {
    this._parent = parent;
    const uid = parent ? parent._nextChildUid() : 0;
    this.path = parent
      ? parent.path.child(name, uid)
      : new ActorPath(name, null, system.name, uid);
    this.mailbox = props.config.mailbox
      ? props.config.mailbox()
      // #310 — bounded by default.  Unbounded was the pre-#310 default
      // and is still available via `Props.withMailbox(() => new Mailbox())`
      // for use-cases that need it (deterministic replay, test setups,
      // tightly-controlled throughput).  See `DEFAULT_MAILBOX_CAPACITY`
      // + `DEFAULT_MAILBOX_OVERFLOW` for the chosen ceiling + policy.
      : new BoundedMailbox<TMessage>({
        capacity: props.config.mailboxCapacity ?? DEFAULT_MAILBOX_CAPACITY,
        overflow: DEFAULT_MAILBOX_OVERFLOW,
        onDrop: (reason) => this._onMailboxDrop(reason),
      });
    this.self = new LocalActorRef<TMessage>(this);
    this.log = system.log.withSource(this.path.toString());
    this.enqueueSystem({ kind: 'create' });
  }

  /* ============================ ActorContext API ============================ */

  get sender(): Option<ActorRef> { return fromNullable(this._currentSender); }

  get parent(): Option<ActorRef> { return fromNullable(this._parent ? this._parent.self : null); }

  get children(): ReadonlyArray<ActorRef> {
    const out: ActorRef[] = [];
    for (const c of this._children.values()) out.push(c.self);
    return out;
  }

  spawn<T>(props: Props<T>, name: string): ActorRef<T> {
    return this._createChild(props, name);
  }

  spawnAnonymous<T>(props: Props<T>): ActorRef<T> {
    return this._createChild(props, `$${++this._anonChildCounter}`);
  }

  spawnTyped<T>(behavior: Behavior<T>, name: string): ActorRef<T> {
    return this._createChild(typedProps<T>(behavior), name);
  }

  spawnTypedAnonymous<T>(behavior: Behavior<T>): ActorRef<T> {
    return this._createChild(typedProps<T>(behavior), `$${++this._anonChildCounter}`);
  }

  /** @internal — single child-creation path shared by spawn / spawnAnonymous. */
  private _createChild<T>(props: Props<T>, name: string): ActorRef<T> {
    if (this.state === 'terminated' || this.state === 'terminating') {
      throw new Error(`Cannot spawn children from terminated actor ${this.path}`);
    }
    if (this._children.has(name)) {
      throw new Error(`Child name '${name}' is not unique under ${this.path}`);
    }
    const cell = new ActorCell<T>(this.system, props, this as unknown as ActorCell<unknown>, name);
    this._children.set(name, cell);
    return cell.self;
  }

  child(name: string): Option<ActorRef> {
    const c = this._children.get(name);
    return fromNullable(c ? c.self : null);
  }

  /** @internal — used by ActorSelection to walk down the tree. */
  _findChildCell(name: string): ActorCell<unknown> | null {
    return this._children.get(name) ?? null;
  }

  actorSelection(path: string): import('../ActorSelection.js').ActorSelection {
    return this.system.actorSelection(path);
  }

  stop(ref: ActorRef): void {
    ref.tell(PoisonPill.instance as unknown as never);
  }

  stopSelf(): void {
    this.enqueueSystem({ kind: 'terminate' });
  }

  watch(ref: ActorRef): ActorRef {
    const key = ref.path.toString();
    if (this._watching.has(key)) return ref;
    this._watching.set(key, ref);
    if (ref instanceof LocalActorRef) {
      ref.getCell()._addWatcher(this.self);
    }
    return ref;
  }

  unwatch(ref: ActorRef): ActorRef {
    const key = ref.path.toString();
    if (!this._watching.delete(key)) return ref;
    if (ref instanceof LocalActorRef) {
      ref.getCell()._removeWatcher(this.self);
    }
    return ref;
  }

  become(behavior: Receive<TMessage>, discardOld: boolean = true): void {
    if (discardOld && this.behaviorStack.length > 0) {
      this.behaviorStack[this.behaviorStack.length - 1] = behavior;
    } else {
      this.behaviorStack.push(behavior);
    }
  }

  unbecome(): void {
    if (this.behaviorStack.length > 1) this.behaviorStack.pop();
  }

  setReceiveTimeout(ms: number): void {
    this._receiveTimeoutMs = ms;
    this._resetReceiveTimer();
  }

  cancelReceiveTimeout(): void {
    this._receiveTimeoutMs = 0;
    this._clearReceiveTimer();
  }

  /* -------------------------------- Stash ---------------------------------- */

  stash(): void {
    if (!this._currentEnvelope) throw new StashOutsideHandlerError();
    if (this._stashBuffer.length >= this._stashCapacity) {
      throw new StashOverflowError(this._stashCapacity);
    }
    this._stashBuffer.push(this._currentEnvelope);
    // Mark the message as consumed — it is now owned by the stash, not the
    // behavior — so subsequent re-throws / errors don't double-stash it.
    this._currentEnvelope = null;
  }

  unstashAll(): void {
    if (this._stashBuffer.length === 0) return;
    const drained = this._stashBuffer;
    this._stashBuffer = [];
    // Prepend so stashed messages come out before anything currently queued,
    // preserving the original stash order.
    this.mailbox.prependUser(drained);
    this.schedule();
  }

  get stashSize(): number { return this._stashBuffer.length; }

  /* ------------------------- Rate limiting (#83) ------------------------ */

  throttle(opts: ThrottleOptions): void {
    this._throttleBucket = new TokenBucket({
      qps: opts.qps,
      burst: opts.burst,
      now: opts.now,
    });
    this._throttleOnExcess = opts.onExcess ?? 'pause';
    // Switching configs invalidates any pending pause-resume timer
    // (the new bucket may already have tokens) — let the next run()
    // make a fresh decision.
    this._throttleResumeTimer?.cancel();
    this._throttleResumeTimer = null;
    // If the actor was paused before, kick the pump so it re-evaluates
    // against the new (potentially looser) limit.
    if (this.state === 'running' && this.mailbox.hasMessages()) {
      this.schedule();
    }
  }

  cancelThrottle(): void {
    this._throttleBucket = null;
    this._throttleResumeTimer?.cancel();
    this._throttleResumeTimer = null;
    if (this.state === 'running' && this.mailbox.hasMessages()) {
      this.schedule();
    }
  }

  /**
   * Decide what to do with a user message dequeued while the throttle
   * bucket is empty.  Returns `true` if the message was disposed of
   * (drop / re-queued for pause), `false` only as a defensive fallback
   * if state is already terminal.
   */
  private handleThrottleExcess(env: Envelope<TMessage>): boolean {
    if (!this._throttleBucket) return false; // can't happen in practice
    if (this._throttleOnExcess === 'drop') {
      this.log.debug(
        `actor throttle: bucket empty in 'drop' mode — discarding message`,
        { message: env.message },
      );
      return true;
    }
    // 'pause' mode — put the message back at the head of the mailbox
    // and schedule a resume tick when tokens are due.  No new run()
    // is dispatched until the timer fires (or someone else schedules
    // us, which is fine: tryConsume will fail again, message goes
    // back, timer re-arms idempotently).
    this.mailbox.prependUser([env]);
    if (this._throttleResumeTimer) return true; // already armed
    const waitMs = Math.max(1, this._throttleBucket.timeUntilNext(1));
    this._throttleResumeTimer = this.system.scheduler.scheduleOnceFn(
      waitMs, () => {
        this._throttleResumeTimer = null;
        if (this.state === 'running' && this.mailbox.hasMessages()) {
          this.schedule();
        }
      },
    );
    return true;
  }

  /* ============================== Internal API ============================== */

  /** @internal */ isTerminated(): boolean { return this.state === 'terminated'; }
  /** @internal */ _nextChildUid(): number { return ++this._childUidCounter; }

  /**
   * @internal — test-only seam exposing the underlying mailbox so
   * regression tests can assert the concrete type (e.g. #310 default
   * is `BoundedMailbox`).  NOT for production use — the mailbox
   * surface is private by design.
   */
  _mailboxForTest(): Mailbox<TMessage> { return this.mailbox; }

  /** @internal */
  postUserMessage(message: TMessage, sender: ActorRef | null): void {
    if (this.state === 'terminated') {
      this.system.deadLetters.tell(new DeadLetter(message, sender, this.self));
      return;
    }
    this.mailbox.enqueue({ message, sender });
    this.schedule();
  }

  /**
   * @internal — like `postUserMessage` but takes a pre-built envelope
   * so callers can attach extras like `context` (the MDC snapshot) or
   * trace state without a wider signature.  `LocalActorRef.tell` uses
   * this so the MDC captured at tell-time travels with the message.
   */
  postUserEnvelope(env: Envelope<TMessage>): void {
    if (this.state === 'terminated') {
      this.system.deadLetters.tell(new DeadLetter(env.message, env.sender, this.self));
      return;
    }
    this.mailbox.enqueue(env);
    this.schedule();
  }

  /** @internal */
  enqueueSystem(cmd: SystemCommand, sender: ActorRef | null = null): void {
    this.mailbox.enqueueSystem({ message: cmd, sender });
    this.schedule();
  }

  /** @internal */
  _addWatcher(watcher: ActorRef): void {
    if (this.state === 'terminated') {
      watcher.tell(new Terminated(this.self) as never);
      return;
    }
    this._watchers.add(watcher);
  }

  /** @internal */
  _removeWatcher(watcher: ActorRef): void {
    this._watchers.delete(watcher);
  }

  /* ============================ Message processing ========================== */

  private schedule(): void {
    if (this.processing || this.state === 'terminated') return;
    if (!this.mailbox.hasMessages()) return;
    this.processing = true;
    const dispatcher = this.props.config.dispatcher ?? this.system.dispatcher;
    dispatcher.execute(() => this.run());
  }

  private async run(): Promise<void> {
    try {
      // System messages always come first, and they can change the state.
      while (this.mailbox.hasSystemMessages()) {
        const env = this.mailbox.dequeueSystem()!;
        await this.handleSystemCommand(env.message as SystemCommand);
        if (this.state === 'terminated') return;
      }

      if (this.state === 'running') {
        const env = this.mailbox.dequeueUser();
        if (env) {
          // Throttle gate (#83) — applies only to user messages, never
          // to system commands (those ran above and must stay
          // responsive for lifecycle / supervision / Terminated).
          if (this._throttleBucket && !this._throttleBucket.tryConsume(1)) {
            const handled = this.handleThrottleExcess(env);
            // 'pause' returns the message to the head of the mailbox
            // and reschedules; 'drop' silently consumes it.  Either
            // way we don't run the user handler this turn.
            if (!handled) {
              // Defensive: 'drop' returned but we still want to
              // re-schedule if there's more queued.
              return;
            }
          } else {
            await this.handleUserMessage(env);
          }
        }
      }
    } finally {
      this.processing = false;
      if (this.state !== 'terminated' && this.mailbox.hasMessages()) {
        this.schedule();
      }
    }
  }

  private async handleSystemCommand(cmd: SystemCommand): Promise<void> {
    await match(cmd)
      .with({ kind: 'create' }, () => this.doCreate())
      .with({ kind: 'terminate' }, () => this.doTerminate())
      .with({ kind: 'recreate' }, (c) => this.doRecreate(c.cause))
      .with({ kind: 'suspend' }, () => {
        this.mailbox.suspend();
        if (this.state === 'running') this.state = 'suspended';
      })
      .with({ kind: 'resume' }, () => {
        this.mailbox.resume();
        if (this.state === 'suspended') this.state = 'running';
      })
      .with({ kind: 'failure' }, (c) => this.superviseChildFailure(c.cause, c.child, c.message))
      .with({ kind: 'childTerminated' }, (c) => this.handleChildTerminated(c.child))
      .with({ kind: 'watchNotify' }, (c) => {
        this.mailbox.enqueue({ message: new Terminated(c.target) as unknown as TMessage, sender: null });
      })
      .with({ kind: 'receiveTimeout' }, async () => {
        if (this.state === 'running') {
          await this.handleUserMessage({ message: ReceiveTimeout.instance as unknown as TMessage, sender: null });
        }
      })
      .exhaustive();
  }

  private async doCreate(): Promise<void> {
    try {
      const actor = this.props.config.factory();
      (actor as unknown as { _attach(ctx: ActorContext<TMessage>): void })._attach(this);
      this.actor = actor;
      this.behaviorStack = [(m: TMessage) => actor.onReceive(m)];
      this.state = 'running';
      await actor.preStart();
      // Stock metric: count actor creations.  Cheap when metrics are
      // disabled — `metricsOf(...)` returns the noop registry.
      metricsOf(this.system).counter(
        'actor_created_total', {},
        { help: 'Cumulative count of actors successfully started.' },
      ).inc();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.log.error('Actor initialization failed', err);
      this.failToParent(new ActorInitializationError(`Actor ${this.path} failed to start`, err));
    }
  }

  private async doTerminate(): Promise<void> {
    if (this.state === 'terminated' || this.state === 'terminating') return;
    this.state = 'terminating';
    this._clearReceiveTimer();

    // Stop all children and wait for them
    const childRefs = Array.from(this._children.values());
    for (const child of childRefs) child.enqueueSystem({ kind: 'terminate' });
    // Children notify us via 'childTerminated'; we finish in finalizeTermination.
    if (this._children.size === 0) {
      await this.finalizeTermination();
    }
  }

  private async finalizeTermination(): Promise<void> {
    // Cancel actor-scoped timers before user code runs in postStop so the
    // actor cannot schedule new messages into a mailbox that's about to
    // drain to dead letters.
    this.timers.cancelAll();
    // Cancel any pending throttle-resume tick — same reasoning as the
    // user timers above.
    this._throttleResumeTimer?.cancel();
    this._throttleResumeTimer = null;
    try {
      await this.actor?.postStop();
    } catch (e) {
      this.log.error('postStop threw', e);
    }

    // Drain any remaining user messages to dead letters
    for (const env of this.mailbox.drainUser()) {
      this.system.deadLetters.tell(new DeadLetter(env.message, env.sender, this.self));
    }

    this.state = 'terminated';

    // Stock metric: count terminations (clean stop OR post-failure path).
    metricsOf(this.system).counter(
      'actor_terminated_total', {},
      { help: 'Cumulative count of actors that have been stopped.' },
    ).inc();

    // Notify watchers
    const term = new Terminated(this.self);
    for (const w of this._watchers) w.tell(term as never);
    this._watchers.clear();

    // Tell watched targets to drop us from their watcher set
    for (const t of this._watching.values()) {
      if (t instanceof LocalActorRef) t.getCell()._removeWatcher(this.self);
    }
    this._watching.clear();

    // Notify parent so it can remove us and run its own supervision hooks
    if (this._parent) {
      this._parent.enqueueSystem({ kind: 'childTerminated', child: this.self });
    } else {
      this.system._rootTerminated(this);
    }
  }

  private async doRecreate(cause: Error): Promise<void> {
    if (!this.actor) return;

    // Timers and stash belong to the outgoing instance.
    this.timers.cancelAll();
    this._stashBuffer = [];

    // Let the old instance clean up (stopping children is the default).
    try {
      await this.actor.preRestart(cause);
    } catch (e) {
      this.log.error('preRestart threw', e);
    }

    // Build a new instance.
    try {
      const next = this.props.config.factory();
      (next as unknown as { _attach(ctx: ActorContext<TMessage>): void })._attach(this);
      this.actor = next;
      this.behaviorStack = [(m: TMessage) => next.onReceive(m)];
      await next.postRestart(cause);
      this.mailbox.resume();
      this.state = 'running';
      // Stock metric: count restarts.
      metricsOf(this.system).counter(
        'actor_restarted_total', {},
        { help: 'Cumulative count of supervisor-driven actor restarts.' },
      ).inc();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.failToParent(new ActorInitializationError(`Actor ${this.path} failed to restart`, err));
    }
  }

  /**
   * Callback wired from the default `BoundedMailbox` — fires once per
   * dropped message.  Increments `actor_mailbox_dropped_total` with
   * labels {class, path, reason} so operators can spot slow-consumer
   * signals on the standard observability stack.  Cheap when metrics
   * are disabled (the noop registry's counter is a single object lookup).
   */
  private _onMailboxDrop(reason: 'drop-head' | 'drop-new'): void {
    const cls = this.actor?.constructor.name ?? 'unknown';
    metricsOf(this.system).counter(
      'actor_mailbox_dropped_total',
      { class: cls, path: this.path.toString(), reason },
      { help: 'Cumulative count of user messages dropped by a bounded mailbox\'s overflow policy.' },
    ).inc();
  }

  private async handleUserMessage(env: Envelope<TMessage>): Promise<void> {
    const msg = env.message;

    if (msg === (PoisonPill.instance as unknown as TMessage)) {
      await this.doTerminate();
      return;
    }
    if (msg === (Kill.instance as unknown as TMessage)) {
      this.failToParent(new ActorKilledError(), msg);
      return;
    }

    const metrics = metricsOf(this.system);
    metrics.counter(
      'actor_messages_delivered_total', {},
      { help: 'Cumulative count of user messages delivered to actor onReceive.' },
    ).inc();

    const tracer = tracerOf(this.system);
    // Open a server-kind `actor.receive` span when tracing is enabled
    // and either we have a parent in the envelope or we're starting a
    // root.  Span is the "active" one for the duration of `behavior(msg)`
    // so child tells from inside the handler get this span as parent.
    let span: Span | null = null;

    // Establish the MDC scope for the duration of `behavior(msg)`.  Any
    // `tell`s issued from inside the handler snapshot this same context
    // (LocalActorRef + RemoteActorRef both read `LogContext.get()`),
    // so the trail propagates downstream without manual plumbing.
    // Empty context skips the wrapper entirely — keeps the no-MDC
    // hot path unchanged.
    const dispatch = async (): Promise<void> => {
      this._currentSender = env.sender;
      this._currentEnvelope = env;
      const startNs = performance.now();
      try {
        if (msg instanceof Terminated) {
          // Only deliver when we are actually watching.
          const key = msg.actor.path.toString();
          if (!this._watching.has(key)) {
            this._currentSender = null;
            this._currentEnvelope = null;
            return;
          }
          this._watching.delete(key);
        }
        const behavior = this.behaviorStack[this.behaviorStack.length - 1];
        if (span) {
          await tracer.withActiveSpan(span, () => behavior(msg));
        } else {
          await behavior(msg);
        }
        this._resetReceiveTimer();
        if (span) span.setStatus('ok');
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (span) {
          span.recordException(err);
          span.setStatus('error', err.message);
        }
        this.failToParent(err, msg);
      } finally {
        if (span) span.end();
        // Record handler duration in seconds — Prom convention.  Using
        // the per-call `metrics` ref keeps a single dispatch through
        // the extension chain.
        metrics.histogram(
          'actor_message_handler_seconds', {},
          { help: 'Time spent inside actor onReceive handlers, seconds.' },
        ).observe((performance.now() - startNs) / 1000);
        this._currentSender = null;
        this._currentEnvelope = null;
      }
    };

    // Lazily start the span once we know tracing is enabled and the
    // envelope is an "interesting" message (skip Terminated etc?  Spans
    // for system-message-shaped envelopes are still useful — the path
    // is what matters).  `null` parent → root span; envelope-supplied
    // SpanContext → child of the originating tell.
    if (env.trace || tracerOf(this.system).activeSpan()) {
      span = tracer.startSpan('actor.receive', {
        parent: env.trace ?? undefined,
        kind: 'consumer',
        attributes: {
          'actor.path': this.path.toString(),
          'actor.message.type': (msg as { constructor?: { name?: string } })?.constructor?.name ?? typeof msg,
        },
      });
    }

    if (env.context) {
      await LogContext.run(env.context, dispatch);
    } else {
      await dispatch();
    }
  }

  /* =============================== Supervision ============================== */

  private failToParent(cause: Error, message?: unknown): void {
    this.mailbox.suspend();
    if (this.state === 'running') this.state = 'suspended';
    for (const c of this._children.values()) c.enqueueSystem({ kind: 'suspend' });

    if (this._parent) {
      this._parent.enqueueSystem({ kind: 'failure', cause, child: this.self, message });
    } else {
      // Root guardian failed — log and terminate the system.
      this.log.error(`Guardian ${this.path} failed; terminating system`, cause);
      this.enqueueSystem({ kind: 'terminate' });
    }
  }

  private async superviseChildFailure(
    cause: Error,
    childRef: ActorRef,
    message: unknown,
  ): Promise<void> {
    const child = this.findChildByRef(childRef);
    if (!child) return;

    const strategy: SupervisorStrategy = this.actor?.supervisorStrategy() ?? defaultStrategy;
    const directive = strategy.decider(cause);

    const affected = strategy.scope === 'all-for-one'
      ? Array.from(this._children.values())
      : [child];

    switch (directive) {
      case Directive.Resume:
        for (const c of affected) c.enqueueSystem({ kind: 'resume' });
        break;
      case Directive.Restart: {
        const withinLimit = this.registerRestart(strategy);
        if (!withinLimit) {
          this.log.warn(
            `Restart threshold exceeded (${strategy.maxRetries} in ${strategy.withinTimeRangeMs}ms) — stopping children`,
          );
          for (const c of affected) c.enqueueSystem({ kind: 'terminate' });
        } else {
          for (const c of affected) c.enqueueSystem({ kind: 'recreate', cause });
        }
        break;
      }
      case Directive.Stop:
        for (const c of affected) c.enqueueSystem({ kind: 'terminate' });
        break;
      case Directive.Escalate:
        this.failToParent(cause, message);
        break;
    }
  }

  private registerRestart(strategy: SupervisorStrategy): boolean {
    if (strategy.maxRetries < 0) return true;
    const now = Date.now();
    if (strategy.withinTimeRangeMs > 0) {
      const threshold = now - strategy.withinTimeRangeMs;
      this._failureTimes = this._failureTimes.filter(t => t >= threshold);
    }
    this._failureTimes.push(now);
    return this._failureTimes.length <= strategy.maxRetries + 1;
  }

  private findChildByRef(ref: ActorRef): ActorCell<any> | null {
    for (const c of this._children.values()) if (c.self.equals(ref)) return c;
    return null;
  }

  private async handleChildTerminated(childRef: ActorRef): Promise<void> {
    const key = childRef.path.name;
    if (this._children.has(key)) this._children.delete(key);
    // Any Terminated(childRef) owed to us was already delivered via the
    // child's watcher set in finalizeTermination — no double delivery here.

    if (this.state === 'terminating' && this._children.size === 0) {
      await this.finalizeTermination();
    }
  }

  /* ========================= Receive-timeout plumbing ======================= */

  private _resetReceiveTimer(): void {
    this._clearReceiveTimer();
    if (this._receiveTimeoutMs <= 0) return;
    this._receiveTimeoutHandle = setTimeout(() => {
      this.enqueueSystem({ kind: 'receiveTimeout' });
    }, this._receiveTimeoutMs);
  }

  private _clearReceiveTimer(): void {
    if (this._receiveTimeoutHandle) {
      clearTimeout(this._receiveTimeoutHandle);
      this._receiveTimeoutHandle = null;
    }
  }
}

/* ============================= Timer scheduler ============================ */

class CellTimerScheduler<TMessage> implements TimerScheduler<TMessage> {
  private readonly handles = new Map<string, Cancellable>();

  constructor(private readonly cell: ActorCell<TMessage>) {}

  startSingleTimer(key: string, message: TMessage, delayMs: number): void {
    this.cancel(key);
    const handle = this.cell.system.scheduler.scheduleOnce(
      delayMs, this.cell.self, message, null,
    );
    this.handles.set(key, handle);
  }

  startTimerWithFixedDelay(
    key: string,
    message: TMessage,
    intervalMs: number,
    initialDelayMs: number = intervalMs,
  ): void {
    this.cancel(key);
    const handle = this.cell.system.scheduler.scheduleAtFixedRate(
      initialDelayMs, intervalMs, this.cell.self, message, null,
    );
    this.handles.set(key, handle);
  }

  cancel(key: string): boolean {
    const h = this.handles.get(key);
    if (!h) return false;
    h.cancel();
    this.handles.delete(key);
    return true;
  }

  cancelAll(): void {
    for (const h of this.handles.values()) h.cancel();
    this.handles.clear();
  }

  isTimerActive(key: string): boolean {
    const h = this.handles.get(key);
    return !!h && !h.isCancelled;
  }

  activeKeys(): string[] {
    return Array.from(this.handles.keys());
  }
}
