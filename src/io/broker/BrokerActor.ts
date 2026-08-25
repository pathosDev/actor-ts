import { match } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Config } from '../../config/Config.js';
import { CoordinatedShutdownId, Phases } from '../../CoordinatedShutdown.js';
import { Terminated } from '../../SystemMessages.js';
import { BidirectionalMultiMap } from '../../util/BidirectionalMultiMap.js';
import type { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { OptionsValidator } from '../../util/OptionsValidator.js';
import {
  BrokerBufferOverflow,
  BrokerConnected,
  BrokerDisconnected,
  BrokerNotConnected,
  BrokerReconnectAttempt,
  BrokerReconnectFailed,
} from './BrokerEvents.js';
import {
  BrokerOptionsError,
  DEFAULT_OUTBOUND_BUFFER,
  DEFAULT_RECONNECT,
  readCommonOptions,
  type BrokerCommonOptionsType,
} from './BrokerOptions.js';
import { mergeOptions } from '../../util/OptionsMerge.js';

/**
 * Connection-lifecycle state machine.  Transitions are linear:
 *   disconnected → connecting → connected → disconnecting → disconnected
 *
 * Reconnect after failure goes `connected → disconnected → connecting → …`
 * with backoff between attempts.  Aktor-Stop terminates from any state
 * via `disconnecting → disconnected`.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting';

/**
 * Outbound envelope queued by the base class.  Subclass `dispatchOutgoing`
 * receives one of these when the connection is up.  The `payload` is
 * intentionally `unknown` — broker-specific outbound types are layered
 * on top by the subclass (e.g. MQTT publishes carry topic+QoS+retain).
 */
export type OutboundEnvelope<P = unknown> = {
  readonly payload: P;
  /** Wall-clock when the message was enqueued.  Useful for TTL evictions. */
  readonly enqueuedAt: number;
};

/**
 * Base class for actors that bridge external messaging systems
 * (MQTT, WebSocket, Kafka, …) into the actor system.  Subclasses
 * implement three protocol hooks (`connectImplementation`, `disconnectImplementation`,
 * `dispatchOutgoing`) plus `onCommand`; the base class owns the lifecycle,
 * reconnect-backoff, outbound buffer, subscriber fan-out, and lifecycle-event
 * publishing.
 *
 * **`onReceive` is sealed here** — a subclass implements {@link onCommand}
 * instead, and gets `Terminated` interception for free.  See {@link onReceive}
 * for what that buys and why the rename was worth a breaking change.
 *
 * **Options precedence (highest first):**
 *   1. Constructor argument (per-instance overrides).
 *   2. HOCON config under `configKey()` (system-wide defaults).
 *   3. Built-in defaults from `builtInDefaultOptions()`.
 *
 * Subclasses pass their constructor options via `super(options)` and
 * implement `configKey()`, `builtInDefaultOptions()`, `readOptionsFromConfig()`,
 * and `requiredOptions()` so the base class can resolve and validate
 * the effective options before `connectImplementation()` runs.
 *
 * **Desired subscriptions.**  A protocol whose consumers are named at
 * runtime (`{ kind: 'subscribe', … }`) records them with
 * {@link rememberSubscription} and re-establishes them from
 * {@link applyDesiredSubscriptions} inside its `connectImplementation`.
 * The desired set is connection-independent, which is what makes a
 * runtime subscription survive a reconnect and a subscribe issued
 * during an outage land on the next connect.  `Subscription` is the
 * subclass's per-key restore payload (defaults to `never` for
 * protocols that have no such concept).
 */
export abstract class BrokerActor<
  S extends BrokerCommonOptionsType,
  Command = unknown,
  P = unknown,
  Subscription = never,
> extends Actor<Command> {
  /** Constructor options — partial; merged with HOCON + defaults in preStart. */
  private readonly _ctorOptions: Partial<S>;
  /** Final, fully resolved options.  `null` until preStart() ran. */
  private _options: S | null = null;

  private _state: ConnectionState = 'disconnected';
  private _outboundBuffer: OutboundEnvelope<P>[] = [];

  /**
   * Which subscribers each topic has, and which topics each subscriber holds
   * — one object owning both directions (#1037).  The reverse direction is
   * what {@link pruneTerminatedSubscriber} needs: `Terminated` carries only a
   * ref, and finding its topics by scanning every one would be O(topics).
   *
   * Keyed by **path string**, not by ref identity.  The reverse leg used to be
   * a `WeakMap` keyed on the ref object, which could not have worked on the
   * death-watch path it was written for: `Terminated` carries the cell's own
   * `self` ref, which need not be the object that subscribed.  Nor was it
   * weak in any useful sense — its keys were the same refs `_subscribers`
   * held strongly, so nothing was ever collectable while it mattered.
   */
  private readonly _subscriptions = new BidirectionalMultiMap<string, string>(); // topic ↔ subscriber path
  /** The ref behind each subscriber path — the fan-out target and the unwatch handle. */
  private readonly _subscriberRefs = new Map<string, ActorRef<unknown>>();

  /**
   * Subscriptions the actor *wants*, keyed by protocol identifier
   * (subject / topic / stream).  Independent of any one connection —
   * see {@link rememberSubscription}.
   */
  private readonly _desiredSubscriptions = new Map<string, Subscription>();
  /**
   * Whether {@link initialSubscriptions} has been folded in.  Seeding is
   * once-only: a runtime `unsubscribe` of a configured subscription must
   * not be resurrected by the next reconnect.
   */
  private _subscriptionsSeeded = false;
  /**
   * Whether {@link applyDesiredSubscriptions} has run for the *current*
   * connection — i.e. whether the subclass has something to apply a new
   * subscription to.  Reset on teardown.
   */
  private _subscriptionsApplied = false;

  /**
   * True between entering `connectImplementation` and completing
   * `disconnectImplementation`.  Tracked separately from `_state`
   * because a dropped connection leaves transport state behind while
   * the state machine already reads `disconnected`.
   */
  private _transportOpened = false;
  /** Name of this actor's `service-stop` task; `null` when none is registered. */
  private _shutdownTaskName: string | null = null;

  /**
   * Whether `postStop` has begun — i.e. whether this instance is still
   * allowed to hold a connection.
   *
   * A reconnect attempt runs on the *system* scheduler, detached from the
   * mailbox (see {@link _scheduleReconnect}), so it can resume from its own
   * `await` after the actor has terminated.  `postStop`'s cancel cannot stop
   * one that has already begun: `Scheduler` settles a one-shot handle
   * *before* invoking it, so `cancel()` is a no-op by then.  Without this
   * flag the resumed attempt adopted the connection it had just opened —
   * `_state = 'connected'` and a live driver handle on an actor whose
   * `postStop` had returned — or, on the failure path, re-armed the backoff
   * timer and kept reconnecting forever, since `maxAttempts` defaults to
   * `Number.POSITIVE_INFINITY` (#708).
   */
  private _stopped = false;

  /** Reconnect bookkeeping for the current cycle (since the last successful connect). */
  private _reconnectAttempt = 0;

  /**
   * Read-idle bookkeeping for the current connection (#753).
   *
   * `_idleTimeoutMs` is `0` whenever no deadline is armed, which makes it the
   * single flag the timer callback checks — a stale wake-up that outran its
   * cancel cannot then take a live connection down.  `_lastInboundAt` is
   * refreshed by {@link noteInboundActivity} and read only when the timer
   * fires; see there for why the hot path writes a timestamp instead of
   * re-arming.
   */
  private _idleTimeoutCancel: (() => void) | null = null;
  private _idleTimeoutMs = 0;
  private _lastInboundAt = 0;

  /** Circuit-breaker counters.  Zero-cost when no breaker is configured. */
  private _consecutiveFailures = 0;
  private _breakerOpenUntil = 0;

  protected constructor(options: OptionsBuilder<S> | Partial<S> = {}) {
    super();
    // A builder instance carries its set fields as own enumerable props, so
    // spreading normalizes builder OR plain object to a `Partial<S>` snapshot.
    this._ctorOptions = { ...(options as Partial<S>) };
  }

  /* ------------------------------- Options ------------------------------- */

  /** Final resolved options — only valid after `preStart`. */
  protected get options(): S {
    if (!this._options) {
      throw new Error(`BrokerActor.options accessed before preStart`);
    }
    return this._options;
  }

  /** Subclass: HOCON config path, e.g. `'actor-ts.io.broker.mqtt'`. */
  protected abstract configKey(): string;

  /** Subclass: defaults for everything not provided elsewhere. */
  protected abstract builtInDefaultOptions(): Partial<S>;

  /** Subclass: parse a Config block into a partial options object. */
  protected abstract readOptionsFromConfig(config: Config): Partial<S>;

  /** Subclass: list of fields that MUST be present in the resolved options. */
  protected abstract requiredOptions(): ReadonlyArray<keyof S>;

  /**
   * Subclass: validator for the resolved settings, run once at `preStart`
   * (after the required-field check).  Default: no value validation.  Return
   * a `new XOptionsValidator()` to enforce field/cross-field rules on the
   * merged settings, regardless of whether they came from the builder, a
   * plain object, or HOCON.
   */
  protected optionsValidator(): OptionsValidator<S> | undefined {
    return undefined;
  }

  /** Subclass: human-readable label for the connection (used in events). */
  protected abstract endpointLabel(): string;

  /* ----------------------------- Protocol hooks --------------------------- */

  /**
   * Open the underlying connection.  Throw on failure to trigger
   * reconnect; throwing during steady-state operation is also fine
   * (the base class will start a reconnect cycle).
   */
  protected abstract connectImplementation(): Promise<void>;

  /**
   * Close it and drop every handle the connection owned.  Best-effort —
   * exceptions are logged and swallowed.
   *
   * Called on stop **and before every re-connect attempt**, so it must
   * be idempotent and must survive being called on an already-dead
   * connection.  Do *not* discard desired subscriptions here (only the
   * live handles): the base class restores them on the next connect.
   */
  protected abstract disconnectImplementation(): Promise<void>;

  /**
   * Send a single outbound envelope.  Only invoked when state is
   * `connected`.  Throwing here is treated as a connection failure
   * and triggers a reconnect cycle.
   */
  protected abstract dispatchOutgoing(envelope: OutboundEnvelope<P>): Promise<void>;

  /* --------------------------- Sealed dispatch ---------------------------- */

  /**
   * @internal Sealed — implement {@link onCommand} instead.
   *
   * {@link subscribeRef} death-watches its subscribers, and `ActorCell` delivers
   * the resulting `Terminated` straight into `onReceive`.  For as long as that
   * method belonged to the subclass, the signal landed in a dispatch table
   * written for commands: the documented `match(…).exhaustive()` recipe threw
   * `NonExhaustiveError`, the default supervisor restarted the actor,
   * `preRestart` → `postStop` tore the transport down, and eleven subscriber
   * deaths inside a minute stopped the bridge for good.  A subclass using
   * `.otherwise()` survived and leaked instead — the dead ref stayed in every
   * topic it held and was told on each fan-out, one dead letter per inbound
   * message (#709).
   *
   * Sealing makes the correct handling unconditional instead of something every
   * subclass, in this repository and outside it, has to remember.  It does not
   * take the dispatch table away: the table moves to {@link onCommand} unchanged
   * and gets *narrower*, because `Terminated` is no longer something a command
   * union has to admit.
   *
   * An `if` rather than a `match`: `Command` is an open type parameter, and
   * ts-pattern cannot build a `Pattern<>` for a union that still contains one.
   */
  override onReceive(message: Command | Terminated): void | Promise<void> {
    if (message instanceof Terminated) return this.onTerminatedSignal(message);
    return this.onCommand(message as Command);
  }

  /**
   * Prune first, then pass the signal on.  A subclass that watches refs of its
   * own — `MqttActor` watches per-pattern delivery targets — still has to see
   * the death, and pruning first means {@link onTerminated} observes a registry
   * that has already forgotten the dead subscriber rather than one mid-update.
   */
  private onTerminatedSignal(signal: Terminated): void | Promise<void> {
    this.pruneTerminatedSubscriber(signal.actor);
    return this.onTerminated(signal);
  }

  /**
   * Subclass: handle one command from the mailbox.  This is the hook `onReceive`
   * used to be; the base class owns `onReceive` now (see there for why).
   *
   * `Terminated` never reaches it, so a `match(command).…exhaustive()` over the
   * subclass's own command union is exactly right — which is what makes the
   * seal worth its breaking rename.
   */
  protected abstract onCommand(command: Command): void | Promise<void>;

  /**
   * A watched actor stopped.  Everything {@link subscribeRef} registered for it
   * is already gone by the time this runs, so override it only for watches the
   * subclass installed itself.  Default: no-op.
   */
  protected onTerminated(_signal: Terminated): void | Promise<void> {
    /* subclasses with their own `context.watch` calls override this */
  }

  /* ------------------------------ Liveness -------------------------------- */

  /**
   * How long the connection may stay **silent inbound** before it is declared
   * lost.  `undefined` / `0` — the default — arms nothing.
   *
   * A subclass overrides this to surface its own `idleTimeoutMs` option.  It
   * exists as a hook rather than a common option because the deadline is only
   * honest for a transport that also calls {@link noteInboundActivity}: an
   * option every broker advertised but only three reset would be a knob that
   * silently severs healthy connections on the other eleven (#753).
   */
  protected idleTimeoutMs(): number | undefined { return undefined; }

  /**
   * How long one `connectImplementation` may take before the attempt is
   * aborted.  `undefined` / `0` — the default — arms nothing.
   *
   * Overriding this without also overriding {@link abortConnectAttempt} buys
   * nothing, which is why the default of that hook warns rather than doing
   * nothing quietly.
   */
  protected connectTimeoutMs(): number | undefined { return undefined; }

  /**
   * Abort an in-flight `connectImplementation` so its own promise rejects.
   *
   * Called from the connect-deadline timer, and **only** for a subclass that
   * returned a deadline from {@link connectTimeoutMs}.  Rejecting the original
   * promise — rather than racing it and walking away — is what keeps the
   * handles accounted for: a `Promise.race` the deadline wins leaves the
   * subclass's connect still running, free to assign `this.socket` on top of
   * whatever the reconnect cycle has opened since.  Here the failure travels
   * the path a refused connect already takes, and the subclass drops its own
   * half-open handle on the way out.
   */
  protected abortConnectAttempt(_cause: Error): void {
    this.log.warn(
      `${this.constructor.name}: connect deadline elapsed, but this actor cannot abort an `
      + `in-flight connect — the attempt to ${this.endpointLabel()} keeps running`,
    );
  }

  /**
   * Record that something arrived from the peer, refreshing the read-idle
   * deadline.  A subclass calls this from every inbound path — a TCP chunk, an
   * SSE read, a WebSocket frame — including the ones it goes on to reject:
   * an oversize frame is still proof the peer is alive.
   *
   * Deliberately a field read and a field write, with no timer work: this runs
   * once per inbound chunk, and re-arming a scheduler handle per chunk would
   * put a cancel + allocation on the hottest path the transport has.  The
   * deadline timer reads the timestamp when it fires and re-arms for the
   * remainder if the connection turned out to be busy — so a live connection
   * costs one wake-up per `idleTimeoutMs`, no matter its throughput.  With no
   * deadline armed — the default, and every broker that has no such option —
   * it costs one comparison and not even the clock read.
   */
  protected noteInboundActivity(): void {
    if (this._idleTimeoutMs === 0) return;
    this._lastInboundAt = Date.now();
  }

  /**
   * The read-idle deadline elapsed.  Default: report it as an ordinary lost
   * connection, which is what starts the reconnect cycle.
   *
   * A subclass overrides this when its transport is still *holding* something
   * — and after an idle timeout it always is.  This is the one loss the base
   * class detects rather than the transport: nothing has closed the socket,
   * so `handleConnectionLost` alone would flip the state machine and leave a
   * live handle with live listeners attached for the whole backoff window, or
   * for good under `reconnect: false`.  Each override routes into the
   * teardown its transport already has for a connection it must abandon
   * mid-flight.
   */
  protected handleIdleTimeout(cause: Error): void {
    this.handleConnectionLost(cause);
  }

  /* ------------------------- Desired subscriptions ------------------------ */

  /**
   * Subscriptions declared in the options, folded into the desired set
   * once, before the first connect.  Default: none.
   */
  protected initialSubscriptions(): Iterable<readonly [string, Subscription]> {
    return [];
  }

  /**
   * Establish one subscription on the live connection.  Invoked for
   * every desired entry on each (re)connect, and immediately when
   * {@link rememberSubscription} is called while connected.  Must be
   * safe to call for a key that is already live (treat as a no-op or
   * re-issue it).  Throwing is logged as a warning and does not fail
   * the connection.  Default: no-op.
   */
  protected applySubscription(_key: string, _subscription: Subscription): void | Promise<void> {
    /* protocols without runtime subscriptions don't implement this */
  }

  /**
   * Tear one subscription down on the live connection.  Invoked by
   * {@link forgetSubscription} while connected, and before re-applying a
   * key whose payload changed.  Default: no-op — several protocols can
   * only drop a subscription by dropping the whole consumer.
   */
  protected revokeSubscription(_key: string): void | Promise<void> {
    /* see applySubscription */
  }

  /**
   * Record `key` as a desired subscription and — when connected —
   * establish it right away.  Safe to call while disconnected: the entry
   * is applied on the next connect rather than dropped, so a `subscribe`
   * that arrives during an outage is not lost.
   *
   * Re-remembering a live key revokes it first, so the new payload
   * (e.g. a different target actor) actually takes effect.
   */
  protected async rememberSubscription(key: string, subscription: Subscription): Promise<void> {
    const wasDesired = this._desiredSubscriptions.has(key);
    this._desiredSubscriptions.set(key, subscription);
    if (!this._canApplySubscriptionNow()) return;
    if (wasDesired) await this._revokeSubscriptionSafely(key);
    await this._applySubscriptionSafely(key, subscription);
  }

  /** Drop `key` from the desired set and, when connected, from the connection. */
  protected async forgetSubscription(key: string): Promise<void> {
    if (!this._desiredSubscriptions.delete(key)) return;
    if (this._canApplySubscriptionNow()) await this._revokeSubscriptionSafely(key);
  }

  /**
   * Whether the subclass currently has a connection to act on.
   *
   * `connected` is the obvious case.  The `_subscriptionsApplied` half
   * covers the sliver of `connecting` *after* the replay pass ran — the
   * reconnect cycle runs on the scheduler, detached from the mailbox, so
   * a `subscribe` can be processed between `applyDesiredSubscriptions()`
   * returning and `_state` flipping to `connected`.  Without this the
   * entry would sit in the desired set until the *next* reconnect, which
   * is precisely the silent-loss class of bug this mechanism exists to
   * kill.  Before the replay pass it stays false: the subclass may not
   * have a connection yet, and the pass will pick the entry up anyway
   * (a `Map` iteration sees entries added while it runs).
   */
  private _canApplySubscriptionNow(): boolean {
    return this._state === 'connected'
      || (this._state === 'connecting' && this._subscriptionsApplied);
  }

  /**
   * (Re)establish every desired subscription on the current connection.
   *
   * Subclasses call this from `connectImplementation` rather than having
   * the base class drive it after the fact, because the correct point in
   * the handshake is protocol-specific — kafkajs, for one, wants every
   * `subscribe` in before `consumer.run`.
   */
  protected async applyDesiredSubscriptions(): Promise<void> {
    if (!this._subscriptionsSeeded) {
      this._subscriptionsSeeded = true;
      for (const [key, subscription] of this.initialSubscriptions()) {
        if (!this._desiredSubscriptions.has(key)) this._desiredSubscriptions.set(key, subscription);
      }
    }
    for (const [key, subscription] of this._desiredSubscriptions) {
      await this._applySubscriptionSafely(key, subscription);
    }
    this._subscriptionsApplied = true;
  }

  /** Number of desired subscriptions — exposed for tests / health probes. */
  protected get desiredSubscriptionCount(): number {
    return this._desiredSubscriptions.size;
  }

  /**
   * One failed subscription must not take the connection down with it —
   * the rest of the desired set is still worth having, and a reconnect
   * would not fix a subject the broker rejects.  But it must not be
   * silent either: a connected-yet-deaf actor is the failure mode this
   * whole mechanism exists to prevent, so it is a warning, not a debug.
   */
  private async _applySubscriptionSafely(key: string, subscription: Subscription): Promise<void> {
    try {
      await this.applySubscription(key, subscription);
    } catch (e) {
      this.log.warn(
        `${this.constructor.name}: could not establish subscription '${key}': ${(e as Error).message}`,
      );
    }
  }

  private async _revokeSubscriptionSafely(key: string): Promise<void> {
    try {
      await this.revokeSubscription(key);
    } catch (e) {
      this.log.warn(
        `${this.constructor.name}: could not revoke subscription '${key}': ${(e as Error).message}`,
      );
    }
  }

  /* ------------------------------- Subscribers ---------------------------- */

  /**
   * Subscribe `ref` to `topic`, and start watching it if this is its first
   * subscription.
   *
   * **Removal on death is automatic and needs nothing from the subclass.**  The
   * base class owns `onReceive` and routes `Terminated` into
   * {@link pruneTerminatedSubscriber} itself (#709), so a stopped subscriber
   * leaves every topic it held before the next fan-out reaches it.  It used to
   * be the subclass's job, and the doc claimed otherwise while `onReceive` was
   * abstract — the dead ref stayed registered and was told on each fan-out,
   * into dead letters (#1111).
   *
   * **Local refs only.**  `context.watch` installs a watcher for a
   * `LocalActorRef` and is otherwise a silent no-op, so a remote subscriber
   * never produces a `Terminated` and stays registered until `postStop`
   * (#918) — no `Terminated`-based cleanup, here or in a subclass, can reach
   * that case.
   */
  protected subscribeRef(topic: string, ref: ActorRef<unknown>): void {
    const path = ref.path.toString();
    if (!this._subscriptions.hasRight(path)) {
      this._subscriberRefs.set(path, ref);
      // First subscription for this ref → start watching.
      this.context.watch(ref);
    }
    this._subscriptions.add(topic, path);
  }

  /**
   * Remove `ref` from `topic`.  No-op if not subscribed.
   *
   * Matches on the ref's **path**, so a caller holding a different ref object
   * for the same actor still unsubscribes — identity matching quietly did
   * nothing there.
   */
  protected unsubscribeRef(topic: string, ref: ActorRef<unknown>): void {
    const path = ref.path.toString();
    if (!this._subscriptions.delete(topic, path)) return;
    if (this._subscriptions.hasRight(path)) return;
    // Last subscription gone → drop the watch.
    this._subscriberRefs.delete(path);
    this.context.unwatch(ref);
  }

  /**
   * Drop a stopped subscriber from every topic it held.  The sealed
   * {@link onReceive} calls this for every `Terminated`; it stays `protected`
   * so a subclass that stops a subscriber deliberately — rather than waiting
   * for the watch — can drop it on the spot.  Returns whether anything was
   * removed, so a caller can tell a subscriber's death from any other watched
   * actor's.
   *
   * Deliberately does **not** `unwatch`: the cell already dropped the watch
   * when it delivered `Terminated`, so asking again would only be a second
   * lookup.  `MqttActor.removeTerminatedTarget` makes the same call for the
   * same reason.
   */
  protected pruneTerminatedSubscriber(ref: ActorRef<unknown>): boolean {
    const path = ref.path.toString();
    if (!this._subscriptions.deleteRight(path)) return false;
    this._subscriberRefs.delete(path);
    return true;
  }

  /** Fan-out a received message to every subscriber of `topic`. */
  protected fanOutToTopic(topic: string, message: unknown): void {
    for (const path of this._subscriptions.get(topic)) {
      this._subscriberRefs.get(path)?.tell(message as never);
    }
  }

  /** Number of distinct topic subscriptions — useful for tests / metrics. */
  protected subscriberCountForTopic(topic: string): number {
    return this._subscriptions.get(topic).size;
  }

  /* ------------------------------- Outbound ------------------------------- */

  /**
   * Enqueue an outbound message.  When connected, it is dispatched
   * immediately (in the order they were enqueued); when disconnected
   * or connecting, it is buffered.  Returns true if buffered or sent,
   * false if the message was dropped (overflow / not-connected with
   * `outboundBuffer: 0`).
   */
  protected enqueueOutbound(payload: P): boolean {
    const env: OutboundEnvelope<P> = { payload, enqueuedAt: Date.now() };

    // Dispatch on connection state with compile-time exhaustiveness:
    // adding a new state to `ConnectionState` forces every site that
    // matches on it (including this one) to handle the new variant.
    return match(this._state)
      .with('connected', () => this.dispatchWhenConnected(env))
      .with('connecting', 'disconnected', 'disconnecting', () => this.bufferWhileOffline(env))
      .exhaustive();
  }

  /**
   * Connected path: dispatch the envelope now, or — if an earlier flush is
   * still draining the buffer — append at the tail to preserve order.
   */
  private dispatchWhenConnected(env: OutboundEnvelope<P>): boolean {
    // Dispatch directly.  If an earlier flush is still draining the
    // buffer, append at the tail to preserve order.
    if (this._outboundBuffer.length > 0) {
      this._outboundBuffer.push(env);
      return true;
    }
    void this._dispatchOne(env);
    return true;
  }

  /**
   * Not-connected path (connecting / disconnected / disconnecting): buffer
   * the envelope, evicting the oldest on overflow (FIFO), or drop it when
   * buffering is disabled (`outboundBuffer: 0`).
   */
  private bufferWhileOffline(env: OutboundEnvelope<P>): boolean {
    const limit = this.options.outboundBuffer ?? DEFAULT_OUTBOUND_BUFFER;
    if (limit === 0) {
      this.system.eventStream.publish(new BrokerNotConnected(this.self.path.toString()));
      return false;
    }
    if (this._outboundBuffer.length >= limit) {
      this._outboundBuffer.shift();  // drop oldest (FIFO eviction)
      this.system.eventStream.publish(new BrokerBufferOverflow(this.self.path.toString(), limit));
    }
    this._outboundBuffer.push(env);
    return true;
  }

  /** Current connection state — exposed for tests / health probes. */
  protected get connectionState(): ConnectionState { return this._state; }

  /** Buffer size — exposed for tests. */
  protected get outboundBufferSize(): number { return this._outboundBuffer.length; }

  /* ------------------------------- Lifecycle ------------------------------ */

  override async preStart(): Promise<void> {
    this._options = this._resolveOptions();
    await this._validateRequired();
    // Value validation runs after the required-field check so a missing
    // field still surfaces as BrokerSettingsError, not a rule failure.
    this.optionsValidator()?.validate(this._options!);
    this._registerShutdownTask();
    await this._beginConnect();
  }

  override async postStop(): Promise<void> {
    // First statement, before anything that awaits: a detached reconnect
    // attempt reads this to decide whether it may still open — or keep — a
    // connection, and the window this closes is exactly the one an `await`
    // here would widen (#708).
    this._stopped = true;
    if (this._shutdownTaskName !== null) {
      this.system.extension(CoordinatedShutdownId)
        .removeTask(Phases.ServiceStop, this._shutdownTaskName);
      this._shutdownTaskName = null;
    }
    this._scheduledReconnectCancel?.();
    this._scheduledReconnectCancel = null;
    // No `_clearIdleTimeout()` here: a deadline is only ever armed on a
    // connection, so `_transportOpened` is true whenever one exists and the
    // `_closeTransport` below always reaches the disarm.  A third clear would
    // be unreachable, which is worse than absent — nothing could ever fail if
    // it stopped working.
    // Gate on transport state, not on `_state`: after a dropped
    // connection the state machine reads `disconnected` while the
    // subclass still holds sockets, clients and pending acks — the
    // old `_state !== 'disconnected'` guard skipped teardown for
    // exactly the actors that needed it most.
    if (this._transportOpened) this._state = 'disconnecting';
    await this._closeTransport();
    this._state = 'disconnected';
    this._outboundBuffer = [];
    this._subscriptions.clear();
    // Cleared alongside the relation.  The old pair left its reverse leg
    // behind here, which only went unnoticed because the actor is on its way
    // out anyway.
    this._subscriberRefs.clear();
  }

  /* ----------------------------- Internal flow ---------------------------- */

  /**
   * Close the connection in `service-stop`, alongside everything else that
   * talks to the outside world.
   *
   * `postStop` already tears the transport down, and the `/user` stop cascade
   * in `actor-system-terminate` already reaches it — so this is about
   * **ordering**, not absence (#549).  Last-phase teardown meant a broker
   * kept publishing while the HTTP server was unbinding and while the node
   * was leaving the cluster; the whole point of the phase list is that
   * outbound connections go before the membership does, so a message is
   * never emitted by a node its peers have already written off.
   *
   * The task is idempotent by way of `_closeTransport`, which returns
   * immediately once the transport is closed, so the `postStop` that follows
   * costs nothing.  It is named after the actor's path because one system can
   * hold many brokers and phase-task names must be unique.
   */
  private _registerShutdownTask(): void {
    const name = `broker-stop-${this.self.path.toString()}`;
    const registered = this.system.extension(CoordinatedShutdownId).addFrameworkTask(
      Phases.ServiceStop,
      name,
      async () => {
        // Stop the reconnect loop first: reconnecting mid-shutdown would
        // re-open the very transport this task exists to close.
        this._scheduledReconnectCancel?.();
        this._scheduledReconnectCancel = null;
        if (this._transportOpened) this._state = 'disconnecting';
        await this._closeTransport();
        this._state = 'disconnected';
      },
    );
    this._shutdownTaskName = registered ? name : null;
  }

  private _resolveOptions(): S {
    const defaults = this.builtInDefaultOptions();
    const config = this.system.config.hasPath(this.configKey())
      ? this.system.config.getConfig(this.configKey())
      : null;
    const fromConfig = config
      ? { ...readCommonOptions(config), ...this.readOptionsFromConfig(config) } as Partial<S>
      : ({} as Partial<S>);
    return mergeOptions<S>(defaults, fromConfig, this._ctorOptions);
  }

  private async _validateRequired(): Promise<void> {
    const required = this.requiredOptions();
    const missing: string[] = [];
    for (const key of required) {
      if (this._options![key] === undefined || this._options![key] === null) {
        missing.push(String(key));
      }
    }
    if (missing.length > 0) {
      throw new BrokerOptionsError(
        `${this.constructor.name} missing required options: ${missing.join(', ')}.  `
        + `Pass them in the constructor or under HOCON path '${this.configKey()}'.`,
        this.configKey(),
      );
    }
  }

  /** Begin (or restart after a disconnect) the connect cycle. */
  private async _beginConnect(): Promise<void> {
    this._reconnectAttempt = 0;
    await this._tryConnect();
  }

  private async _tryConnect(): Promise<void> {
    // Nothing below may run on a terminated actor — see {@link _stopped}.
    // This entry check is the cheap half; the two after the awaits below are
    // the ones that catch a stop landing mid-attempt (#708).
    if (this._stopped) return;

    // Honour an open circuit breaker.
    const breaker = this.options.circuitBreaker;
    if (breaker && Date.now() < this._breakerOpenUntil) {
      const remaining = this._breakerOpenUntil - Date.now();
      // Jittered like every other reconnect wake-up: this path returns
      // before `_handleReconnect` is ever reached, so without its own
      // spread a fleet whose breakers opened in one failure burst would
      // still wake in the same millisecond (#652).
      this._scheduleReconnect(this._spreadBreakerWait(remaining));
      return;
    }

    // Never re-enter connectImplementation on top of the previous
    // attempt's state.  A drop (or a connect that failed half-way)
    // leaves the subclass holding a dead client, its subscription
    // handles and its pending acks; building the new connection on top
    // of that leaks them and — because the subclass still sees its own
    // stale handles — can silently skip re-subscribing (#504).
    await this._closeTransport();

    // The teardown above awaits the subclass, so a stop can land inside it.
    // Re-check before opening anything: past this point the attempt has a
    // connection to lose, and starting one for an actor that has already
    // terminated is the worst case of all — the whole handshake happens
    // post-mortem (#708).
    if (this._stopped) return;

    this._state = 'connecting';
    // Set before the call, not after: a connectImplementation that
    // throws part-way through has still opened transport state.
    this._transportOpened = true;
    try {
      await this._connectWithinDeadline();
      // The subclass finished its handshake while the actor was being
      // stopped, so it is now holding live handles nobody owns: `postStop`
      // has returned and its CoordinatedShutdown task is deregistered, so
      // no framework path will ever close them.  Abandon the connection
      // instead of adopting it — publishing `BrokerConnected` or draining
      // the outbound buffer here would announce a broker with no owner.
      if (this._stopped) {
        await this._abandonConnection();
        return;
      }
      this._state = 'connected';
      this._reconnectAttempt = 0;
      this._consecutiveFailures = 0;
      // Armed here rather than by the subclass, so the deadline cannot outlive
      // a connect that was abandoned above and cannot be forgotten by a
      // subclass that remembered `noteInboundActivity` and nothing else.
      this._armIdleTimeout();
      this.system.eventStream.publish(
        new BrokerConnected(this.self.path.toString(), this.endpointLabel()),
      );
      // Drain any buffered outbound now that we're connected.
      void this._drainBuffer();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this._state = 'disconnected';
      // Same window on the failure path, with a different consequence: a
      // half-built transport nothing will close, plus a backoff timer that
      // would outlive the actor and retry forever.  Breaker bookkeeping is
      // skipped deliberately — there is no next attempt to hold back.
      if (this._stopped) {
        await this._abandonConnection();
        return;
      }
      this._consecutiveFailures++;
      if (breaker && this._consecutiveFailures >= breaker.failureThreshold) {
        this._breakerOpenUntil = Date.now() + breaker.resetMs;
        this._consecutiveFailures = 0;
      }
      this._handleReconnect(err);
    }
  }

  /**
   * Run one `connectImplementation` under the subclass's connect deadline.
   *
   * A peer that completes the TCP handshake and then says nothing used to hold
   * the actor in `connecting` for as long as it cared to: every subclass
   * settles its connect promise on a protocol event (`connect`, `open`,
   * response headers) and none of them has a clock (#753).  Without a
   * deadline the reconnect machinery never runs, because the attempt that
   * would have failed never finishes failing.
   *
   * The timer does not race the promise, it *pokes* it: `abortConnectAttempt`
   * makes the subclass reject its own connect, so the failure arrives through
   * the ordinary catch below with the subclass's own handles already dropped.
   * Racing would leave the abandoned attempt free to finish later and adopt a
   * socket the reconnect cycle has since replaced — the shape `_stopped` +
   * {@link _abandonConnection} exists to clean up after, and the one worth not
   * creating a second source of.
   */
  private async _connectWithinDeadline(): Promise<void> {
    const timeoutMs = this.connectTimeoutMs();
    if (timeoutMs === undefined || timeoutMs <= 0) {
      await this.connectImplementation();
      return;
    }
    const handle = this.system.scheduler.scheduleOnceFunction(timeoutMs, () => {
      this.abortConnectAttempt(new Error(
        `connect to ${this.endpointLabel()} did not complete within ${timeoutMs} ms`,
      ));
    });
    try { await this.connectImplementation(); }
    finally { handle.cancel(); }
  }

  /* ------------------------- Read-idle deadline (#753) -------------------- */

  /**
   * Arm the read-idle deadline for the connection just established.  A
   * subclass that returns nothing from {@link idleTimeoutMs} gets no timer at
   * all, so the cost for the eleven brokers with no such option is one
   * virtual call per connect.
   */
  private _armIdleTimeout(): void {
    this._clearIdleTimeout();
    const timeoutMs = this.idleTimeoutMs();
    if (timeoutMs === undefined || timeoutMs <= 0) return;
    this._idleTimeoutMs = timeoutMs;
    this._lastInboundAt = Date.now();
    this._scheduleIdleCheck(timeoutMs);
  }

  /**
   * Disarm it.  Idempotent, and called from both paths that end a connection —
   * {@link handleConnectionLost}, which a subclass can reach without any
   * teardown, and {@link _closeTransport}, which every reconnect and every
   * stop goes through — so a timer can never outlive the connection it was
   * measuring.
   */
  private _clearIdleTimeout(): void {
    this._idleTimeoutCancel?.();
    this._idleTimeoutCancel = null;
    this._idleTimeoutMs = 0;
  }

  private _scheduleIdleCheck(delayMs: number): void {
    if (this._stopped) return;
    const handle = this.system.scheduler.scheduleOnceFunction(delayMs, () => this._onIdleDeadline());
    this._idleTimeoutCancel = (): void => { handle.cancel(); };
  }

  /**
   * The deadline elapsed.  Re-arm when the peer spoke since it was set —
   * that is the whole reason {@link noteInboundActivity} may be a bare
   * timestamp write — and otherwise route the silence into the reconnect
   * machinery through the same door a transport event uses.
   *
   * `Scheduler` settles a one-shot handle before invoking it, exactly as on
   * the reconnect path, so a `cancel()` that lands during this callback is a
   * no-op; the `_idleTimeoutMs === 0` guard is what makes that harmless.
   */
  private _onIdleDeadline(): void {
    this._idleTimeoutCancel = null;
    if (this._stopped || this._idleTimeoutMs <= 0) return;
    const quietForMs = Date.now() - this._lastInboundAt;
    if (quietForMs < this._idleTimeoutMs) {
      this._scheduleIdleCheck(this._idleTimeoutMs - quietForMs);
      return;
    }
    const timeoutMs = this._idleTimeoutMs;
    this._clearIdleTimeout();
    this.handleIdleTimeout(new Error(
      `no inbound data from ${this.endpointLabel()} for ${timeoutMs} ms (idle timeout)`,
    ));
  }

  /**
   * Close a connection that opened — or half-opened — after the actor was
   * already gone, and leave the state machine reading `disconnected`.
   *
   * `postStop` cleared the `_transportOpened` gate on its way out, so
   * {@link _closeTransport} on its own would return without asking the
   * subclass to close anything, and the escaped attempt is precisely the one
   * with handles to release.  Re-opening the gate for this one call routes
   * the teardown back through the wrapper rather than calling
   * `disconnectImplementation` raw: a subclass teardown that throws is then
   * logged, instead of becoming an unhandled rejection inside a detached
   * scheduler callback.
   *
   * A base-class guard can only *undo* what the subclass already did — its
   * `connectImplementation` ran to completion before control came back here
   * — which is why the teardown is not optional (#708).
   */
  private async _abandonConnection(): Promise<void> {
    this.log.warn(
      `${this.constructor.name}: a connect attempt completed after the actor stopped; `
      + `abandoning the connection to ${this.endpointLabel()}`,
    );
    this._transportOpened = true;
    await this._closeTransport();
    this._state = 'disconnected';
  }

  /**
   * Run `disconnectImplementation` if any transport state is open.
   * Idempotent and never throws — teardown failures are logged, because
   * the caller's next move (reconnect or stop) has to happen regardless.
   */
  private async _closeTransport(): Promise<void> {
    if (!this._transportOpened) return;
    this._transportOpened = false;
    // Before the subclass teardown, not after: `disconnectImplementation`
    // awaits, and a deadline that fired inside that window would report a
    // connection the caller has already given up on.
    this._clearIdleTimeout();
    // The live handles go with the connection; the desired set stays.
    this._subscriptionsApplied = false;
    try { await this.disconnectImplementation(); }
    catch (e) { this.log.warn(`broker disconnectImplementation threw: ${(e as Error).message}`); }
  }

  /** Called when the connection drops (from inside `dispatchOutgoing` or by the subclass). */
  protected handleConnectionLost(cause?: Error): void {
    // Defence in depth, and deliberately not justified by the escaped-connection
    // case: `_abandonConnection` leaves the actor `disconnected`, so that path
    // can no longer reach the state guard below.  What this does still catch is
    // a subclass driver callback the base class does not control, firing after
    // `postStop` set `_stopped` — a reconnect cycle on a terminated actor (#708).
    // No test pins it, because reaching it needs a subclass that misbehaves.
    //
    // The idle deadline goes first and unconditionally: whoever reported the
    // loss, the connection it was measuring is gone.  `dropConnection` on the
    // framing-cap path reaches here without a teardown, so leaving it to
    // `_closeTransport` would keep a timer armed across the whole backoff
    // window, firing into a state guard that discards it (#753).
    this._clearIdleTimeout();
    if (this._stopped) return;
    if (this._state !== 'connected' && this._state !== 'connecting') return;
    this._state = 'disconnected';
    this.system.eventStream.publish(
      new BrokerDisconnected(this.self.path.toString(), this.endpointLabel(), cause),
    );
    this._handleReconnect(cause ?? new Error('connection lost'));
  }

  private _handleReconnect(cause: Error): void {
    if (this._stopped) return;
    const policy = this.options.reconnect;
    if (policy === false) return;
    const initial = policy?.initialDelayMs ?? DEFAULT_RECONNECT.initialDelayMs;
    const maxDelay = policy?.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs;
    const factor = policy?.factor ?? DEFAULT_RECONNECT.factor;
    const maxAttempts = policy?.maxAttempts ?? DEFAULT_RECONNECT.maxAttempts;

    this._reconnectAttempt++;
    if (this._reconnectAttempt > maxAttempts) {
      this.system.eventStream.publish(new BrokerReconnectFailed(
        this.self.path.toString(), this.endpointLabel(), this._reconnectAttempt - 1, cause,
      ));
      return;
    }
    const backoff = Math.min(initial * Math.pow(factor, this._reconnectAttempt - 1), maxDelay);
    const delay = this._jitteredBackoff(backoff);
    this.system.eventStream.publish(new BrokerReconnectAttempt(
      this.self.path.toString(), this.endpointLabel(), this._reconnectAttempt, delay,
    ));
    this._scheduleReconnect(delay);
  }

  /**
   * Reconnect jitter (#652).  The un-jittered delay is a pure function of
   * the attempt counter and the options, so every broker actor that lost
   * the same broker in the same instant retries in the same millisecond,
   * wave after wave, and the herd can hold the recovering broker down.
   *
   * The arithmetic stays here rather than delegating to `exponentialBackoff`
   * from `pattern/BackoffPolicy` for two reasons: that primitive hardcodes
   * base 2 and so cannot express the public `reconnect.factor`, and it
   * *throws* when `maxMs < minMs` — a shape the broker has always accepted
   * and merely clamped, so routing through it would turn a working config
   * into an actor that fails on its first disconnect.  The jitter contract
   * is deliberately identical to the primitive's.
   *
   * `Math.random` is the right source: a backoff delay is neither a wire
   * identifier nor attacker-observable, so crypto-grade randomness would
   * buy nothing.
   */
  private _jitteredBackoff(delayMs: number): number {
    const { randomFactor, random } = this._reconnectRandomness();
    if (randomFactor === 0) return delayMs;
    // random() is [0, 1); map it to [-randomFactor, +randomFactor].
    // Floored at 0 — a sub-zero delay would be nonsensical.
    return Math.max(0, delayMs * (1 + (random() * 2 - 1) * randomFactor));
  }

  /**
   * Jitter for the circuit-breaker wake-up, spread *forwards only*:
   * `[remaining, remaining × (1 + randomFactor)]`.
   *
   * `remainingMs` is the time left on a deadline the actor must not connect
   * before, which is what rules the symmetric form out.  An actor that woke
   * early would land straight back in the same branch with a smaller
   * remaining, and repeating that converges every actor onto the deadline
   * again — the exact synchronisation the jitter exists to break, plus a
   * tail of pointless timer hops.  The cost of the one-sided form is a
   * breaker that stays shut for up to `randomFactor` longer than `resetMs`.
   */
  private _spreadBreakerWait(remainingMs: number): number {
    const { randomFactor, random } = this._reconnectRandomness();
    if (randomFactor === 0) return remainingMs;
    return remainingMs * (1 + random() * randomFactor);
  }

  /**
   * Jitter fraction and randomness source shared by both wake-up paths.
   * Read per call, like the rest of the reconnect policy, so a subclass
   * that resolves its options late still gets the value it configured.
   * `reconnect: false` disables retrying, not the breaker path — that one
   * still schedules, so it falls back to the built-in spread.
   */
  private _reconnectRandomness(): { readonly randomFactor: number; readonly random: () => number } {
    const policy = this.options.reconnect;
    const configured = policy === false ? undefined : policy;
    return {
      randomFactor: configured?.randomFactor ?? DEFAULT_RECONNECT.randomFactor,
      random: configured?.random ?? Math.random,
    };
  }

  private _scheduleReconnect(delayMs: number): void {
    // Cancel any pending reconnect timer first (e.g. when reconnect is
    // re-triggered before the previous timer fired).
    this._scheduledReconnectCancel?.();
    this._scheduledReconnectCancel = null;
    // Belt and braces: every caller is already guarded, but a handle armed
    // after `postStop` would outlive the actor outright — the cancel that
    // could have cleared it has already run, and there is no second one
    // (#708).
    if (this._stopped) return;
    const reconnect = (): void => { void this._tryConnect(); };
    // Use the system scheduler (not the actor TimerScheduler): reconnect
    // is detached from the message pipeline — it should not queue behind
    // user commands.  Cancel-handle is tracked for postStop teardown.
    const handle = this.system.scheduler.scheduleOnceFunction(delayMs, reconnect);
    this._scheduledReconnectCancel = (): void => { handle.cancel(); };
  }

  private _scheduledReconnectCancel: (() => void) | null = null;

  private async _drainBuffer(): Promise<void> {
    while (this._outboundBuffer.length > 0 && this._state === 'connected') {
      const env = this._outboundBuffer.shift()!;
      try {
        await this.dispatchOutgoing(env);
      } catch (e) {
        // Push back at the head so the message isn't lost across reconnect.
        this._outboundBuffer.unshift(env);
        this.handleConnectionLost(e instanceof Error ? e : new Error(String(e)));
        return;
      }
    }
  }

  private async _dispatchOne(env: OutboundEnvelope<P>): Promise<void> {
    try {
      await this.dispatchOutgoing(env);
    } catch (e) {
      this._outboundBuffer.unshift(env);
      this.handleConnectionLost(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
