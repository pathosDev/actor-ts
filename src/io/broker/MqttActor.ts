import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Terminated } from '../../SystemMessages.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { MQTT_LOGGED_SUBSCRIBE_FIELD_MAX_CHARACTERS } from '../Constants.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import { toBrokerDriverTls } from './BrokerTls.js';
import { mqttJsonCodec, MqttDecodeError, type MqttCodec } from './MqttCodec.js';
import { MqttOptionsValidator } from './MqttOptions.js';
import type { MqttOptions, MqttOptionsType } from './MqttOptions.js';
import {
  MqttPayload,
  mqttConnectedSignal,
  mqttDisconnectedSignal,
  mqttInboundSignal,
  type MqttActorMessage,
  type MqttCommand,
  type MqttPublishCommand,
  type MqttSubscribeCommand,
  type MqttUnsubscribeCommand,
  type MqttDisconnectedSignal,
  type MqttInboundSignal,
  type MqttSignal,
  type MqttMessage,
  type MqttPublish,
  type MqttQos,
  type MqttUserProperties,
} from './MqttMessages.js';

export type { MqttQos, MqttUserProperties, MqttMessage, MqttPublish, MqttCommand } from './MqttMessages.js';

/** Per-publish overrides. */
export type MqttPublishOptions = {
  readonly qos?: MqttQos;
  readonly retain?: boolean;
  readonly userProperties?: MqttUserProperties;
};

/** One subscription pattern's routing state. */
type SubscriptionEntry<T> = {
  /** Requested QoS, or undefined → resolve to `qos` at SUBSCRIBE time. */
  qos?: MqttQos;
  /** Deliver matching messages to this actor's own `onMessage`. */
  deliverToSelf: boolean;
  /** Foreign actors to fan matching messages out to. */
  readonly targets: Set<ActorRef<MqttMessage<T>>>;
};

/**
 * Typed, subclass-first MQTT 3.1.1 / 5.0 actor backed by the `mqtt`
 * peer-dep — the MQTT counterpart to `WebsocketClientActor`.  Extend it,
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
 * with a {@link MqttCommand} publishes / subscribes / unsubscribes; a
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
  abstract onMessage(message: MqttMessage<T>): void | Promise<void>;

  /** The connection (re)opened; the registry has been re-applied on the broker. */
  protected onConnected(): void | Promise<void> {}

  /** The connection dropped; a reconnect cycle may follow (per options). */
  protected onDisconnected(_cause?: Error): void | Promise<void> {}

  /**
   * `onMessage` threw an {@link MqttDecodeError} — typically from a lazy
   * `payload.entity()` on a malformed payload.  Default: log + drop (bad
   * wire data shouldn't restart the actor).  Rethrow to escalate to the
   * supervisor.
   */
  protected onInvalidMessage(error: MqttDecodeError, _message: MqttMessage<T>): void | Promise<void> {
    this.log.warn(
      `MqttActor: dropping undecodable payload on '${error.topic ?? '<unknown>'}': ${error.message}`,
    );
  }

  /**
   * App-level message told to this actor's ref (reachable only when TSelf ≠ never).
   *
   * A `Terminated` from a `context.watch` of your own no longer arrives here —
   * `BrokerActor` intercepts it and offers `onTerminated` instead (#709).
   */
  protected onSelfMessage(message: TSelf): void | Promise<void> {
    this.log.warn(`MqttActor: unhandled self message: ${String(message)}`);
  }

  /* ----------------------- protected API ------------------------- */

  /**
   * Register a subscription.  Constructor-safe: before start it is only
   * recorded (no context/options access) and flushed on first connect.
   * At runtime it also issues a broker SUBSCRIBE when connected;
   * otherwise the registry entry is applied on the next connect.  Omit
   * `target` to deliver to this actor's own `onMessage`.
   */
  protected subscribe(topic: string, options: { qos?: MqttQos; target?: ActorRef<MqttMessage<T>> } = {}): void {
    if (!this._started) {
      this.pendingSubs.push({ topic, qos: options.qos, target: options.target });
      return;
    }
    this.registerSubscription(topic, options, false);
  }

  /**
   * Remove a subscription.  With `target`, removes that foreign target;
   * without, removes this actor's own `onMessage` delivery for `topic`.
   * A broker UNSUBSCRIBE fires once the pattern has no consumers left.
   */
  protected unsubscribe(topic: string, options: { target?: ActorRef<MqttMessage<T>> } = {}): void {
    this.removeSubscription(topic, options.target, false);
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
  protected publish(topic: string, payload: string | Uint8Array, options?: MqttPublishOptions): boolean;
  protected publish<E>(topic: string, entity: E, options?: MqttPublishOptions): boolean;
  protected publish(topic: string, payload: unknown, options: MqttPublishOptions = {}): boolean {
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
      qos: options.qos,
      retain: options.retain,
      userProperties: options.userProperties,
    });
  }

  /**
   * The actor's payload codec (default {@link mqttJsonCodec}).  Exposed
   * so subclasses can encode/decode explicitly — e.g. to publish a bare
   * string as a JSON entity.  Only valid after `preStart`.
   */
  protected codec(): MqttCodec<unknown> {
    return (this._codec ??= this.options.codec ?? mqttJsonCodec());
  }

  /* ----------------------- sealed dispatch ----------------------- */

  /** @internal Sealed — override onMessage + hooks instead. */
  protected override onCommand(command: MqttActorMessage<T, TSelf>): void | Promise<void> {
    // Uniform `kind` dispatch over internal signals + external commands.
    //
    // Matched against the envelope union rather than the mailbox type: `TSelf`
    // is an open type parameter, and ts-pattern cannot build a `Pattern<>` for
    // a union that still contains one.  `.otherwise` is reached exactly when
    // none of our kinds hit, i.e. for an app-level `TSelf` message.
    const envelope = command as MqttCommand<T> | MqttSignal<T>;
    return match(envelope)
      .with({ kind: 'mqtt-inbound' }, (m) => this.onMqttInbound(m))
      .with({ kind: 'mqtt-connected' }, () => this.onMqttConnected())
      .with({ kind: 'mqtt-disconnected' }, (m) => this.onMqttDisconnected(m))
      .with({ kind: 'publish' }, (m) => this.onPublish(m))
      .with({ kind: 'subscribe' }, (m) => this.onSubscribe(m))
      .with({ kind: 'unsubscribe' }, (m) => this.onUnsubscribe(m))
      .otherwise(() => this.onSelfMessage(command as TSelf));
  }

  private onMqttInbound(signal: MqttInboundSignal<T>): Promise<void> {
    return this.routeInbound(signal.message);
  }

  private onMqttConnected(): void | Promise<void> {
    return this.onConnected();
  }

  private onMqttDisconnected(signal: MqttDisconnectedSignal): void | Promise<void> {
    return this.onDisconnected(signal.cause);
  }

  private onPublish(command: MqttPublishCommand<T>): void {
    this.enqueueOutbound(command.publish);
  }

  private onSubscribe(command: MqttSubscribeCommand<T>): void {
    this.registerSubscription(command.topic, { qos: command.qos, target: command.target }, true);
  }

  private onUnsubscribe(command: MqttUnsubscribeCommand<T>): void {
    this.removeSubscription(command.topic, command.target, true);
  }

  /* ----------------------- inbound routing ----------------------- */

  private async routeInbound(message: MqttMessage<T>): Promise<void> {
    let toSelf = false;
    const seen = new Set<ActorRef<MqttMessage<T>>>();
    for (const [pattern, entry] of this.registry) {
      if (!matchesMqttPattern(pattern, message.topic)) continue;
      if (entry.deliverToSelf) toSelf = true;
      for (const ref of entry.targets) {
        if (!seen.has(ref)) { seen.add(ref); ref.tell(message); }
      }
    }
    if (!toSelf) return;
    try {
      await this.onMessage(message);
    } catch (err) {
      if (err instanceof MqttDecodeError) return this.onInvalidMessage(err, message);
      throw err;  // ordinary supervision
    }
  }

  /* ----------------------- subscription registry ----------------- */

  /**
   * @param fromExternal true for an external `subscribe` command — it may
   *   attach a target and may create a pattern, but never rewrites the QoS
   *   of a pattern that already exists.  This is the additive mirror of the
   *   guard on {@link removeSubscription}: a controller that cannot silence
   *   the subclass's constructor-declared subscription must not be able to
   *   downgrade it either, and a QoS-2 entry re-SUBSCRIBEd at 0 is the same
   *   loss taken slowly — the application still believes delivery is
   *   exactly-once while the broker is free to drop.  false for the
   *   protected {@link subscribe} and for the `preStart` flush of the
   *   constructor's own subscriptions, which own the QoS and may change it.
   *   It also decides whether the registration is announced — see
   *   {@link announceIntroducedFilter}.  #783.
   */
  private registerSubscription(
    topic: string,
    options: { qos?: MqttQos; target?: ActorRef<MqttMessage<T>> },
    fromExternal: boolean,
  ): void {
    let entry = this.registry.get(topic);
    const introduced = entry === undefined;
    if (!entry) {
      entry = { qos: options.qos, deliverToSelf: false, targets: new Set() };
      this.registry.set(topic, entry);
    } else if (options.qos !== undefined && !fromExternal) {
      entry.qos = options.qos;  // last-writer-wins among the actor's own calls
    }
    if (options.target) {
      entry.targets.add(options.target);
      this.watchTarget(options.target, topic);
    } else {
      entry.deliverToSelf = true;
    }
    if (fromExternal && introduced) {
      this.announceIntroducedFilter(topic, entry.qos, options.target);
    }
    if (this.connectionState === 'connected' && this.client) {
      this.brokerSubscribe(topic, entry.qos);
    }
  }

  /**
   * Announce a broker-level topic filter an external `subscribe` command
   * introduced — one the actor did not already hold (#783).
   *
   * The wildcard fan-out this makes visible stays open by design: it is the
   * actor's advertised contract, and a holder of the ref can already publish
   * anywhere.  That answer is defensible precisely because an operator can
   * see it happen, which is what this record is for — a `#` nobody expected
   * is otherwise visible only in a heap dump.
   *
   * Both silences are as much of the contract as the record.  A *join* to a
   * filter already in the registry says nothing new — the broker feed and the
   * set of consumers already existed — and the subclass's own `subscribe()`
   * is the operator's own declaration, so announcing it would put a line in
   * the log for every actor that starts and bury the one line that means
   * something.
   *
   * Printed: the filter; the QoS the SUBSCRIBE actually carries, which is not
   * necessarily the command's (an existing entry keeps its own, an absent one
   * resolves to the actor's default); and enough of the destination to tell a
   * foreign ref from this actor's own `onMessage`, since which of the two it
   * is decides whether the feed is being mirrored to somebody else.  Not
   * printed: anything from a message.  One line per new filter must never
   * become one line per payload.
   *
   * Printing the filter itself is a decision rather than a default, because a
   * topic path really can carry a secret — ThingSpeak puts a channel's write
   * API key in the topic, and device-per-topic schemes routinely embed a
   * serial.  It is printed anyway on two grounds: a redacted filter would
   * make the record useless for the single question it exists to answer, and
   * this class already prints the same string verbatim at warn on both
   * broker-failure paths, so info adds no new class of disclosure.  What *is*
   * new is that a sender can now drive a log line on a success path at will,
   * which is what {@link sanitizeForSubscribeLog} answers.
   */
  private announceIntroducedFilter(
    topic: string,
    qos: MqttQos | undefined,
    target?: ActorRef<MqttMessage<T>>,
  ): void {
    const destination = target
      ? `actor '${sanitizeForSubscribeLog(target.path.toString())}'`
      : "this actor's own onMessage";
    this.log.info(
      'MqttActor: external subscribe introduced broker filter '
      + `'${sanitizeForSubscribeLog(topic)}' at QoS ${this.effectiveQos(qos)}, `
      + `delivering to ${destination}`,
    );
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

  /**
   * The base class prunes what {@link subscribeRef} registered; this actor keeps
   * its own per-pattern target registry, so it still has to hear about a death.
   */
  protected override onTerminated(signal: Terminated): void {
    this.removeTerminatedTarget(signal.actor);
  }

  private removeTerminatedTarget(ref: ActorRef): void {
    const key = ref.path.toString();
    const watchEntry = this.watched.get(key);
    if (!watchEntry) return;
    // The cell already dropped the watch on Terminated delivery — just
    // clean our own bookkeeping (no context.unwatch).
    this.watched.delete(key);
    for (const pattern of watchEntry.patterns) {
      const entry = this.registry.get(pattern);
      if (!entry) continue;
      for (const target of entry.targets) {
        if (target.path.toString() === key) { entry.targets.delete(target); break; }
      }
      if (!entry.deliverToSelf && entry.targets.size === 0) {
        this.registry.delete(pattern);
        this.brokerUnsubscribe(pattern);
      }
    }
  }

  private watchTarget(ref: ActorRef<MqttMessage<T>>, pattern: string): void {
    const key = ref.path.toString();
    let watchEntry = this.watched.get(key);
    if (!watchEntry) {
      watchEntry = { ref, patterns: new Set() };
      this.watched.set(key, watchEntry);
      this.context.watch(ref);
    }
    watchEntry.patterns.add(pattern);
  }

  private unwatchTarget(ref: ActorRef<MqttMessage<T>>, pattern: string): void {
    const key = ref.path.toString();
    const watchEntry = this.watched.get(key);
    if (!watchEntry) return;
    watchEntry.patterns.delete(pattern);
    if (watchEntry.patterns.size === 0) {
      this.watched.delete(key);
      this.context.unwatch(ref);
    }
  }

  /**
   * The QoS a SUBSCRIBE for a registry entry actually carries.
   *
   * Factored out so {@link announceIntroducedFilter} and the broker call
   * cannot drift apart: a record naming a QoS the SUBSCRIBE did not carry
   * would be worse than no record, since it reads as an observation.
   */
  private effectiveQos(qos: MqttQos | undefined): MqttQos {
    return qos ?? this.options.qos ?? 0;
  }

  private brokerSubscribe(topic: string, qos?: MqttQos): void {
    this.client?.subscribe(topic, { qos: this.effectiveQos(qos) }, (err) => {
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
    // Context is attached before preStart; options resolve inside
    // super.preStart().  Flush constructor subscriptions into the
    // registry (idempotent) so connectImplementation applies them on connect.
    for (const pendingSub of this.pendingSubs) {
      this.registerSubscription(pendingSub.topic, { qos: pendingSub.qos, target: pendingSub.target }, false);
    }
    this._started = true;
    await super.preStart();
  }

  protected configKey(): string { return ConfigKeys.io.broker.mqtt; }

  protected builtInDefaultOptions(): Partial<MqttOptionsType> {
    return { qos: 0, cleanSession: true, keepAlive: 60 };
  }

  protected readOptionsFromConfig(config: Config): Partial<MqttOptionsType> {
    const out: { -readonly [K in keyof MqttOptionsType]?: MqttOptionsType[K] } = {};
    if (config.hasPath('brokerUrl')) out.brokerUrl = config.getString('brokerUrl');
    if (config.hasPath('clientId')) out.clientId = config.getString('clientId');
    if (config.hasPath('credentials')) {
      const cc = config.getConfig('credentials');
      out.credentials = {
        username: cc.hasPath('username') ? cc.getString('username') : undefined,
        password: cc.hasPath('password') ? cc.getString('password') : undefined,
      };
    }
    if (config.hasPath('qos')) out.qos = config.getInt('qos') as MqttQos;
    if (config.hasPath('cleanSession')) out.cleanSession = config.getBoolean('cleanSession');
    if (config.hasPath('keepAlive')) out.keepAlive = config.getInt('keepAlive');
    // Value validation (protocolVersion ∈ {4,5}, etc.) is enforced uniformly
    // by optionsValidator() on the merged options — see MqttOptionsValidator.
    if (config.hasPath('protocolVersion')) out.protocolVersion = config.getInt('protocolVersion') as 4 | 5;
    return out;
  }

  protected requiredOptions(): ReadonlyArray<keyof MqttOptionsType> { return ['brokerUrl']; }
  protected override optionsValidator(): MqttOptionsValidator { return new MqttOptionsValidator(); }
  protected endpointLabel(): string { return this.options.brokerUrl ?? '<unknown>'; }

  /** @internal Test seam — override to inject a fake mqtt module. */
  protected mqttModule(): Promise<MqttModuleLike> { return mqttLazy.get(); }

  protected async connectImplementation(): Promise<void> {
    const mqtt = await this.mqttModule();
    const connectOptions: MqttConnectOptions = {
      clientId: this.options.clientId,
      username: this.options.credentials?.username,
      password: this.options.credentials?.password,
      clean: this.options.cleanSession,
      keepalive: this.options.keepAlive,
      protocolVersion: this.options.protocolVersion ?? 4,
      // mqtt.js hands its connect options straight to `tls.connect` for the
      // `mqtts` / `wss` transports, so the certificate material sits flat
      // beside the protocol fields rather than under a `tls` key (#743).
      ...(toBrokerDriverTls(this.options.tls) ?? {}),
    };
    if (this.options.will) {
      connectOptions.will = {
        topic: this.options.will.topic,
        payload: this.options.will.payload,
        qos: this.options.will.qos ?? 0,
        retain: this.options.will.retain ?? false,
      };
    }
    return new Promise<void>((resolve, reject) => {
      const client = mqtt.connect(this.options.brokerUrl!, connectOptions);
      let done = false;
      let down = false;
      // mqtt.js can fire 'error' then 'close' for one drop — collapse them.
      const onDown = (cause: Error): void => {
        if (down) return;
        down = true;
        this.self.tell(mqttDisconnectedSignal(cause));
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
          this.self.tell(mqttInboundSignal<T>({
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
        this.self.tell(mqttConnectedSignal());
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

  protected async disconnectImplementation(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    return new Promise<void>((resolve) => {
      client.removeAllListeners();
      client.end(false, {}, () => resolve());
      setTimeout(resolve, 1_000);
    });
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<MqttPublish>): Promise<void> {
    if (!this.client) throw new Error('MqttActor: not connected');
    const payload = env.payload;
    const qos = payload.qos ?? this.options.qos ?? 0;
    const retain = payload.retain ?? false;
    const protocolVersion = this.options.protocolVersion ?? 4;
    const publishOptions: MqttPubOpts = { qos, retain };
    const properties = buildPublishProperties(payload, protocolVersion);
    if (properties) publishOptions.properties = properties;
    return new Promise<void>((resolve, reject) => {
      this.client!.publish(payload.topic, payload.payload as string | Uint8Array, publishOptions, (err) => {
        err ? reject(err) : resolve();
      });
    });
  }
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

/* ------------------------ subscribe-advisory rendering ----------------- */

/**
 * Any C0/C1 control character, plus the Unicode line and paragraph separators
 * — the set that must never reach a log line verbatim.
 *
 * The regex *is* the rule, so it stays beside the only function that applies
 * it.  CR and LF are the ones that matter: a logger writes one line per
 * record, so a value carrying either forges further lines that read exactly
 * like genuine ones.  The rest of the control range is in because none of it
 * belongs in a diagnostic value, and U+2028/U+2029 because enough log
 * processors treat those as line breaks too.
 */
const LOG_UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;

/**
 * Clip and escape a value an external caller controls, before it reaches the
 * advisory {@link MqttActor} writes for a newly introduced topic filter.
 *
 * Both of that record's variable fields qualify.  The topic filter is
 * verbatim from the `subscribe` command, and a fan-out target's path comes
 * off the wire whenever the ref is a remote one — neither is this process's
 * own text, and both are printed on a success path a sender can drive at
 * will.
 *
 * Escaped rather than dropped, for the reason the filter is printed at all:
 * the value *is* the diagnostic, and a sender that put a newline in a topic
 * filter has told an operator something worth seeing in escaped form.
 *
 * The same shape as `sanitizeWireKindForLog` in the cluster transport, and
 * deliberately a second small copy rather than an import: `src/io/` does not
 * depend on `src/cluster/`, and a shared `src/util/` helper is worth
 * extracting once a third subsystem needs one — two is not yet a pattern.
 */
function sanitizeForSubscribeLog(value: string): string {
  const clipped = value.length > MQTT_LOGGED_SUBSCRIBE_FIELD_MAX_CHARACTERS
    ? `${value.slice(0, MQTT_LOGGED_SUBSCRIBE_FIELD_MAX_CHARACTERS)}…`
    : value;
  return clipped.replace(
    LOG_UNSAFE_CHARACTERS,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/* --------------------------- MQTT topic match -------------------------- */

/** Standard MQTT pattern match: `+` matches one segment, `#` matches the rest. */
export function matchesMqttPattern(pattern: string, topic: string): boolean {
  const ps = pattern.split('/');
  const ts = topic.split('/');
  for (let i = 0; i < ps.length; i++) {
    const patternSegment = ps[i]!;
    if (patternSegment === '#') return true;
    if (i >= ts.length) return false;
    if (patternSegment === '+') continue;
    if (patternSegment !== ts[i]) return false;
  }
  return ps.length === ts.length;
}

/* ----------------------------- peer-dep shapes -------------------------- */

type MqttConnectOptions = {
  clientId?: string;
  username?: string;
  password?: string;
  clean?: boolean;
  keepalive?: number;
  /** mqtt.js: 4 (3.1.1), 5 (5.0).  We allow 4 and 5. */
  protocolVersion?: 4 | 5;
  will?: { topic: string; payload: Uint8Array | string; qos: MqttQos; retain: boolean };
  ca?: string | Uint8Array;
  cert?: string | Uint8Array;
  key?: string | Uint8Array;
  rejectUnauthorized?: boolean;
  servername?: string;
};

type MqttPubOpts = {
  qos: MqttQos;
  retain: boolean;
  /** mqtt-packet v5 properties — attached only when protocolVersion=5. */
  properties?: { userProperties?: MqttUserProperties };
};

/**
 * Inbound packet shape read off mqtt.js.  v5 nests user properties +
 * reason codes under `properties`; absent on 3.1.1.  Exported as a test
 * seam so a fake client can build the same shape.
 */
export type MqttInboundPacketLike = {
  qos?: number;
  retain?: boolean;
  properties?: {
    userProperties?: MqttUserProperties;
    reasonCode?: number;
  };
};

/**
 * Minimal surface of the mqtt.js client we rely on.  Exported as a test
 * seam so subclasses overriding {@link MqttActor.mqttModule} can satisfy
 * the same shape without the real peer-dep.
 */
export interface MqttClientLike {
  on(event: 'message', listener: (topic: string, payload: Uint8Array, packet?: MqttInboundPacketLike) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: () => void): void;
  once(event: 'connect', listener: () => void): void;
  once(event: 'error', listener: (err: Error) => void): void;
  removeAllListeners(event?: string): void;
  publish(topic: string, payload: string | Uint8Array, options: MqttPubOpts, callback?: (err?: Error) => void): void;
  subscribe(topic: string, options: { qos: MqttQos }, callback?: (err?: Error) => void): void;
  unsubscribe(topic: string, options: undefined, callback?: (err?: Error) => void): void;
  end(force?: boolean, options?: object, callback?: () => void): void;
}

/** The `mqtt` module surface we use.  Exported as a test seam. */
export interface MqttModuleLike {
  connect(url: string, options?: MqttConnectOptions): MqttClientLike;
}

const mqttLazy: Lazy<Promise<MqttModuleLike>> = Lazy.of(
  () => lazyImportModule<MqttModuleLike>('mqtt', { context: 'MqttActor' }),
);
