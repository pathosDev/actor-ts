import type { Actor } from '../Actor.js';
import {
  type ActorContext,
  type Receive,
  type TimerScheduler,
  StashOutsideHandlerError,
  StashOverflowError,
} from '../ActorContext.js';
import { ActorPath } from '../ActorPath.js';
import { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { Logger } from '../Logger.js';
import type { Props } from '../Props.js';
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
import { LocalActorRef } from './LocalActorRef.js';
import type { SystemCommand } from './SystemCommand.js';
import type { Cancellable } from '../Scheduler.js';
import { match } from 'ts-pattern';
import { fromNullable, type Option } from '../util/Option.js';

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
export class ActorCell<TMsg = unknown> implements ActorContext<TMsg> {
  readonly self: LocalActorRef<TMsg>;
  readonly path: ActorPath;
  readonly log: Logger;

  private readonly mailbox: Mailbox<TMsg>;
  private actor: Actor<TMsg> | null = null;
  private _parent: ActorCell<unknown> | null;
  private _children = new Map<string, ActorCell<any>>();
  private _anonChildCounter = 0;
  private _childUidCounter = 0;

  private state: CellState = 'creating';
  private processing = false;
  private _currentSender: ActorRef | null = null;
  private behaviorStack: Array<Receive<TMsg>> = [];

  private _watchers = new Set<ActorRef>();
  private _watching = new Map<string, ActorRef>();

  private _failureTimes: number[] = [];

  private _receiveTimeoutMs = 0;
  private _receiveTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  /** Envelope currently being handed to the user — drives `context.stash()`. */
  private _currentEnvelope: Envelope<TMsg> | null = null;
  private _stashBuffer: Array<Envelope<TMsg>> = [];
  private readonly _stashCapacity: number = DEFAULT_STASH_CAPACITY;

  /** Per-actor timer scheduler. */
  readonly timers: TimerScheduler<TMsg> = new CellTimerScheduler<TMsg>(this);

  constructor(
    readonly system: ActorSystem,
    readonly props: Props<TMsg>,
    parent: ActorCell<unknown> | null,
    public readonly name: string,
  ) {
    this._parent = parent;
    const uid = parent ? parent._nextChildUid() : 0;
    this.path = parent
      ? parent.path.child(name, uid)
      : new ActorPath(name, null, system.name, uid);
    this.mailbox = props.config.mailbox ? props.config.mailbox() : new Mailbox<TMsg>();
    this.self = new LocalActorRef<TMsg>(this);
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

  actorOf<T>(props: Props<T>, name?: string): ActorRef<T> {
    if (this.state === 'terminated' || this.state === 'terminating') {
      throw new Error(`Cannot spawn children from terminated actor ${this.path}`);
    }
    const childName = name ?? `$${++this._anonChildCounter}`;
    if (this._children.has(childName)) {
      throw new Error(`Child name '${childName}' is not unique under ${this.path}`);
    }
    const cell = new ActorCell<T>(this.system, props, this as unknown as ActorCell<unknown>, childName);
    this._children.set(childName, cell);
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

  become(behavior: Receive<TMsg>, discardOld: boolean = true): void {
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

  /* ============================== Internal API ============================== */

  /** @internal */ isTerminated(): boolean { return this.state === 'terminated'; }
  /** @internal */ _nextChildUid(): number { return ++this._childUidCounter; }

  /** @internal */
  postUserMessage(message: TMsg, sender: ActorRef | null): void {
    if (this.state === 'terminated') {
      this.system.deadLetters.tell(new DeadLetter(message, sender, this.self));
      return;
    }
    this.mailbox.enqueue({ message, sender });
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
        if (env) await this.handleUserMessage(env);
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
        this.mailbox.enqueue({ message: new Terminated(c.target) as unknown as TMsg, sender: null });
      })
      .with({ kind: 'receiveTimeout' }, async () => {
        if (this.state === 'running') {
          await this.handleUserMessage({ message: ReceiveTimeout.instance as unknown as TMsg, sender: null });
        }
      })
      .exhaustive();
  }

  private async doCreate(): Promise<void> {
    try {
      const actor = this.props.config.factory();
      (actor as unknown as { _attach(ctx: ActorContext<TMsg>): void })._attach(this);
      this.actor = actor;
      this.behaviorStack = [(m: TMsg) => actor.onReceive(m)];
      this.state = 'running';
      await actor.preStart();
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
      (next as unknown as { _attach(ctx: ActorContext<TMsg>): void })._attach(this);
      this.actor = next;
      this.behaviorStack = [(m: TMsg) => next.onReceive(m)];
      await next.postRestart(cause);
      this.mailbox.resume();
      this.state = 'running';
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.failToParent(new ActorInitializationError(`Actor ${this.path} failed to restart`, err));
    }
  }

  private async handleUserMessage(env: Envelope<TMsg>): Promise<void> {
    const msg = env.message;

    if (msg === (PoisonPill.instance as unknown as TMsg)) {
      await this.doTerminate();
      return;
    }
    if (msg === (Kill.instance as unknown as TMsg)) {
      this.failToParent(new ActorKilledError(), msg);
      return;
    }

    this._currentSender = env.sender;
    this._currentEnvelope = env;
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
      await behavior(msg);
      this._resetReceiveTimer();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.failToParent(err, msg);
    } finally {
      this._currentSender = null;
      this._currentEnvelope = null;
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

class CellTimerScheduler<TMsg> implements TimerScheduler<TMsg> {
  private readonly handles = new Map<string, Cancellable>();

  constructor(private readonly cell: ActorCell<TMsg>) {}

  startSingleTimer(key: string, message: TMsg, delayMs: number): void {
    this.cancel(key);
    const handle = this.cell.system.scheduler.scheduleOnce(
      delayMs, this.cell.self, message, null,
    );
    this.handles.set(key, handle);
  }

  startTimerWithFixedDelay(
    key: string,
    message: TMsg,
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
