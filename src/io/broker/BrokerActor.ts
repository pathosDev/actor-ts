import { match } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Config } from '../../config/Config.js';
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
  mergeOptions,
  readCommonOptions,
  type BrokerCommonOptionsType,
} from './BrokerOptions.js';

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
export interface OutboundEnvelope<P = unknown> {
  readonly payload: P;
  /** Wall-clock when the message was enqueued.  Useful for TTL evictions. */
  readonly enqueuedAt: number;
}

/**
 * Base class for actors that bridge external messaging systems
 * (MQTT, WebSocket, Kafka, …) into the actor system.  Subclasses
 * implement three protocol hooks (`connectImplementation`, `disconnectImplementation`,
 * `dispatchOutgoing`); the base class owns the lifecycle, reconnect-
 * backoff, outbound buffer, subscriber fan-out, and lifecycle-event
 * publishing.
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

  /** topic → set of subscriber ActorRefs (deathwatched). */
  private readonly _subscribers = new Map<string, Set<ActorRef<unknown>>>();
  /** Reverse index for O(1) cleanup on Terminated. */
  private readonly _subscribed = new WeakMap<ActorRef<unknown>, Set<string>>();

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

  /** Reconnect bookkeeping for the current cycle (since the last successful connect). */
  private _reconnectAttempt = 0;

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
   * Subscribe `ref` to `topic`.  The ref is deathwatched — when it
   * stops, it is automatically removed from every topic it was
   * subscribed to (no leak).
   */
  protected subscribeRef(topic: string, ref: ActorRef<unknown>): void {
    let set = this._subscribers.get(topic);
    if (!set) { set = new Set(); this._subscribers.set(topic, set); }
    if (!set.has(ref)) {
      set.add(ref);
      let topics = this._subscribed.get(ref);
      if (!topics) {
        topics = new Set();
        this._subscribed.set(ref, topics);
        // First subscription for this ref → start watching.
        this.context.watch(ref);
      }
      topics.add(topic);
    }
  }

  /** Remove `ref` from `topic`.  No-op if not subscribed. */
  protected unsubscribeRef(topic: string, ref: ActorRef<unknown>): void {
    const set = this._subscribers.get(topic);
    if (!set) return;
    set.delete(ref);
    if (set.size === 0) this._subscribers.delete(topic);
    const topics = this._subscribed.get(ref);
    if (topics) {
      topics.delete(topic);
      if (topics.size === 0) {
        this._subscribed.delete(ref);
        // Last subscription gone → drop the watch.
        this.context.unwatch(ref);
      }
    }
  }

  /** Fan-out a received message to every subscriber of `topic`. */
  protected fanOutToTopic(topic: string, message: unknown): void {
    const set = this._subscribers.get(topic);
    if (!set) return;
    for (const ref of set) ref.tell(message as never);
  }

  /** Number of distinct topic subscriptions — useful for tests / metrics. */
  protected subscriberCountForTopic(topic: string): number {
    return this._subscribers.get(topic)?.size ?? 0;
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
    await this._beginConnect();
  }

  override async postStop(): Promise<void> {
    this._scheduledReconnectCancel?.();
    this._scheduledReconnectCancel = null;
    // Gate on transport state, not on `_state`: after a dropped
    // connection the state machine reads `disconnected` while the
    // subclass still holds sockets, clients and pending acks — the
    // old `_state !== 'disconnected'` guard skipped teardown for
    // exactly the actors that needed it most.
    if (this._transportOpened) this._state = 'disconnecting';
    await this._closeTransport();
    this._state = 'disconnected';
    this._outboundBuffer = [];
    this._subscribers.clear();
  }

  /* ----------------------------- Internal flow ---------------------------- */

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
    // Honour an open circuit breaker.
    const breaker = this.options.circuitBreaker;
    if (breaker && Date.now() < this._breakerOpenUntil) {
      const remaining = this._breakerOpenUntil - Date.now();
      this._scheduleReconnect(remaining);
      return;
    }

    // Never re-enter connectImplementation on top of the previous
    // attempt's state.  A drop (or a connect that failed half-way)
    // leaves the subclass holding a dead client, its subscription
    // handles and its pending acks; building the new connection on top
    // of that leaks them and — because the subclass still sees its own
    // stale handles — can silently skip re-subscribing (#504).
    await this._closeTransport();

    this._state = 'connecting';
    // Set before the call, not after: a connectImplementation that
    // throws part-way through has still opened transport state.
    this._transportOpened = true;
    try {
      await this.connectImplementation();
      this._state = 'connected';
      this._reconnectAttempt = 0;
      this._consecutiveFailures = 0;
      this.system.eventStream.publish(
        new BrokerConnected(this.self.path.toString(), this.endpointLabel()),
      );
      // Drain any buffered outbound now that we're connected.
      void this._drainBuffer();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this._state = 'disconnected';
      this._consecutiveFailures++;
      if (breaker && this._consecutiveFailures >= breaker.failureThreshold) {
        this._breakerOpenUntil = Date.now() + breaker.resetMs;
        this._consecutiveFailures = 0;
      }
      this._handleReconnect(err);
    }
  }

  /**
   * Run `disconnectImplementation` if any transport state is open.
   * Idempotent and never throws — teardown failures are logged, because
   * the caller's next move (reconnect or stop) has to happen regardless.
   */
  private async _closeTransport(): Promise<void> {
    if (!this._transportOpened) return;
    this._transportOpened = false;
    // The live handles go with the connection; the desired set stays.
    this._subscriptionsApplied = false;
    try { await this.disconnectImplementation(); }
    catch (e) { this.log.warn(`broker disconnectImplementation threw: ${(e as Error).message}`); }
  }

  /** Called when the connection drops (from inside `dispatchOutgoing` or by the subclass). */
  protected handleConnectionLost(cause?: Error): void {
    if (this._state !== 'connected' && this._state !== 'connecting') return;
    this._state = 'disconnected';
    this.system.eventStream.publish(
      new BrokerDisconnected(this.self.path.toString(), this.endpointLabel(), cause),
    );
    this._handleReconnect(cause ?? new Error('connection lost'));
  }

  private _handleReconnect(cause: Error): void {
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
    const delay = Math.min(initial * Math.pow(factor, this._reconnectAttempt - 1), maxDelay);
    this.system.eventStream.publish(new BrokerReconnectAttempt(
      this.self.path.toString(), this.endpointLabel(), this._reconnectAttempt, delay,
    ));
    this._scheduleReconnect(delay);
  }

  private _scheduleReconnect(delayMs: number): void {
    // Cancel any pending reconnect timer first (e.g. when reconnect is
    // re-triggered before the previous timer fired).
    this._scheduledReconnectCancel?.();
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
