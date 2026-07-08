import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Terminated } from '../../SystemMessages.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import { mqttJsonCodec, MqttDecodeError, type MqttCodec } from './MqttCodec.js';
import { MqttOptionsValidator } from './MqttOptions.js';
import type { MqttOptions, MqttOptionsType } from './MqttOptions.js';
import {
  MqttConnectedSignal,
  MqttDisconnectedSignal,
  MqttInboundSignal,
  MqttPayload,
  type MqttActorMessage,
  type MqttCmd,
  type MqttMessage,
  type MqttPublish,
  type MqttQos,
  type MqttUserProperties,
} from './MqttMessages.js';

export type { MqttQos, MqttUserProperties, MqttMessage, MqttPublish, MqttCmd } from './MqttMessages.js';

/** Per-publish overrides. */
export interface MqttPublishOptions {
  readonly qos?: MqttQos;
  readonly retain?: boolean;
  readonly userProperties?: MqttUserProperties;
}

/** One subscription pattern's routing state. */
interface SubscriptionEntry<T> {
  /** Requested QoS, or undefined → resolve to `qos` at SUBSCRIBE time. */
  qos?: MqttQos;
  /** Deliver matching messages to this actor's own `onMessage`. */
  deliverToSelf: boolean;
  /** Foreign actors to fan matching messages out to. */
  readonly targets: Set<ActorRef<MqttMessage<T>>>;
}

/**
 * Typed, subclass-first MQTT 3.1.1 / 5.0 actor backed by the `mqtt`
 * peer-dep — the MQTT counterpart to `WebSocketClientActor`.  Extend it,
 * declare subscriptions in the constructor, and handle inbound traffic
 * in `onMessage`:
 *
 *     class MyClient extends MqttActor {
 *       constructor(opts: MqttOptions) {
 *         super(opts.withQos(1).withClientId('my-client'));
 *         this.subscribe('some/thing/#');
 *       }
 *       override onMessage(msg: MqttMessage): void {
 *         this.log.info(msg.payload.text());
 *         this.publish(msg.topic, 'pong');
 *       }
 *     }
 *
 * `T` types the inbound payload (`msg.payload.entity(): T`); `TSelf`
 * types application messages other actors may `tell` this ref (defaults
 * to `never`).  It is still externally controllable: `ref.tell(cmd)`
 * with a {@link MqttCmd} publishes / subscribes / unsubscribes; a
 * `subscribe` command with no `target` routes to this actor's own
 * `onMessage`, with a `target` fans out to that actor.
 *
 * Lifecycle events (inbound / connected / disconnected) are delivered
 * through the mailbox, so `onMessage` and the hooks always run on the
 * actor thread (single-threaded, per-connection order preserved).
 */
export abstract class MqttActor<T = unknown, TSelf = never>
  extends BrokerActor<MqttOptionsType, MqttActorMessage<T, TSelf>, MqttPublish> {

  private client: MqttClientLike | null = null;
  private _codec: MqttCodec<unknown> | null = null;
  /** False until `preStart` — before that `subscribe()` only records. */
  private _started = false;

  /** Single source of truth: pattern → routing entry. */
  private readonly registry = new Map<string, SubscriptionEntry<T>>();
  /** Deathwatch bookkeeping: ref.path → its watched ref + the patterns it consumes. */
  private readonly watched = new Map<string, { ref: ActorRef<MqttMessage<T>>; patterns: Set<string> }>();
  /** Subscriptions requested in the constructor, flushed in `preStart`. */
  private pendingSubs: Array<{ topic: string; qos?: MqttQos; target?: ActorRef<MqttMessage<T>> }> = [];

  constructor(options: MqttOptions = {}) {
    super(options);
  }

  /* ----------------------- user overrides ------------------------ */

  /** Handle one inbound message on this actor's own subscriptions. */
  abstract onMessage(msg: MqttMessage<T>): void | Promise<void>;

  /** The connection (re)opened; the registry has been re-applied on the broker. */
  protected onConnected(): void | Promise<void> {}

  /** The connection dropped; a reconnect cycle may follow (per settings). */
  protected onDisconnected(_cause?: Error): void | Promise<void> {}

  /**
   * `onMessage` threw an {@link MqttDecodeError} — typically from a lazy
   * `payload.entity()` on a malformed payload.  Default: log + drop (bad
   * wire data shouldn't restart the actor).  Rethrow to escalate to the
   * supervisor.
   */
  protected onDecodeError(error: MqttDecodeError, _msg: MqttMessage<T>): void | Promise<void> {
    this.log.warn(
      `MqttActor: dropping undecodable payload on '${error.topic ?? '<unknown>'}': ${error.message}`,
    );
  }

  /** App-level message told to this actor's ref (reachable only when TSelf ≠ never). */
  protected onSelfMessage(msg: TSelf): void | Promise<void> {
    this.log.warn(`MqttActor: unhandled self message: ${String(msg)}`);
  }

  /* ----------------------- protected API ------------------------- */

  /**
   * Register a subscription.  Constructor-safe: before start it is only
   * recorded (no context/settings access) and flushed on first connect.
   * At runtime it also issues a broker SUBSCRIBE when connected;
   * otherwise the registry entry is applied on the next connect.  Omit
   * `target` to deliver to this actor's own `onMessage`.
   */
  protected subscribe(topic: string, opts: { qos?: MqttQos; target?: ActorRef<MqttMessage<T>> } = {}): void {
    if (!this._started) {
      this.pendingSubs.push({ topic, qos: opts.qos, target: opts.target });
      return;
    }
    this.registerSubscription(topic, opts);
  }

  /**
   * Remove a subscription.  With `target`, removes that foreign target;
   * without, removes this actor's own `onMessage` delivery for `topic`.
   * A broker UNSUBSCRIBE fires once the pattern has no consumers left.
   */
  protected unsubscribe(topic: string, opts: { target?: ActorRef<MqttMessage<T>> } = {}): void {
    this.removeSubscription(topic, opts.target, false);
  }

  /**
   * Publish to `topic`.  A `string` or `Uint8Array` payload is sent
   * as-is; any other value is encoded via the actor's codec (default
   * JSON).  Returns false if the message was dropped (encode failure or
   * outbound-buffer overflow).
   *
   * To publish a bare string *as a codec entity* (JSON `"pong"` rather
   * than the raw bytes `pong`), encode it explicitly:
   * `this.publish(topic, this.codec().encode('pong'))`.
   */
  protected publish(topic: string, payload: string | Uint8Array, opts?: MqttPublishOptions): boolean;
  protected publish<E>(topic: string, entity: E, opts?: MqttPublishOptions): boolean;
  protected publish(topic: string, payload: unknown, opts: MqttPublishOptions = {}): boolean {
    let bytes: string | Uint8Array;
    if (typeof payload === 'string' || payload instanceof Uint8Array) {
      bytes = payload;
    } else {
      try {
        bytes = this.codec().encode(payload);
      } catch (err) {
        this.log.error(
          `MqttActor: encode failed, dropping publish to '${topic}': ${(err as Error).message}`,
        );
        return false;
      }
    }
    return this.enqueueOutbound({
      topic,
      payload: bytes,
      qos: opts.qos,
      retain: opts.retain,
      userProperties: opts.userProperties,
    });
  }

  /**
   * The actor's payload codec (default {@link mqttJsonCodec}).  Exposed
   * so subclasses can encode/decode explicitly — e.g. to publish a bare
   * string as a JSON entity.  Only valid after `preStart`.
   */
  protected codec(): MqttCodec<unknown> {
    return (this._codec ??= this.settings.codec ?? mqttJsonCodec());
  }

  /* ----------------------- sealed dispatch ----------------------- */

  /** @internal Sealed — override onMessage + hooks instead. */
  override onReceive(cmd: MqttActorMessage<T, TSelf>): void | Promise<void> {
    if (cmd instanceof MqttInboundSignal) return this.routeInbound(cmd.message);
    if (cmd instanceof MqttConnectedSignal) return this.onConnected();
    if (cmd instanceof MqttDisconnectedSignal) return this.onDisconnected(cmd.cause);
    // Terminated is delivered through onReceive (ActorCell) but isn't part
    // of the typed mailbox union — narrow via a guard.
    if (isTerminated(cmd)) {
      this.removeTerminatedTarget(cmd.actor);
      return;
    }
    const kind = (cmd as { readonly kind?: unknown }).kind;
    if (kind === 'publish' || kind === 'subscribe' || kind === 'unsubscribe') {
      return this.handleCommand(cmd as MqttCmd<T>);
    }
    return this.onSelfMessage(cmd as TSelf);
  }

  private handleCommand(cmd: MqttCmd<T>): void {
    // Exhaustive over MqttCmd — a new command variant forces a handler here.
    match(cmd)
      .with({ kind: 'publish' }, (c) => { this.enqueueOutbound(c.publish); })
      .with({ kind: 'subscribe' }, (c) => {
        this.registerSubscription(c.topic, { qos: c.qos, target: c.target });
      })
      .with({ kind: 'unsubscribe' }, (c) => {
        this.removeSubscription(c.topic, c.target, true);
      })
      .exhaustive();
  }

  /* ----------------------- inbound routing ----------------------- */

  private async routeInbound(msg: MqttMessage<T>): Promise<void> {
    let toSelf = false;
    const seen = new Set<ActorRef<MqttMessage<T>>>();
    for (const [pattern, entry] of this.registry) {
      if (!matchesMqttPattern(pattern, msg.topic)) continue;
      if (entry.deliverToSelf) toSelf = true;
      for (const ref of entry.targets) {
        if (!seen.has(ref)) { seen.add(ref); ref.tell(msg); }
      }
    }
    if (!toSelf) return;
    try {
      await this.onMessage(msg);
    } catch (err) {
      if (err instanceof MqttDecodeError) return this.onDecodeError(err, msg);
      throw err;  // ordinary supervision
    }
  }

  /* ----------------------- subscription registry ----------------- */

  private registerSubscription(
    topic: string,
    opts: { qos?: MqttQos; target?: ActorRef<MqttMessage<T>> },
  ): void {
    let entry = this.registry.get(topic);
    if (!entry) {
      entry = { qos: opts.qos, deliverToSelf: false, targets: new Set() };
      this.registry.set(topic, entry);
    } else if (opts.qos !== undefined) {
      entry.qos = opts.qos;  // last-writer-wins when a QoS is given
    }
    if (opts.target) {
      entry.targets.add(opts.target);
      this.watchTarget(opts.target, topic);
    } else {
      entry.deliverToSelf = true;
    }
    if (this.connectionState === 'connected' && this.client) {
      this.brokerSubscribe(topic, entry.qos);
    }
  }

  /**
   * @param fromExternal true for an external `unsubscribe` command with
   *   no target — drops all foreign targets but keeps the actor's own
   *   subscription (a controller must not be able to silence the
   *   subclass's constructor-declared subscription).  false for the
   *   protected `unsubscribe(topic)` — drops only the own delivery.
   */
  private removeSubscription(
    topic: string,
    target: ActorRef<MqttMessage<T>> | undefined,
    fromExternal: boolean,
  ): void {
    const entry = this.registry.get(topic);
    if (!entry) return;
    if (target) {
      entry.targets.delete(target);
      this.unwatchTarget(target, topic);
    } else if (fromExternal) {
      for (const ref of entry.targets) this.unwatchTarget(ref, topic);
      entry.targets.clear();
    } else {
      entry.deliverToSelf = false;
    }
    if (!entry.deliverToSelf && entry.targets.size === 0) {
      this.registry.delete(topic);
      this.brokerUnsubscribe(topic);
    }
  }

  private removeTerminatedTarget(ref: ActorRef): void {
    const key = ref.path.toString();
    const w = this.watched.get(key);
    if (!w) return;
    // The cell already dropped the watch on Terminated delivery — just
    // clean our own bookkeeping (no context.unwatch).
    this.watched.delete(key);
    for (const pattern of w.patterns) {
      const entry = this.registry.get(pattern);
      if (!entry) continue;
      for (const t of entry.targets) {
        if (t.path.toString() === key) { entry.targets.delete(t); break; }
      }
      if (!entry.deliverToSelf && entry.targets.size === 0) {
        this.registry.delete(pattern);
        this.brokerUnsubscribe(pattern);
      }
    }
  }

  private watchTarget(ref: ActorRef<MqttMessage<T>>, pattern: string): void {
    const key = ref.path.toString();
    let w = this.watched.get(key);
    if (!w) {
      w = { ref, patterns: new Set() };
      this.watched.set(key, w);
      this.context.watch(ref);
    }
    w.patterns.add(pattern);
  }

  private unwatchTarget(ref: ActorRef<MqttMessage<T>>, pattern: string): void {
    const key = ref.path.toString();
    const w = this.watched.get(key);
    if (!w) return;
    w.patterns.delete(pattern);
    if (w.patterns.size === 0) {
      this.watched.delete(key);
      this.context.unwatch(ref);
    }
  }

  private brokerSubscribe(topic: string, qos?: MqttQos): void {
    this.client?.subscribe(topic, { qos: qos ?? this.settings.qos ?? 0 }, (err) => {
      if (err) this.log.warn(`MqttActor: subscribe '${topic}' failed: ${err.message}`);
    });
  }

  private brokerUnsubscribe(topic: string): void {
    if (this.connectionState !== 'connected' || !this.client) return;
    this.client.unsubscribe(topic, undefined, (err) => {
      if (err) this.log.warn(`MqttActor: unsubscribe '${topic}' failed: ${err.message}`);
    });
  }

  /* ----------------------- BrokerActor plumbing ------------------ */

  override async preStart(): Promise<void> {
    // Context is attached before preStart; settings resolve inside
    // super.preStart().  Flush constructor subscriptions into the
    // registry (idempotent) so connectImpl applies them on connect.
    for (const p of this.pendingSubs) {
      this.registerSubscription(p.topic, { qos: p.qos, target: p.target });
    }
    this._started = true;
    await super.preStart();
  }

  protected configKey(): string { return ConfigKeys.io.broker.mqtt; }

  protected builtInDefaults(): Partial<MqttOptionsType> {
    return { qos: 0, cleanSession: true, keepAlive: 60 };
  }

  protected readSettingsFromConfig(c: Config): Partial<MqttOptionsType> {
    const out: { -readonly [K in keyof MqttOptionsType]?: MqttOptionsType[K] } = {};
    if (c.hasPath('brokerUrl')) out.brokerUrl = c.getString('brokerUrl');
    if (c.hasPath('clientId')) out.clientId = c.getString('clientId');
    if (c.hasPath('credentials')) {
      const cc = c.getConfig('credentials');
      out.credentials = {
        username: cc.hasPath('username') ? cc.getString('username') : undefined,
        password: cc.hasPath('password') ? cc.getString('password') : undefined,
      };
    }
    if (c.hasPath('qos')) out.qos = c.getInt('qos') as MqttQos;
    if (c.hasPath('cleanSession')) out.cleanSession = c.getBoolean('cleanSession');
    if (c.hasPath('keepAlive')) out.keepAlive = c.getInt('keepAlive');
    // Value validation (protocolVersion ∈ {4,5}, etc.) is enforced uniformly
    // by optionsValidator() on the merged settings — see MqttOptionsValidator.
    if (c.hasPath('protocolVersion')) out.protocolVersion = c.getInt('protocolVersion') as 4 | 5;
    return out;
  }

  protected requiredSettings(): ReadonlyArray<keyof MqttOptionsType> { return ['brokerUrl']; }
  protected override optionsValidator(): MqttOptionsValidator { return new MqttOptionsValidator(); }
  protected endpointLabel(): string { return this.settings.brokerUrl ?? '<unknown>'; }

  /** @internal Test seam — override to inject a fake mqtt module. */
  protected mqttModule(): Promise<MqttModuleLike> { return mqttLazy.get(); }

  protected async connectImpl(): Promise<void> {
    const mqtt = await this.mqttModule();
    const opts: MqttConnectOptions = {
      clientId: this.settings.clientId,
      username: this.settings.credentials?.username,
      password: this.settings.credentials?.password,
      clean: this.settings.cleanSession,
      keepalive: this.settings.keepAlive,
      protocolVersion: this.settings.protocolVersion ?? 4,
    };
    if (this.settings.will) {
      opts.will = {
        topic: this.settings.will.topic,
        payload: this.settings.will.payload,
        qos: this.settings.will.qos ?? 0,
        retain: this.settings.will.retain ?? false,
      };
    }
    return new Promise<void>((resolve, reject) => {
      const client = mqtt.connect(this.settings.brokerUrl!, opts);
      let done = false;
      let down = false;
      // mqtt.js can fire 'error' then 'close' for one drop — collapse them.
      const onDown = (cause: Error): void => {
        if (down) return;
        down = true;
        this.self.tell(new MqttDisconnectedSignal(cause));
        this.handleConnectionLost(cause);
      };
      client.once('connect', () => {
        if (done) return;
        done = true;
        client.removeAllListeners('error');
        this.client = client;
        client.on('message', (topic, payload, packet) => {
          // No user code on the mqtt.js loop: wrap into a lazily-decoding
          // payload and hand the message to our own mailbox.
          this.self.tell(new MqttInboundSignal<T>({
            topic,
            payload: new MqttPayload<T>(payload, this.codec(), topic),
            qos: (packet?.qos ?? 0) as MqttQos,
            retain: packet?.retain ?? false,
            userProperties: packet?.properties?.userProperties,
            reasonCode: packet?.properties?.reasonCode,
          }));
        });
        client.on('error', (e) => onDown(e));
        client.on('close', () => onDown(new Error('mqtt connection closed')));
        // (Re)apply the whole registry on every (re)connect — this is
        // what makes runtime subscriptions survive reconnects and
        // subscribe-while-disconnected land on the broker.
        for (const [pattern, entry] of this.registry) {
          this.brokerSubscribe(pattern, entry.qos);
        }
        this.self.tell(new MqttConnectedSignal());
        resolve();
      });
      client.once('error', (e: Error) => {
        if (done) return;
        done = true;
        try { client.end(true); } catch { /* ignore */ }
        reject(e);
      });
    });
  }

  protected async disconnectImpl(): Promise<void> {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    return new Promise<void>((resolve) => {
      c.removeAllListeners();
      c.end(false, {}, () => resolve());
      setTimeout(resolve, 1_000);
    });
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<MqttPublish>): Promise<void> {
    if (!this.client) throw new Error('MqttActor: not connected');
    const p = env.payload;
    const qos = p.qos ?? this.settings.qos ?? 0;
    const retain = p.retain ?? false;
    const protocolVersion = this.settings.protocolVersion ?? 4;
    const opts: MqttPubOpts = { qos, retain };
    const properties = buildPublishProperties(p, protocolVersion);
    if (properties) opts.properties = properties;
    return new Promise<void>((resolve, reject) => {
      this.client!.publish(p.topic, p.payload as string | Uint8Array, opts, (err) => {
        err ? reject(err) : resolve();
      });
    });
  }
}

/* --------------------------- helpers ---------------------------- */

/** Terminated arrives via onReceive but isn't in the typed mailbox union. */
function isTerminated(m: unknown): m is Terminated {
  return m instanceof Terminated;
}

/* --------------------------- MQTT 5.0 helpers -------------------------- */

/**
 * Build the mqtt-packet `properties` object for an outbound publish,
 * or `undefined` if there's nothing v5-specific to attach.  Pure
 * function — testable without a real broker or mqtt.js install.
 *
 * `protocolVersion < 5` always returns undefined: the 3.1.1 wire
 * format has no slot for user properties, so we drop them rather than
 * letting them leak into the publish callsite.
 */
export function buildPublishProperties(
  p: MqttPublish,
  protocolVersion: 4 | 5,
): { userProperties?: MqttUserProperties } | undefined {
  if (protocolVersion < 5) return undefined;
  if (!p.userProperties) return undefined;
  const keys = Object.keys(p.userProperties);
  if (keys.length === 0) return undefined;
  return { userProperties: p.userProperties };
}

/* --------------------------- MQTT topic match -------------------------- */

/** Standard MQTT pattern match: `+` matches one segment, `#` matches the rest. */
export function matchesMqttPattern(pattern: string, topic: string): boolean {
  const ps = pattern.split('/');
  const ts = topic.split('/');
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    if (p === '#') return true;
    if (i >= ts.length) return false;
    if (p === '+') continue;
    if (p !== ts[i]) return false;
  }
  return ps.length === ts.length;
}

/* ----------------------------- peer-dep shapes -------------------------- */

interface MqttConnectOptions {
  clientId?: string;
  username?: string;
  password?: string;
  clean?: boolean;
  keepalive?: number;
  /** mqtt.js: 4 (3.1.1), 5 (5.0).  We allow 4 and 5. */
  protocolVersion?: 4 | 5;
  will?: { topic: string; payload: Uint8Array | string; qos: MqttQos; retain: boolean };
}

interface MqttPubOpts {
  qos: MqttQos;
  retain: boolean;
  /** mqtt-packet v5 properties — attached only when protocolVersion=5. */
  properties?: { userProperties?: MqttUserProperties };
}

/**
 * Inbound packet shape read off mqtt.js.  v5 nests user properties +
 * reason codes under `properties`; absent on 3.1.1.  Exported as a test
 * seam so a fake client can build the same shape.
 */
export interface MqttInboundPacketLike {
  qos?: number;
  retain?: boolean;
  properties?: {
    userProperties?: MqttUserProperties;
    reasonCode?: number;
  };
}

/**
 * Minimal surface of the mqtt.js client we rely on.  Exported as a test
 * seam so subclasses overriding {@link MqttActor.mqttModule} can satisfy
 * the same shape without the real peer-dep.
 */
export interface MqttClientLike {
  on(event: 'message', cb: (topic: string, payload: Uint8Array, packet?: MqttInboundPacketLike) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: () => void): void;
  once(event: 'connect', cb: () => void): void;
  once(event: 'error', cb: (err: Error) => void): void;
  removeAllListeners(event?: string): void;
  publish(topic: string, payload: string | Uint8Array, opts: MqttPubOpts, cb?: (err?: Error) => void): void;
  subscribe(topic: string, opts: { qos: MqttQos }, cb?: (err?: Error) => void): void;
  unsubscribe(topic: string, opts: undefined, cb?: (err?: Error) => void): void;
  end(force?: boolean, opts?: object, cb?: () => void): void;
}

/** The `mqtt` module surface we use.  Exported as a test seam. */
export interface MqttModuleLike {
  connect(url: string, opts?: MqttConnectOptions): MqttClientLike;
}

const mqttLazy: Lazy<Promise<MqttModuleLike>> = Lazy.of(
  () => lazyImportModule<MqttModuleLike>('mqtt', { context: 'MqttActor' }),
);
