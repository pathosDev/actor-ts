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
import { ActorPath, assertUserAssignableName } from '../ActorPath.js';
import { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { Cluster } from '../cluster/Cluster.js';
import type { EntityContext } from '../EntityContext.js';
import { LogContext } from '../LogContext.js';
import type { Logger } from '../Logger.js';
import { MAILBOX_WAIT_BUCKETS_SECONDS } from '../metrics/Constants.js';
import type { MetricsRegistry } from '../metrics/Metrics.js';
import { metricsOf } from '../metrics/MetricsExtension.js';
import { NOOP_TRACER } from '../tracing/NoopTracer.js';
import type { Span, Tracer } from '../tracing/Tracer.js';
import type { ActorClassOrFactory } from '../Actor.js';
import type { ActorOptions } from '../ActorOptions.js';
import { actorBlueprintOf, type ActorBlueprint } from './ActorBlueprint.js';
import type { Behavior } from '../typed/Behavior.js';
import { typedActor } from '../typed/Spawn.js';
import {
  ActorInitializationError,
  defaultStrategy,
  Directive,
  type SupervisorStrategy,
} from '../Supervision.js';
import {
  ActorKilledError,
  ActorRestarted,
  ActorStarted,
  ActorStopped,
  DeadLetter,
  Kill,
  PoisonPill,
  ReceiveTimeout,
  Terminated,
} from '../SystemMessages.js';
import { Envelope, Mailbox, reportsDrops, type MailboxDropReason } from './Mailbox.js';
import {
  describeMessagePayload,
  describeMessageType,
  ExplainRecorder,
  type CellInspection,
  type CellState,
  type DispatchObserver,
  type MessageExplain,
  type MessageOutcome,
} from './Instrumentation.js';
import { BoundedMailbox } from '../mailbox/BoundedMailbox.js';
import { DEFAULT_MAILBOX_OVERFLOW } from '../ActorOptions.js';
import { DEFAULT_EXPLAIN_CAPACITY } from '../util/Constants.js';
import { DEFAULT_STASH_CAPACITY, MAILBOX_HIGH_WATER_MARK } from './Constants.js';
import { LocalActorRef } from './LocalActorRef.js';
import { DisplayNameLogger } from './DisplayNameLogger.js';
import type {
  ChildTerminatedCommand,
  FailureCommand,
  RecreateCommand,
  SystemCommand,
  WatchNotifyCommand,
} from './SystemCommand.js';
import type { Cancellable } from '../Scheduler.js';
import { match } from 'ts-pattern';
import { fromNullable, type Option } from '../util/Option.js';
import { randomId } from '../util/RandomString.js';
import { TokenBucket } from '../util/TokenBucket.js';

/**
 * Key a death-watch registration by incarnation, not by address.
 *
 * `ActorPath.toString()` is the canonical *address* and deliberately omits the
 * uid — location transparency depends on it staying stable across a restart.
 * Watch bookkeeping needs the opposite: a name that is re-spawned (a restarted
 * parent recreating a named child, a router pool rebuilding its routees) must
 * be a *different* subject, or the previous incarnation's pending `Terminated`
 * is delivered against its successor and the successor is never registered at
 * all, because the address is already in the map.
 */
function watchKeyOf(ref: ActorRef): string {
  return `${ref.path.toString()}#${ref.path.uid}`;
}

/**
 * Internal runtime for a single actor.  Bridges the user-visible Actor /
 * ActorContext API with the mailbox, dispatcher and supervision machinery.
 */
export class ActorCell<TMessage = unknown> implements ActorContext<TMessage> {
  readonly self: LocalActorRef<TMessage>;
  readonly path: ActorPath;
  readonly log: Logger;

  private readonly mailbox: Mailbox<TMessage>;
  /**
   * Queue depth that trips the next backlog warning; doubles after each one
   * so a genuinely runaway actor escalates instead of repeating.  See
   * {@link MAILBOX_HIGH_WATER_MARK}.
   */
  private _mailboxWarnAt = MAILBOX_HIGH_WATER_MARK;
  private actor: Actor<TMessage> | null = null;
  private _parent: ActorCell<unknown> | null;
  private _children = new Map<string, ActorCell<any>>();
  /**
   * A restart waiting for the outgoing instance's children to finish
   * stopping.  See {@link onRecreate} for why this cannot simply be awaited.
   */
  private _pendingRecreate: RecreateCommand | null = null;
  private _anonChildCounter = 0;
  private _childUidCounter = 0;

  private state: CellState = 'creating';
  private processing = false;
  private _currentSender: ActorRef | null = null;
  private behaviorStack: Array<Receive<TMessage>> = [];

  private _watchers = new Set<ActorRef>();
  private _watching = new Map<string, ActorRef>();
  /**
   * Per-registration replacement for the `Terminated` a death would otherwise
   * deliver — see {@link watchWith}.  Keyed like `_watching`, so a re-spawned
   * name is a distinct subject here too and cannot inherit the predecessor's
   * message.
   */
  private _watchWithMessages = new Map<string, TMessage>();

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

  /**
   * Recent-message recorder, `null` until `enableExplainPlan()`.
   * Its presence is also what turns on envelope timestamping, so an
   * actor nobody is inspecting pays nothing.
   */
  private _explain: ExplainRecorder | null = null;

  /**
   * Tooling actor — see `ActorOptionsType.internal`.  Inherited, so a
   * DevTools websocket connection spawned under the DevTools hub counts
   * as tooling without anyone having to say so twice.
   */
  readonly _internal: boolean;

  /**
   * Sharding identity when a `Shard` spawned this cell as an entity.
   *
   * Read off the blueprint, so it survives a restart for free — the cell
   * keeps the blueprint it was created with.  Unlike `_internal` it is deliberately
   * NOT inherited: an entity's children are not themselves entities.
   */
  private readonly _entity: EntityContext | null;

  /**
   * Display name set from outside the instance — seeded from the spawn
   * options and
   * rewritable through `setDisplayName`.  `null` means "nobody said", which
   * is what hands the question on to `Actor.displayName()`.
   */
  private _displayNameOverride: string | null;

  /**
   * Whether a failing `displayName()` has already been reported.  The hook
   * runs once per record, so without this one broken override would drown
   * the log in its own warning.  Reset on restart — a new instance earns a
   * new warning.
   */
  private _displayNameFailed = false;

  /** Per-actor timer scheduler. */
  readonly timers: TimerScheduler<TMessage> = new CellTimerScheduler<TMessage>(this);

  /**
   * @internal Child names to stop one after another instead of all at once,
   * each fully drained before the next is asked to stop.
   *
   * Set only on the root cell, to `GUARDIAN_SHUTDOWN_ORDER`.  `null`
   * everywhere else: for an ordinary actor, stopping every child
   * concurrently is both correct and faster — siblings are peers, and
   * nothing about being a child implies an ordering.  The guardians are the
   * exception because one of them exists to serve the other.
   */
  _terminationOrder: ReadonlyArray<string> | null = null;

  /** Cursor into {@link _terminationOrder} while terminating. */
  private _terminationGroupIndex = 0;

  /**
   * User messages {@link run} handles per dispatcher turn (#409).
   *
   * Resolved once, in the constructor, rather than read per turn: the two
   * layers behind it — the spawn options and the system's HOCON-resolved
   * default — are both fixed for the cell's lifetime, and this is read on the
   * hot path.  The blueprint outlives every restart, so a per-actor budget
   * survives one for free.
   */
  private readonly throughput: number;

  constructor(
    readonly system: ActorSystem,
    readonly blueprint: ActorBlueprint<TMessage>,
    parent: ActorCell<unknown> | null,
    public readonly name: string,
  ) {
    this._parent = parent;
    this._internal = blueprint.internal === true || parent?._internal === true;
    this._entity = blueprint.entity ?? null;
    this._displayNameOverride = blueprint.displayName ?? null;
    this.throughput = Math.max(1, blueprint.throughput ?? system._actorThroughput);
    const uid = parent ? parent._nextChildUid() : 0;
    this.path = parent
      ? parent.path.child(name, uid)
      : new ActorPath(name, null, system.name, uid);
    this.mailbox = this._createMailbox(blueprint);
    this.self = new LocalActorRef<TMessage>(this);
    // Resolved per record rather than bound here: the user's Actor does not
    // exist yet, and once it does its name may change (state, restart).
    this.log = new DisplayNameLogger(
      system.log.withSource(this.path.toString()),
      () => this._customDisplayName() ?? '',
    );
    this.enqueueSystem({ kind: 'create' });
  }

  /* ============================ ActorContext API ============================ */

  get sender(): Option<ActorRef> { return fromNullable(this._currentSender); }

  get parent(): Option<ActorRef> { return fromNullable(this._parent ? this._parent.self : null); }

  get children(): ReadonlyArray<ActorRef> {
    const out: ActorRef[] = [];
    for (const child of this._children.values()) out.push(child.self);
    return out;
  }

  get entity(): Option<EntityContext> { return fromNullable(this._entity); }

  /**
   * Read through to the system on every access rather than snapshotting
   * at construction: an actor can outlive the moment it was spawned in,
   * and a system that joins a cluster later (or rejoins after `leave()`)
   * must not leave already-running actors holding `None` or a dead
   * instance.
   */
  get cluster(): Option<Cluster> { return this.system.cluster; }

  setDisplayName(name: string): void {
    this._displayNameOverride = name;
  }

  /**
   * @internal What to call this actor, or `null` for "nothing beyond the
   * path".  Same precedence as `supervisorStrategy` below — an override
   * from outside the instance wins over what the instance says about
   * itself, because the spawn site (and a later `setDisplayName`) is the
   * more specific statement.
   *
   * The path is the floor, and a name equal to it collapses back to
   * `null`: the path is already the log source and already the DevTools
   * tooltip, so repeating it would be noise in both.
   *
   * Guarded here rather than at either call site, because both of them —
   * the logging path and the DevTools tick — would rather show a path
   * than propagate a user hook's failure.
   */
  _customDisplayName(): string | null {
    const name = this._displayNameOverride ?? this._displayNameFromActor();
    return name === null || name === '' || name === this.path.toString() ? null : name;
  }

  private _displayNameFromActor(): string | null {
    const actor = this.actor;
    if (actor === null) return null;
    try {
      const name = actor.displayName();
      return typeof name === 'string' ? name : null;
    } catch (e) {
      this._onDisplayNameFailed(e);
      return null;
    }
  }

  /**
   * Deliberately not through `this.log`: that logger asks the very hook
   * that just threw for its display name, so warning through it would
   * re-enter the failure it is reporting.
   */
  private _onDisplayNameFailed(error: unknown): void {
    if (this._displayNameFailed) return;
    this._displayNameFailed = true;
    this.system.log.withSource(this.path.toString())
      .warn('displayName() threw — falling back to the actor path', error);
  }

  spawn<T>(actor: ActorClassOrFactory<T>, name: string, options?: ActorOptions<T>): ActorRef<T> {
    return this._createChild(actorBlueprintOf(actor, options), name, 'caller');
  }

  spawnAnonymous<T>(actor: ActorClassOrFactory<T>, options?: ActorOptions<T>): ActorRef<T> {
    return this._createChild(actorBlueprintOf(actor, options), this._anonymousChildName(), 'generated');
  }

  spawnTyped<T>(behavior: Behavior<T>, name: string): ActorRef<T> {
    return this._createChild(actorBlueprintOf(typedActor<T>(behavior)), name, 'caller');
  }

  spawnTypedAnonymous<T>(behavior: Behavior<T>): ActorRef<T> {
    return this._createChild(
      actorBlueprintOf(typedActor<T>(behavior)), this._anonymousChildName(), 'generated',
    );
  }

  /**
   * @internal Name a child spawned without one.
   *
   * Was a bare `$${++counter}`.  That made `/user/$1` the first anonymous actor
   * of every run — and a path is an address, so anything that can render one can
   * send to it.  The random half closes that; the counter half stays because it
   * is the only thing keeping spawn order legible in a log line or a DevTools
   * row.
   *
   * Uniqueness only has to hold among one parent's live children, and that
   * includes across a restart: children are not stopped there (`Actor.preRestart`
   * only calls `postStop`), so `preStart` spawns again while the previous
   * incarnation's anonymous children are still in the child map.  The counter
   * survives with the cell and rules that out on its own; the random half is
   * belt-and-braces.
   *
   * The `exists` check (#1146) makes that argument checked rather than reasoned.
   * The counter is still what carries the guarantee, and the child map is the
   * very thing `_createChild` throws over one line later — so drawing against it
   * here costs one `Map.has` and turns a name clash from a crash the caller
   * cannot act on into an event that cannot happen.
   */
  private _anonymousChildName(): string {
    const prefix = `$anonymous-${++this._anonChildCounter}-`;
    return prefix + randomId(12, (suffix) => this._children.has(prefix + suffix));
  }

  /**
   * @internal — single child-creation path shared by spawn / spawnAnonymous.
   *
   * `nameSource` is spelled out at every call rather than defaulted, because it
   * decides whether the reserved-prefix rule applies: a name the caller chose
   * has to clear {@link assertUserAssignableName}, a name `_anonymousChildName`
   * produced is exactly what that rule reserves.  Making it a required argument
   * means a future spawn variant cannot quietly inherit the wrong answer.
   */
  private _createChild<T>(
    blueprint: ActorBlueprint<T>,
    name: string,
    nameSource: 'caller' | 'generated',
  ): ActorRef<T> {
    if (nameSource === 'caller') assertUserAssignableName(name, this.path);
    if (this.state === 'terminated' || this.state === 'terminating') {
      throw new Error(`Cannot spawn children from terminated actor ${this.path}`);
    }
    if (this._children.has(name)) {
      throw new Error(`Child name '${name}' is not unique under ${this.path}`);
    }
    const cell = new ActorCell<T>(this.system, blueprint, this as unknown as ActorCell<unknown>, name);
    this._children.set(name, cell);
    return cell.self;
  }

  child(name: string): Option<ActorRef> {
    const child = this._children.get(name);
    return fromNullable(child ? child.self : null);
  }

  /** @internal — used by ActorSelection to walk down the tree. */
  _findChildCell(name: string): ActorCell<unknown> | null {
    return this._children.get(name) ?? null;
  }

  /**
   * @internal Pending user messages, without building a whole snapshot.
   *
   * `_inspect()` already reports this number, but it allocates a full
   * `CellInspection` to do so — far too much for `smallestMailboxStrategy`,
   * which reads the depth of every routee on every routed message.  This is
   * the cheap read; `_inspect` reuses it so the two cannot drift apart.
   *
   * Deliberately *not* lifted onto `ActorRef` or `ActorContext`: mailbox depth
   * is a property of the runtime's queueing, and a public accessor would turn
   * it into a permanent API promise about a number callers would branch on.
   * Only code that lives inside the framework may look.
   */
  get mailboxSize(): number { return this.mailbox.size; }

  /**
   * @internal Has this cell run out of work it could still make progress on?
   *
   * The per-cell half of `ActorSystem.awaitQuiescence`, which is how a
   * draining `terminate()` decides that the application is finished (#663).
   *
   * Two terms, and the second one is the interesting one.  `processing` covers
   * the turn that is already in flight — it is set synchronously by
   * {@link schedule}, at `tell` time, so there is no window in which a message
   * has been handed over but neither sender nor receiver looks busy; that is
   * what makes the drain transitive across a ping-pong without any extra
   * bookkeeping.  {@link hasDispatchableWork} then answers for the queue, and
   * reusing it rather than asking `mailbox.hasUserMessages()` is deliberate:
   * it already encodes the two ways a queue can be *parked* rather than
   * pending.  A throttle-paused actor (#83) reports only its system queue, and
   * a suspended mailbox hides its user queue.  Neither will drain on its own
   * within any budget worth waiting for — a `qps: 10` bucket means shutdown
   * would run at ten messages a second — so the drain treats both as done and
   * lets the ordinary teardown dead-letter what is left.
   */
  _isQuiescent(): boolean {
    return !this.processing && !this.hasDispatchableWork();
  }

  /**
   * @internal Describe this cell for introspection tooling.
   *
   * A snapshot of what a debugger wants to show, taken from fields that
   * are otherwise private.  Deliberately separate from the public
   * `children` / `stashSize` accessors: those are the actor-facing API
   * and should not grow diagnostic surface.
   */
  _inspect(): CellInspection {
    return {
      path: this.path.toString(),
      parentPath: this._parent?.path.toString() ?? null,
      name: this.path.name,
      className: this.actor?.constructor.name ?? '?',
      displayName: this._customDisplayName(),
      cellState: this.state,
      mailboxSize: this.mailboxSize,
      stashSize: this._stashBuffer.length,
      suspended: this.mailbox.suspended,
      dispatcher: this.blueprint.dispatcher?.id ?? null,
      childCount: this._children.size,
      internal: this._internal,
    };
  }

  enableExplainPlan(options: { readonly capacity?: number } = {}): void {
    this._enableExplain(options.capacity ?? DEFAULT_EXPLAIN_CAPACITY);
  }

  disableExplainPlan(): void {
    this._disableExplain();
  }

  explainPlan(): ReadonlyArray<MessageExplain> {
    return this._explainEntries();
  }

  /**
   * @internal Start recording recent message handlings.  Re-enabling
   * with a different capacity starts a fresh ring.
   */
  _enableExplain(capacity: number): void {
    if (this._explain !== null && this._explain.capacity === capacity) return;
    this._explain = new ExplainRecorder(capacity);
  }

  /** @internal Stop recording and discard what was recorded. */
  _disableExplain(): void {
    this._explain = null;
  }

  /** @internal Recorded handlings, oldest first; empty when disabled. */
  _explainEntries(): ReadonlyArray<MessageExplain> {
    return this._explain?.snapshot() ?? [];
  }

  /** @internal Ring capacity, or `0` when recording is off. */
  _explainCapacity(): number {
    return this._explain?.capacity ?? 0;
  }

  /** @internal Report one completed handling to a running profiler. */
  private _observeDispatch(
    observer: DispatchObserver,
    env: Envelope<TMessage>,
    handleTimeMs: number,
    failure: Error | null,
  ): void {
    observer.onMessageProcessed({
      actorPath: this.path.toString(),
      className: this.actor?.constructor.name ?? '?',
      messageType: describeMessageType(env.message),
      handleTimeMs,
      outcome: failure !== null
        ? 'error'
        : this._currentEnvelope === null ? 'stashed' : 'ok',
    });
  }

  /** @internal Fold one completed handling into the ring. */
  private _recordExplain(
    env: Envelope<TMessage>,
    startedAtMs: number,
    handleTimeMs: number,
    failure: Error | null,
    span: Span | null,
  ): void {
    // `stash()` nulls the current envelope to mark the message as owned
    // by the stash — which is exactly how a stashed handling is told
    // apart from one that simply returned.
    const outcome: MessageOutcome = failure !== null
      ? 'error'
      : this._currentEnvelope === null ? 'stashed' : 'ok';
    this._explain?.record({
      atMs: startedAtMs,
      messageType: describeMessageType(env.message),
      senderPath: env.sender?.path.toString() ?? null,
      mailboxWaitMs: env.enqueuedAtMs === undefined ? null : startedAtMs - env.enqueuedAtMs,
      handleTimeMs,
      outcome,
      errorMessage: failure?.message ?? null,
      spanId: span?.context().spanId ?? null,
    });
  }

  /**
   * @internal The actor instance, or `null` before creation.
   *
   * For introspection that has to ask what KIND of actor this is —
   * the time-travel panel derives a replay fold from a live
   * `PersistentActor` this way.  Callers must not retain it: the
   * instance is replaced on every restart.
   */
  _actorForInspection(): Actor<TMessage> | null {
    return this.actor;
  }

  /**
   * @internal Iterate the child cells.
   *
   * `children` returns refs, which cannot be walked further — a tree
   * view needs the cells.  Callers must not retain them: a cell
   * outlives its usefulness the moment the actor terminates.
   */
  _eachChildCell(visit: (child: ActorCell<unknown>) => void): void {
    for (const child of this._children.values()) visit(child);
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
    const key = watchKeyOf(ref);
    // Last call wins, so watching plainly after a `watchWith` really does go
    // back to `Terminated` rather than silently keeping the older intent.
    this._watchWithMessages.delete(key);
    return this.registerWatch(ref, key);
  }

  watchWith(ref: ActorRef, message: TMessage): ActorRef {
    const key = watchKeyOf(ref);
    // Recorded before the registration, because `_addWatcher` on an
    // already-dead target answers immediately: the `Terminated` it enqueues
    // has to find the replacement already in place.
    this._watchWithMessages.set(key, message);
    return this.registerWatch(ref, key);
  }

  /**
   * The half `watch` and `watchWith` share: record the subject and, for a
   * local target, tell its cell to notify us.  Re-registering an existing
   * watch is deliberately a no-op here — only the message differs between the
   * two entry points, and each has already written it.
   */
  private registerWatch(ref: ActorRef, key: string): ActorRef {
    if (this._watching.has(key)) return ref;
    this._watching.set(key, ref);
    if (ref instanceof LocalActorRef) {
      ref.getCell()._addWatcher(this.self);
    }
    return ref;
  }

  unwatch(ref: ActorRef): ActorRef {
    const key = watchKeyOf(ref);
    this._watchWithMessages.delete(key);
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
    //
    // Marked as replayed on the way back in.  The stamp stays untouched — the
    // explain plan wants the whole arrival-to-handling span — but
    // `actor_mailbox_wait_seconds` has to be able to tell this population
    // apart, because that span includes stash residency the actor chose and
    // the aggregate has no outcome column to explain it with (see
    // `Envelope.replayed`).  Copying here rather than at `stash()` keeps the
    // marker at the moment it becomes true; either way it is a cold batch
    // path, not the per-message one.
    this.mailbox.prependUser(drained.map((env) => ({ ...env, replayed: true })));
    this.schedule();
  }

  get stashSize(): number { return this._stashBuffer.length; }

  /**
   * @internal The replay half of {@link unstashAll}, without the buffer half.
   *
   * The typed DSL's `Behaviors.withStash` cannot use `_stashBuffer`: its
   * capacity is declared per behavior where the cell's is one compiled-in
   * default for the whole actor, and `StashBuffer.stash(message)` parks an
   * arbitrary value where {@link stash} can only park the envelope currently
   * being handled.  So it keeps its own buffer — but the *replay* has to be
   * this one, or a stashed message loses its place to every message that
   * arrived after it was parked (#639).
   *
   * A terminated cell dead-letters instead of queueing, exactly as
   * {@link postUserMessage} does: prepending into a mailbox nobody will drain
   * again is a silent drop.
   *
   * The envelopes carry no sender — the typed buffer holds bare messages, so
   * there is none to carry — and no `enqueuedAtMs`, which matches
   * {@link unstashAll}: a replayed message is not re-stamped, so an explain
   * plan reports its mailbox wait as unknown rather than as a fresh arrival.
   */
  prependUserMessages(messages: ReadonlyArray<TMessage>): void {
    if (messages.length === 0) return;
    if (this.state === 'terminated') {
      for (const message of messages) {
        this.system.deadLetters.tell(new DeadLetter(message, null, this.self));
      }
      return;
    }
    this.mailbox.prependUser(messages.map((message) => ({ message, sender: null })));
    this.schedule();
  }

  /**
   * Send whatever the stash still holds to dead letters.
   *
   * The mailbox is drained on termination, but the stash is a separate
   * buffer, so anything parked there used to vanish without a trace on
   * both the stop and the restart path.  That is the worst shape a lost
   * message can take: a stashed message arrived *earlier* than everything
   * still queued — it is the one the sender is most likely waiting on —
   * and "I told an actor and nothing happened, anywhere" is unfalsifiable
   * from the outside.  Dead-lettering costs nothing and makes it visible.
   *
   * Drained before the mailbox on the stop path, so the dead-letter
   * stream keeps arrival order.
   */
  private deadLetterStash(): void {
    if (this._stashBuffer.length === 0) return;
    const drained = this._stashBuffer;
    this._stashBuffer = [];
    for (const env of drained) {
      this.system.deadLetters.tell(new DeadLetter(env.message, env.sender, this.self));
    }
  }

  /* ------------------------- Rate limiting (#83) ------------------------ */

  throttle(options: ThrottleOptions): void {
    this._throttleBucket = new TokenBucket({
      qps: options.qps,
      burst: options.burst,
      now: options.now,
    });
    this._throttleOnExcess = options.onExcess ?? 'pause';
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
    // and schedule a resume tick when tokens are due.  While the timer
    // is armed `hasDispatchableWork` reports the user queue as parked,
    // so no turn is dispatched for it until the timer clears the handle
    // (#1167).  System commands still get their turn; one of those will
    // re-dequeue and re-park this message, which is why the prepend
    // above and the already-armed check below both have to be idempotent.
    this.mailbox.prependUser([env]);
    if (this._throttleResumeTimer) return true; // already armed
    const waitMs = Math.max(1, this._throttleBucket.timeUntilNext(1));
    this._throttleResumeTimer = this.system.scheduler.scheduleOnceFunction(
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

  /**
   * The one door every user message goes through on its way into the queue.
   *
   * Single seam so the high-water check cannot be forgotten by a future
   * caller, and so the check stays out of `Mailbox` itself: the base class
   * imports only types today, and giving it a callback would mean giving it
   * an options family — a structural change to the framework's most
   * fundamental primitive, made in passing.  The cell already owns a logger,
   * a path and the enqueue funnel, so it is the cheaper place by every
   * measure.  Being the one door is also what makes it the right home for
   * the arrival stamp, for the reasons the body gives.
   *
   * Cost on the uninstrumented path is two field reads, one getter and two
   * compares — still less than the `BoundedMailbox.enqueue` bound check that
   * used to run here by default.
   */
  private _enqueueUser(env: Envelope<TMessage>): void {
    // Attach the arrival stamp here rather than at the two `post*` doors, so
    // there is exactly one answer to "when did this message arrive" — and so
    // the replay paths keep getting it right by construction: `unstashAll`
    // and `prependUserMessages` reach the queue through `mailbox.prependUser`
    // and never pass this way, which is what lets a replayed message keep
    // (or lack) the stamp it already has.
    //
    // Gated on a reader existing rather than unconditional, and the gate is
    // written so the uninstrumented path touches as little as possible: two
    // loads that both fail, and no clock read, no copy.  #411 measured
    // exactly these off the receive path for systems that instrument
    // nothing, which is the default, and an unconditional `Date.now()` here
    // cost ~7 % of ask throughput when it was tried.  The `enqueuedAtMs`
    // check sits *inside* the gate rather than in front of it for the same
    // reason — it only matters once something is reading stamps.
    //
    // A message already queued when metrics are switched on keeps its
    // missing stamp and is simply left out of the histogram: the same
    // transient the explain plan has always had, self-correcting within one
    // drain, and honest where inventing a wait would not be.
    let stamped = env;
    if (this._explain !== null || this.system._metricsRegistry !== null) {
      if (env.enqueuedAtMs === undefined) stamped = { ...env, enqueuedAtMs: Date.now() };
    }
    this.mailbox.enqueue(stamped);
    if (this.mailbox.size >= this._mailboxWarnAt) this._onMailboxHighWaterMark();
    this.schedule();
  }

  /** @internal */
  postUserMessage(message: TMessage, sender: ActorRef | null): void {
    if (this.state === 'terminated') {
      this.system.deadLetters.tell(new DeadLetter(message, sender, this.self));
      return;
    }
    this._enqueueUser({ message, sender });
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
    this._enqueueUser(env);
  }

  /** @internal */
  enqueueSystem(command: SystemCommand, sender: ActorRef | null = null): void {
    this.mailbox.enqueueSystem({ message: command, sender });
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
    if (!this.hasDispatchableWork()) return;
    this.processing = true;
    const dispatcher = this.blueprint.dispatcher ?? this.system.dispatcher;
    dispatcher.execute(() => this.runReported(dispatcher.id));
  }

  /**
   * Is there work a turn could actually make progress on?
   *
   * Plain `mailbox.hasMessages()` everywhere is what made `throttle('pause')`
   * spin (#1167).  A parked message is still *in* the mailbox, so every exit
   * path saw work, dispatched a turn, failed `tryConsume`, put the message
   * back and came straight round again — at full dispatcher frequency for the
   * whole wait window.  On the default `setImmediate` dispatcher that burns a
   * core but still resolves, because macrotask timers interleave; on
   * `MicrotaskDispatcher` it is a hard livelock, since the microtask queue
   * never drains and the timer phase is therefore never reached, so the
   * resume timer never fires at all.
   *
   * The armed resume timer *is* the paused flag — a separate boolean could
   * only drift out of step with it.  While it is armed the user queue is
   * deliberately parked and nothing there can make progress until the timer
   * clears it.
   *
   * System commands are never throttled, so they still earn a turn: without
   * this second half a throttled actor could not be stopped, suspended or
   * supervised until its pause elapsed, which would trade the spin for an
   * unresponsive lifecycle.
   */
  private hasDispatchableWork(): boolean {
    if (this._throttleResumeTimer) return this.mailbox.hasSystemMessages();
    return this.mailbox.hasMessages();
  }

  /**
   * `run()` with its failures attributed.
   *
   * The catch belongs here rather than in the dispatcher for two reasons.
   * It is the only layer that knows *whose* turn failed, so the report can
   * name an `ActorRef` like every other event on that bus does.  And it
   * covers dispatchers the system never sees: a per-actor
   * `ActorOptions.withDispatcher(…)` instance, or a third-party
   * implementation that reports failures its own way — both would
   * otherwise keep their turn's failure to themselves (#410).
   *
   * Nothing is rethrown: the dispatcher's own guard is the fallback for a
   * report that could not be made, not a second reporter.
   *
   * `.catch` rather than an `async` wrapper with a `try`, because this runs
   * once per message: `run()` is already `async` and so cannot throw
   * synchronously, and attaching a handler costs one derived promise where
   * a second async frame would cost that plus its state machine.
   */
  private runReported(dispatcherId: string): Promise<void> {
    return this.run().catch(
      (error: unknown) => this.system._reportDispatcherError(error, dispatcherId, this.self),
    );
  }

  /**
   * One dispatcher turn: up to {@link throughput} user messages, with the
   * system queue drained before each of them.
   *
   * The batch is what makes the budget mean anything (#409).  A cell may have
   * at most one unit queued on a dispatcher at a time — {@link schedule}
   * returns early while `processing` is set, and `processing` is cleared from
   * this method's `finally`, a microtask after the synchronous drain loop that
   * would have picked the cell up again has already found its queue empty.  So
   * before batching, every message cost a full scheduling round trip no matter
   * what any dispatcher's throughput was set to, and a *per-actor*
   * `ThroughputDispatcher` — the shape the tuning docs recommended — was the
   * one configuration where the batch was provably always exactly 1.
   *
   * Every loop condition below is a way the actor's situation can change
   * underneath a batch, and each one ends it rather than skipping an entry:
   *
   * - **system commands first, every iteration.**  They can suspend, restart
   *   or stop the actor, so re-draining between user messages is what keeps a
   *   long batch as responsive to lifecycle as an unbatched turn was.
   * - **`state !== 'running'`** covers a `PoisonPill` handled mid-batch, and
   *   `failToParent` flipping running -> suspended from inside a handler that
   *   threw.  Continuing would deliver messages to an actor its supervisor is
   *   still deciding about.
   * - **no envelope** means stop, not skip: `dequeueUser` also returns
   *   `undefined` for a *suspended* mailbox, which is full but parked.
   * - **an empty throttle bucket** breaks rather than continues, because
   *   `handleThrottleExcess` puts the envelope back at the head and arms the
   *   resume timer; looping would re-dequeue the message it just parked and
   *   spin the rest of the budget against a bucket that cannot refill until a
   *   later tick (#1167).
   */
  private async run(): Promise<void> {
    try {
      for (let handled = 0; handled < this.throughput; handled++) {
        // System messages always come first, and they can change the state.
        while (this.mailbox.hasSystemMessages()) {
          const systemEnvelope = this.mailbox.dequeueSystem()!;
          await this.handleSystemCommand(systemEnvelope.message as SystemCommand);
          if (this.state === 'terminated') return;
        }

        if (this.state !== 'running') break;
        const env = this.mailbox.dequeueUser();
        if (env === undefined) break;

        // Throttle gate (#83) — applies only to user messages, never
        // to system commands (those ran above and must stay
        // responsive for lifecycle / supervision / Terminated).
        if (this._throttleBucket && !this._throttleBucket.tryConsume(1)) {
          // 'pause' returns the message to the head of the mailbox and arms a
          // resume timer; 'drop' silently consumes it.  Either way this turn
          // runs no user handler and the batch is over.
          this.handleThrottleExcess(env);
          break;
        }
        await this.handleUserMessage(env);
      }
    } finally {
      this.processing = false;
      if (this.state !== 'terminated' && this.hasDispatchableWork()) {
        this.schedule();
      }
    }
  }

  private async handleSystemCommand(command: SystemCommand): Promise<void> {
    await match(command)
      .with({ kind: 'create' }, () => this.onCreate())
      .with({ kind: 'terminate' }, () => this.onTerminate())
      .with({ kind: 'recreate' }, (signal) => this.onRecreate(signal))
      .with({ kind: 'suspend' }, () => this.onSuspend())
      .with({ kind: 'resume' }, () => this.onResume())
      .with({ kind: 'failure' }, (signal) => this.onFailure(signal))
      .with({ kind: 'childTerminated' }, (signal) => this.onChildTerminated(signal))
      .with({ kind: 'watchNotify' }, (signal) => this.onWatchNotify(signal))
      .with({ kind: 'receiveTimeout' }, async () => this.onReceiveTimeout())
      .exhaustive();
  }

  /**
   * Suspend this cell and everything under it.
   *
   * The cascade is what makes {@link onResume} able to be symmetric.  A
   * failure suspends the failing actor's subtree so nothing in it processes
   * a message while the supervisor decides; the decision then has to be able
   * to undo exactly that, and it can only do so if both directions walk the
   * same tree (#635).
   */
  private onSuspend(): void {
    this.mailbox.suspend();
    if (this.state === 'running') this.state = 'suspended';
    for (const child of this._children.values()) child.enqueueSystem({ kind: 'suspend' });
  }

  /**
   * Resume this cell and everything under it.
   *
   * Resuming only this cell left the failed actor's children suspended for
   * good: `failToParent` suspends the subtree, but `Directive.Resume` only
   * ever reached the actor that failed.  Their mailboxes then filled and
   * nothing was ever processed again — no error, no dead letters, just a
   * silently dead branch of the tree (#635).
   */
  private onResume(): void {
    this.mailbox.resume();
    if (this.state === 'suspended') this.state = 'running';
    for (const child of this._children.values()) child.enqueueSystem({ kind: 'resume' });
  }

  private onWatchNotify(signal: WatchNotifyCommand): void {
    this._enqueueUser({ message: new Terminated(signal.target) as unknown as TMessage, sender: null });
  }

  private async onReceiveTimeout(): Promise<void> {
    if (this.state === 'running') {
      await this.handleUserMessage({ message: ReceiveTimeout.instance as unknown as TMessage, sender: null });
    }
  }

  private async onCreate(): Promise<void> {
    try {
      const actor = this.blueprint.factory();
      (actor as unknown as { _attach(context: ActorContext<TMessage>): void })._attach(this);
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
      this.system.eventStream.publish(
        new ActorStarted(this.self, actor.constructor.name, this._parent?.path.toString() ?? null),
      );
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.log.error('Actor initialization failed', err);
      this.failToParent(new ActorInitializationError(`Actor ${this.path} failed to start`, err));
    }
  }

  private async onTerminate(): Promise<void> {
    if (this.state === 'terminated' || this.state === 'terminating') return;
    this.state = 'terminating';
    this._clearReceiveTimer();

    if (this._terminationOrder) {
      await this.terminateNextGroup();
      return;
    }

    // Stop all children and wait for them
    const childRefs = Array.from(this._children.values());
    for (const child of childRefs) child.enqueueSystem({ kind: 'terminate' });
    // Children notify us via 'childTerminated'; we finish in finalizeTermination.
    if (this._children.size === 0) {
      await this.finalizeTermination();
    }
  }

  /**
   * Ask the next named child in {@link _terminationOrder} to stop, or finish
   * once every name is drained.
   *
   * Re-entered from `onChildTerminated`, which is what makes the teardown
   * sequential: one `terminate` goes out per round trip.  Names that have no
   * child are skipped rather than waited on, so an order listing a guardian
   * that was never created still completes.
   */
  private async terminateNextGroup(): Promise<void> {
    const order = this._terminationOrder ?? [];
    while (this._terminationGroupIndex < order.length) {
      const child = this._children.get(order[this._terminationGroupIndex]!);
      this._terminationGroupIndex++;
      if (child) {
        child.enqueueSystem({ kind: 'terminate' });
        return;
      }
    }
    // Every named child is gone.  Anything left is unordered — stop it now.
    for (const child of Array.from(this._children.values())) {
      child.enqueueSystem({ kind: 'terminate' });
    }
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

    // Drain the stash first — those messages arrived before anything still
    // queued, so this keeps the dead-letter stream in arrival order.
    this.deadLetterStash();

    // Drain any remaining user messages to dead letters
    for (const env of this.mailbox.drainUser()) {
      this.system.deadLetters.tell(new DeadLetter(env.message, env.sender, this.self));
    }

    this.state = 'terminated';

    // Drop this actor's event-stream subscriptions.  Nothing else did:
    // `unsubscribe` had exactly one caller in the whole framework, so a
    // subscriber that stopped stayed on the list forever — the list grew
    // without bound and every publish paid an O(N) walk that ended in a
    // dead letter per departed subscriber (#645).  Before the ActorStopped
    // publish below, so a stopping actor is not handed its own stop event.
    this.system.eventStream.unsubscribe(this.self);

    // Stock metric: count terminations (clean stop OR post-failure path).
    metricsOf(this.system).counter(
      'actor_terminated_total', {},
      { help: 'Cumulative count of actors that have been stopped.' },
    ).inc();
    this.system.eventStream.publish(new ActorStopped(this.self));

    // Notify watchers
    const term = new Terminated(this.self);
    for (const watcher of this._watchers) watcher.tell(term as never);
    this._watchers.clear();

    // Tell watched targets to drop us from their watcher set
    for (const watched of this._watching.values()) {
      if (watched instanceof LocalActorRef) watched.getCell()._removeWatcher(this.self);
    }
    this._watching.clear();
    this._watchWithMessages.clear();

    // Notify parent so it can remove us and run its own supervision hooks
    if (this._parent) {
      this._parent.enqueueSystem({ kind: 'childTerminated', child: this.self });
    } else {
      this.system._rootTerminated(this);
    }
  }

  private async onRecreate(signal: RecreateCommand): Promise<void> {
    const cause = signal.cause;
    if (!this.actor) return;

    // Timers and stash belong to the outgoing instance.  The stash cannot
    // carry over — the new instance has none of the state that made those
    // messages un-handleable — but it goes to dead letters rather than
    // being dropped, so a restart does not swallow them silently.
    this.timers.cancelAll();
    this.deadLetterStash();

    // Let the old instance clean up.  The default is `postStop()`.
    try {
      await this.actor.preRestart(cause);
    } catch (e) {
      this.log.error('preRestart threw', e);
    }

    // Tear the children down unless the actor opted out.  This lives here
    // rather than in `preRestart` because it has to be *awaited*: the new
    // instance cannot be built while the old children still hold their names,
    // and an override has no way to tell the cell it started something worth
    // waiting for (#634).
    if (this.actor.stopChildrenOnRestart() && this._children.size > 0) {
      for (const child of Array.from(this._children.values())) {
        child.enqueueSystem({ kind: 'terminate' });
      }
      // Children report back with `childTerminated`, which THIS loop
      // delivers — `run()` drains system messages one at a time and awaits
      // each, so awaiting them here would block the very message that would
      // unblock it.  Park instead; `onChildTerminated` resumes the restart
      // once the last one is gone.
      this._pendingRecreate = signal;
      return;
    }
    await this.completeRecreate(cause);
  }

  /**
   * Second half of a restart: everything that must happen after the outgoing
   * instance's children are gone.
   */
  private async completeRecreate(cause: Error): Promise<void> {
    // Build a new instance.
    try {
      const next = this.blueprint.factory();
      (next as unknown as { _attach(context: ActorContext<TMessage>): void })._attach(this);
      this.actor = next;
      // Fresh instance, fresh chance to name itself — and to be warned about.
      this._displayNameFailed = false;
      this.behaviorStack = [(m: TMessage) => next.onReceive(m)];
      await next.postRestart(cause);
      this.mailbox.resume();
      // `failToParent` suspended this cell's children along with it.  On the
      // stop-children path they are gone by now and this is a no-op; on the
      // `stopChildrenOnRestart() === false` path they are still here and still
      // suspended, and nothing else would ever resume them — the opt-out would
      // keep the child alive but frozen, with its mailbox filling.
      for (const child of this._children.values()) child.enqueueSystem({ kind: 'resume' });
      this.state = 'running';
      // Stock metric: count restarts.
      metricsOf(this.system).counter(
        'actor_restarted_total', {},
        { help: 'Cumulative count of supervisor-driven actor restarts.' },
      ).inc();
      this.system.eventStream.publish(new ActorRestarted(this.self, cause));
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.failToParent(new ActorInitializationError(`Actor ${this.path} failed to restart`, err));
    }
  }

  /**
   * The actor's queue.  Three shapes, in precedence order:
   *
   *   1. `withMailbox(...)` — the caller owns the whole queue, bound and
   *      policy included.
   *   2. `withMailboxCapacity(n)` — a `BoundedMailbox`.  The only place the
   *      framework picks an overflow policy on a caller's behalf.
   *   3. Nothing — the unbounded base `Mailbox`.  #310 made bounded the
   *      default and #1148 reversed it: a ceiling that discards the oldest
   *      queued message is not one an actor framework can impose unasked,
   *      because the envelope it evicts is as likely to be a `Terminated`
   *      (#729) or a delivery confirmation (#732) as it is to be telemetry.
   *      The heap is the ceiling now, and drawing a lower one is the
   *      caller's decision.  Growth is not silent: the cell warns at
   *      `MAILBOX_HIGH_WATER_MARK` and again at each doubling.
   *
   * Drop reporting is wired *after* the choice rather than inside it, so all
   * three shapes get it on one line.  Wiring it at the construction site is
   * what made shape 1 invisible to `actor_mailbox_dropped_total` (#1149): the
   * cell can only pass `onDrop` into a mailbox it builds itself, and shape 1
   * is by definition one it did not.
   *
   * Takes `blueprint` as a parameter rather than reading `this.blueprint`:
   * the call sits in the constructor body, and whether the parameter
   * property is assigned by then depends on the emit order for parameter
   * properties versus field initializers.  Passing it makes the question
   * moot.
   */
  private _createMailbox(blueprint: ActorBlueprint<TMessage>): Mailbox<TMessage> {
    const mailbox = this._buildMailbox(blueprint);
    if (reportsDrops(mailbox)) mailbox.observeDrops((reason) => this._onMailboxDrop(reason));
    return mailbox;
  }

  /** The queue itself — see {@link _createMailbox} for the three shapes. */
  private _buildMailbox(blueprint: ActorBlueprint<TMessage>): Mailbox<TMessage> {
    if (blueprint.mailbox) return blueprint.mailbox();
    if (blueprint.mailboxCapacity === undefined) return new Mailbox<TMessage>();
    return new BoundedMailbox<TMessage>({
      capacity: blueprint.mailboxCapacity,
      overflow: blueprint.mailboxOverflow ?? DEFAULT_MAILBOX_OVERFLOW,
    });
  }

  /**
   * The mailbox has crossed its next warning threshold.  Since #1148 removed
   * the default bound, this is the framework's only unconditional signal
   * that an actor is losing to its producers — it fires whether or not
   * metrics are enabled, because a backlog heading for an OOM should not
   * require an observability stack to notice.
   *
   * A bounded mailbox whose capacity sits below the mark never reaches it,
   * which is correct: it already has a ceiling and reports its drops.
   */
  private _onMailboxHighWaterMark(): void {
    const depth = this.mailbox.size;
    this.log.warn(
      `mailbox depth ${depth} — this actor is falling behind its producers; `
      + 'bound it with ActorOptions.withMailboxCapacity(...) or slow the senders',
    );
    this._mailboxWarnAt = depth * 2;
  }

  /**
   * Observer registered on any mailbox that reports its drops — fires once
   * per discarded message.  Increments `actor_mailbox_dropped_total` with
   * labels {class, reason} so operators can spot slow-consumer signals on
   * the standard observability stack.  Cheap when metrics are disabled (the
   * noop registry's counter is a single object lookup).
   *
   * **There is deliberately no `path` label** (#658, #745).  It answered a
   * question operators genuinely ask — *which* actor is shedding — but it
   * was the one stock label whose values the framework derived per instance
   * instead of the deployment declaring them: under sharding a path is
   * `entity-<entityId>`, i.e. chosen by whoever addresses the shard region,
   * and `spawnAnonymous` mints a fresh one per spawn forever.  Shedding is
   * a bounded mailbox's *designed* behaviour rather than an anomaly, so
   * every such actor minted a permanent series — the registry has no
   * per-child eviction — in a system doing nothing wrong.  `class` is a
   * source-code constant and `reason` a closed pair, so the family is now
   * bounded by the program instead of by its traffic.
   *
   * Per-actor drop counts did not disappear, they moved to where the
   * cardinality budget belongs: `observeDrops` appends rather than assigns,
   * so a caller's own `onDrop` still fires alongside this observer and can
   * mint a path-labelled series they have sized their own monitoring for.
   */
  private _onMailboxDrop(reason: MailboxDropReason): void {
    const className = this.actor?.constructor.name ?? 'unknown';
    metricsOf(this.system).counter(
      'actor_mailbox_dropped_total',
      { class: className, reason },
      { help: 'Cumulative count of user messages a mailbox discarded rather than queued.' },
    ).inc();
  }

  private async handleUserMessage(env: Envelope<TMessage>): Promise<void> {
    const message = env.message;

    if (message === (PoisonPill.instance as unknown as TMessage)) {
      await this.onTerminate();
      return;
    }
    if (message === (Kill.instance as unknown as TMessage)) {
      this.failToParent(new ActorKilledError(), message);
      return;
    }

    // Both instrumentation handles are read straight off the system rather
    // than through `metricsOf` / `tracerOf`, which walk the extension chain —
    // four such lookups per message is what #411 removes.  Read here, once,
    // and passed down: re-reading them inside the dispatch would reintroduce
    // the cost, and caching them on the cell would break the runtime swap
    // (DevTools installs and removes both while cells are draining).
    const metrics = this.system._metricsRegistry;
    // `null` is not "use the noop" here — it is "do not build the arguments".
    // The two literals below are the whole per-message metric allocation, and
    // they were being built at the call site for a noop that discards them.
    if (metrics !== null) {
      metrics.counter(
        'actor_messages_delivered_total', {},
        { help: 'Cumulative count of user messages delivered to actor onReceive.' },
      ).inc();
      // How long this message sat in the queue before its turn — the
      // companion to `actor_message_handler_seconds`, which measures only
      // what happens after.  A slow actor and a busy one look identical in
      // the handler histogram; they differ here.
      //
      // Two populations are skipped rather than mismeasured.  An envelope
      // with no stamp was queued before anything was reading stamps (metrics
      // switched on mid-flight, or a `prependUserMessages` replay), and a
      // replayed one carries the stamp of an arrival that predates its
      // current residency — see `Envelope.replayed`.  `Math.max` guards the
      // clock going backwards under an NTP step, which would otherwise put a
      // negative number into the histogram's sum and make the derived
      // average nonsense long after the correction.
      if (env.enqueuedAtMs !== undefined && env.replayed !== true) {
        metrics.histogram(
          'actor_mailbox_wait_seconds', {},
          {
            help: 'Time user messages spent queued in a mailbox before delivery, seconds.',
            buckets: MAILBOX_WAIT_BUCKETS_SECONDS,
          },
        ).observe(Math.max(0, Date.now() - env.enqueuedAtMs) / 1000);
      }
    }

    // The tracer DOES fall back to the noop rather than being skipped: an
    // envelope can arrive from a peer that traces while this node does not,
    // and `startSpan` returning `NOOP_SPAN` is what keeps that message's
    // explain entry the shape it has always been.
    const tracer = this.system._tracer ?? NOOP_TRACER;
    // Open a server-kind `actor.receive` span when tracing is enabled
    // and either we have a parent in the envelope or we're starting a
    // root.  Span is the "active" one for the duration of `behavior(message)`
    // so child tells from inside the handler get this span as parent.
    //
    // Lazily started once we know tracing is enabled and the envelope is an
    // "interesting" message (skip Terminated etc?  Spans for
    // system-message-shaped envelopes are still useful — the path is what
    // matters).  `null` parent → root span; envelope-supplied SpanContext →
    // child of the originating tell.
    //
    // A tooling actor is never part of the application's trace — not as a
    // root and not as a child.  Excluding it only from roots was not enough:
    // DevTools' probes receive event-stream publishes *during* an application
    // message, so they inherited its trace and reappeared in the middle of
    // the route.
    //
    // The `_traceRootSpans` read used to be justified in a comment claiming it
    // "costs one boolean instead of walking the extension chain".  It did the
    // opposite: `||` short-circuits on a *truthy* operand, so on the ordinary
    // path — no `env.trace`, no root recording — both earlier terms are falsy
    // and the third one ran, resolving the tracing extension a second time for
    // every message (#411).  With `tracer` already in hand it is now a method
    // call on an object we hold, and the noop's `activeSpan()` returns `null`
    // without doing anything.
    let span: Span | null = null;
    if (!this._internal && (env.trace || this.system._traceRootSpans || tracer.activeSpan())) {
      // The sender and the payload are what turn a flame graph into a
      // readable message trail; the payload only when something is
      // watching, since serialising every message is not free.
      const attributes: Record<string, string> = {
        'actor.path': this.path.toString(),
        'actor.message.type': describeMessageType(message),
        'actor.sender': env.sender?.path.toString() ?? '',
      };
      if (this.system._traceMessagePayloads) {
        const payload = describeMessagePayload(message);
        if (payload !== null) attributes['actor.message.payload'] = payload;
      }
      span = tracer.startSpan('actor.receive', {
        parent: env.trace ?? undefined,
        kind: 'consumer',
        attributes,
      });
    }

    // Establish the MDC scope for the duration of `behavior(message)`.  Any
    // `tell`s issued from inside the handler snapshot this same context
    // (LocalActorRef + RemoteActorRef both read `LogContext.get()`), so the
    // trail propagates downstream without manual plumbing.  An empty context
    // skips the wrapper entirely — and skips the only closure on this path,
    // since `LogContext.run` needs a thunk and `_dispatchToBehavior` does not
    // (#411).
    if (env.context) {
      await LogContext.run(env.context, () => this._dispatchToBehavior(env, span, tracer, metrics));
    } else {
      await this._dispatchToBehavior(env, span, tracer, metrics);
    }
  }

  /**
   * Run the current behavior over one envelope, with the instrumentation the
   * caller already resolved.
   *
   * A private method rather than the closure it used to be, because a closure
   * is allocated per message and this one captured six variables (#411).  The
   * arguments are the same six, passed rather than captured — which costs
   * nothing, since arguments live on the stack while a closure's environment
   * lives on the heap.  It stays a separate method rather than being inlined
   * into {@link handleUserMessage} because the MDC branch needs to be able to
   * call it through `LogContext.run`.
   */
  private async _dispatchToBehavior(
    env: Envelope<TMessage>,
    span: Span | null,
    tracer: Tracer,
    metrics: MetricsRegistry | null,
  ): Promise<void> {
    const message = env.message;
    this._currentSender = env.sender;
    this._currentEnvelope = env;
    const startNs = performance.now();
    // Wall clock at the start — read only when a recorder is already on, so
    // the uninstrumented message still pays no `Date.now()` here (#411).
    //
    // #411 dropped the read outright and rebuilt the stamp in the `finally`
    // as `Date.now() - elapsedMs`.  That subtraction cannot be exact: the end
    // read floors to whole milliseconds while `elapsedMs` is fractional, so
    // the result sits up to 1 ms BEFORE the handling really began — always in
    // that direction, since truncation is one-sided.  Invisible in `atMs`
    // alone and fatal one field over, because `mailboxWaitMs` subtracts an
    // integral `enqueuedAtMs` from it: an idle actor, whose true wait is
    // microseconds, reported a negative wait for all but a handful of its
    // messages, and stamps ran backwards through a ring the panel sorts by
    // them.
    //
    // So the read comes back, gated on its only reader rather than
    // unconditional — which is what #411 was actually measuring.
    const recording = this._explain !== null;
    const startedAtMs = recording ? Date.now() : 0;
    let failure: Error | null = null;
    // What the behavior actually sees.  Differs from `message` only for a
    // `watchWith` registration, which swaps the signal for the watcher's
    // own domain message just below.
    let delivered = message;
    try {
      if (message instanceof Terminated) {
        // Only deliver when we are actually watching.
        const key = watchKeyOf(message.actor);
        if (!this._watching.has(key)) {
          this._currentSender = null;
          this._currentEnvelope = null;
          return;
        }
        this._watching.delete(key);
        // The substitution belongs on the watcher, not on the dying cell:
        // that one notifies through `_watchers`, a set of *refs*, and has no
        // way to reach the per-watcher map.  Doing it here also covers the
        // immediate `Terminated` that `_addWatcher` sends when the target is
        // already gone, because `watchWith` records the message before it
        // registers.  The envelope keeps the original signal, so a trace or
        // an explain plan still shows the death that caused this dispatch.
        if (this._watchWithMessages.has(key)) {
          delivered = this._watchWithMessages.get(key) as TMessage;
          this._watchWithMessages.delete(key);
        }
      }
      const behavior = this.behaviorStack[this.behaviorStack.length - 1];
      if (span) {
        await tracer.withActiveSpan(span, () => behavior(delivered));
      } else {
        await behavior(delivered);
      }
      this._resetReceiveTimer();
      if (span) span.setStatus('ok');
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      failure = err;
      if (span) {
        span.recordException(err);
        span.setStatus('error', err.message);
      }
      // The message supervision is told about is the one the handler
      // actually choked on — under `watchWith` that is the domain message,
      // not the `Terminated` it replaced.
      this.failToParent(err, delivered);
    } finally {
      if (span) span.end();
      const elapsedMs = performance.now() - startNs;
      // Record handler duration in seconds — Prom convention.  Skipped
      // entirely, not sent to a noop, so the two literals are not built for
      // a call that discards them (#411).
      if (metrics !== null) {
        metrics.histogram(
          'actor_message_handler_seconds', {},
          { help: 'Time spent inside actor onReceive handlers, seconds.' },
        ).observe(elapsedMs / 1000);
      }
      // One null check on the hot path; the recorder only exists
      // while somebody is inspecting this actor.
      //
      // The stamp taken on the way in is used whenever there was one.  It is
      // missing for exactly one message — the one whose handler switched the
      // recorder on, so `recording` was false at the top and true here — and
      // for that one the end read minus the duration is the only estimate
      // available.  `Math.ceil` undoes its bias rather than leaving it: the
      // error is known to lie in [0, 1) ms and to be one-directional, so
      // rounding up lands on the millisecond the clock would have shown at
      // the start, or the one after, and never on the one before.  That is
      // what keeps `mailboxWaitMs` from going negative here too.
      if (this._explain !== null) {
        this._recordExplain(
          env,
          recording ? startedAtMs : Math.ceil(Date.now() - elapsedMs),
          elapsedMs,
          failure,
          span,
        );
      }
      // A second null check, for the whole-system profiler (#226).
      // Reading the field directly avoids an extension lookup per
      // message.
      const observer = this.system._dispatchObserver;
      if (observer !== null) this._observeDispatch(observer, env, elapsedMs, failure);
      this._currentSender = null;
      this._currentEnvelope = null;
    }
  }

  /* =============================== Supervision ============================== */

  private failToParent(cause: Error, message?: unknown): void {
    this.mailbox.suspend();
    if (this.state === 'running') this.state = 'suspended';
    for (const child of this._children.values()) child.enqueueSystem({ kind: 'suspend' });

    if (this._parent) {
      this._parent.enqueueSystem({ kind: 'failure', cause, child: this.self, message });
    } else {
      // Root guardian failed — log and terminate the system.
      this.log.error(`Guardian ${this.path} failed; terminating system`, cause);
      this.enqueueSystem({ kind: 'terminate' });
    }
  }

  private async onFailure(signal: FailureCommand): Promise<void> {
    const cause = signal.cause;
    const childRef = signal.child;
    const message = signal.message;
    const child = this.findChildByRef(childRef);
    if (!child) return;

    // The failing child's own options win, then this actor's strategy, then
    // the framework default.  `withSupervisorStrategy` states how *that*
    // actor is supervised, so it has to be read here, on the parent — the
    // child never gets to answer for its own failure.
    //
    // Two consequences of expressing a per-child override through
    // parent-side machinery, both deliberate: an `all-for-one` strategy in a
    // child's options still widens to every sibling, and the restart budget in
    // `registerRestart` stays per-parent, so siblings share one allowance.
    const strategy: SupervisorStrategy =
      child.blueprint.supervisorStrategy
      ?? this.actor?.supervisorStrategy()
      ?? defaultStrategy;
    const directive = strategy.decider(cause);

    const affected = strategy.scope === 'all-for-one'
      ? Array.from(this._children.values())
      : [child];

    switch (directive) {
      case Directive.Resume:
        for (const child of affected) child.enqueueSystem({ kind: 'resume' });
        break;
      case Directive.Restart: {
        const withinLimit = this.registerRestart(strategy);
        if (!withinLimit) {
          this.log.warn(
            `Restart threshold exceeded (${strategy.maxRetries} in ${strategy.withinTimeRangeMs}ms) — stopping children`,
          );
          for (const child of affected) child.enqueueSystem({ kind: 'terminate' });
        } else {
          for (const child of affected) child.enqueueSystem({ kind: 'recreate', cause });
        }
        break;
      }
      case Directive.Stop:
        for (const child of affected) child.enqueueSystem({ kind: 'terminate' });
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
    for (const child of this._children.values()) if (child.self.equals(ref)) return child;
    return null;
  }

  private async onChildTerminated(signal: ChildTerminatedCommand): Promise<void> {
    const childRef = signal.child;
    const key = childRef.path.name;
    if (this._children.has(key)) this._children.delete(key);
    // Any Terminated(childRef) owed to us was already delivered via the
    // child's watcher set in finalizeTermination — no double delivery here.

    // A restart parked here waiting for exactly this.  Checked before the
    // `terminating` guard below: a restarting cell is `restarting`, not
    // `terminating`, so the guard would return first and the restart would
    // never resume.
    if (this._pendingRecreate !== null && this._children.size === 0) {
      const parked = this._pendingRecreate;
      this._pendingRecreate = null;
      // A `terminate` that arrived while the restart was parked wins.  Both
      // halves of that matter: rebuilding here revives an actor that has been
      // ordered to stop, and — because `onTerminate` returns early on a cell
      // that is already `terminating` — the final stop then becomes a no-op,
      // so `finalizeTermination` never runs and `terminate()` never settles.
      if (this.state !== 'terminating' && this.state !== 'terminated') {
        await this.completeRecreate(parked.cause);
        return;
      }
    }

    if (this.state !== 'terminating') return;
    if (this._terminationOrder) {
      await this.terminateNextGroup();
      return;
    }
    if (this._children.size === 0) {
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
    const handle = this.handles.get(key);
    if (!handle) return false;
    this.handles.delete(key);
    // The handle's own answer, not `true` unconditionally: a one-shot that
    // already fired has nothing left to cancel, and reporting otherwise made
    // "did I get there in time?" unanswerable (#642).
    return handle.cancel();
  }

  cancelAll(): void {
    for (const handle of this.handles.values()) handle.cancel();
    this.handles.clear();
  }

  isTimerActive(key: string): boolean {
    this.pruneSettled();
    return this.handles.has(key);
  }

  activeKeys(): string[] {
    this.pruneSettled();
    return Array.from(this.handles.keys());
  }

  /**
   * Drop handles whose schedule is over.
   *
   * A fired one-shot leaves its entry behind — nothing calls back into this
   * map when a timer runs — so `activeKeys()` listed timers that were long
   * gone and, for an actor that cycles through timer keys, the map grew for
   * the life of the actor.  Pruning on read rather than on a timer callback
   * keeps the scheduler unaware of its callers; the map is small and these
   * are not hot paths.
   */
  private pruneSettled(): void {
    for (const [key, handle] of this.handles) {
      if (handle.isCancelled) this.handles.delete(key);
    }
  }
}
