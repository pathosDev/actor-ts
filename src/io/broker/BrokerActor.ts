import { match } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Config } from '../../config/Config.js';
import type { OptionsBuilder } from '../../util/OptionsBuilder.js';
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
 */
export abstract class BrokerActor<S extends BrokerCommonOptionsType, Cmd = unknown, P = unknown>
  extends Actor<Cmd> {
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

  /** Subclass: human-readable label for the connection (used in events). */
  protected abstract endpointLabel(): string;

  /* ----------------------------- Protocol hooks --------------------------- */

  /**
   * Open the underlying connection.  Throw on failure to trigger
   * reconnect; throwing during steady-state operation is also fine
   * (the base class will start a reconnect cycle).
   */
  protected abstract connectImplementation(): Promise<void>;

  /** Close it.  Best-effort — exceptions are logged and swallowed. */
  protected abstract disconnectImplementation(): Promise<void>;

  /**
   * Send a single outbound envelope.  Only invoked when state is
   * `connected`.  Throwing here is treated as a connection failure
   * and triggers a reconnect cycle.
   */
  protected abstract dispatchOutgoing(envelope: OutboundEnvelope<P>): Promise<void>;

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
  protected fanOutToTopic(topic: string, msg: unknown): void {
    const set = this._subscribers.get(topic);
    if (!set) return;
    for (const ref of set) ref.tell(msg as never);
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
    const limit = this.options.outboundBuffer ?? DEFAULT_OUTBOUND_BUFFER;

    // Dispatch on connection state with compile-time exhaustiveness:
    // adding a new state to `ConnectionState` forces every site that
    // matches on it (including this one) to handle the new variant.
    return match(this._state)
      .with('connected', () => {
        // Dispatch directly.  If an earlier flush is still draining the
        // buffer, append at the tail to preserve order.
        if (this._outboundBuffer.length > 0) {
          this._outboundBuffer.push(env);
          return true;
        }
        void this._dispatchOne(env);
        return true;
      })
      .with('connecting', 'disconnected', 'disconnecting', () => {
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
      })
      .exhaustive();
  }

  /** Current connection state — exposed for tests / health probes. */
  protected get connectionState(): ConnectionState { return this._state; }

  /** Buffer size — exposed for tests. */
  protected get outboundBufferSize(): number { return this._outboundBuffer.length; }

  /* ------------------------------- Lifecycle ------------------------------ */

  override async preStart(): Promise<void> {
    this._options = this._resolveOptions();
    await this._validateRequired();
    await this._beginConnect();
  }

  override async postStop(): Promise<void> {
    this._scheduledReconnectCancel?.();
    this._scheduledReconnectCancel = null;
    if (this._state !== 'disconnected') {
      this._state = 'disconnecting';
      try { await this.disconnectImplementation(); }
      catch (e) { this.log.warn(`broker disconnectImplementation threw: ${(e as Error).message}`); }
    }
    this._state = 'disconnected';
    this._outboundBuffer = [];
    this._subscribers.clear();
  }

  /* ----------------------------- Internal flow ---------------------------- */

  private _resolveOptions(): S {
    const defaults = this.builtInDefaultOptions();
    const cfg = this.system.config.hasPath(this.configKey())
      ? this.system.config.getConfig(this.configKey())
      : null;
    const fromConfig = cfg
      ? { ...readCommonOptions(cfg), ...this.readOptionsFromConfig(cfg) } as Partial<S>
      : ({} as Partial<S>);
    return mergeOptions<S>(defaults, fromConfig, this._ctorOptions);
  }

  private async _validateRequired(): Promise<void> {
    const required = this.requiredOptions();
    const missing: string[] = [];
    for (const k of required) {
      if (this._options![k] === undefined || this._options![k] === null) {
        missing.push(String(k));
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

    this._state = 'connecting';
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
    const handle = this.system.scheduler.scheduleOnceFn(delayMs, reconnect);
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
