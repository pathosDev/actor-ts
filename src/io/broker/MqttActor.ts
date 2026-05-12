import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import type { BrokerCommonSettings } from './BrokerSettings.js';

/** MQTT QoS levels.  0 = at-most-once, 1 = at-least-once, 2 = exactly-once. */
export type MqttQos = 0 | 1 | 2;

export interface MqttSubscription {
  readonly topic: string;
  readonly qos?: MqttQos;
  readonly target: ActorRef<MqttMessage>;
}

/**
 * Multi-valued user-property bag carried alongside an MQTT 5.0
 * message.  Same shape as the underlying mqtt-packet's
 * `properties.userProperties` field — a single key may map to one
 * value or an array of values (the protocol allows duplicates).
 * Absent when the broker / client is on MQTT 3.1.1.
 */
export type MqttUserProperties = Record<string, string | string[]>;

/** Inbound MQTT message handed to subscribers. */
export interface MqttMessage {
  readonly topic: string;
  readonly payload: Uint8Array;
  readonly qos: MqttQos;
  readonly retain: boolean;
  /**
   * MQTT 5.0 user properties on the inbound packet, if any.  Always
   * `undefined` for MQTT 3.1.1 traffic — the protocol doesn't carry
   * them.  See {@link MqttActorSettings.protocolVersion}.
   */
  readonly userProperties?: MqttUserProperties;
  /**
   * MQTT 5.0 PUBACK / PUBREC reason code attached to the message,
   * if the broker emitted one.  `undefined` for MQTT 3.1.1 or for
   * unprompted publishes.  See the MQTT 5.0 spec § 2.4 "Reason Code"
   * for the value space.
   */
  readonly reasonCode?: number;
}

/** Outbound publish envelope. */
export interface MqttPublish {
  readonly topic: string;
  readonly payload: Uint8Array | string;
  readonly qos?: MqttQos;
  readonly retain?: boolean;
  /**
   * MQTT 5.0 user properties to attach to the PUBLISH packet.
   * Silently dropped when the actor's `protocolVersion` is 4 — the
   * 3.1.1 wire format has no way to carry them.
   */
  readonly userProperties?: MqttUserProperties;
}

export interface MqttCredentials {
  readonly username?: string;
  readonly password?: string;
}

export interface MqttActorSettings extends BrokerCommonSettings {
  /** Broker URL — `mqtt://`, `mqtts://`, `ws://`, `wss://`. */
  readonly brokerUrl?: string;
  /** Stable client id.  When omitted the broker assigns one. */
  readonly clientId?: string;
  readonly credentials?: MqttCredentials;
  /** Default QoS used by `publish` / `subscribe` when not overridden per call. */
  readonly defaultQos?: MqttQos;
  /** Initial subscriptions wired up immediately after connect. */
  readonly subscriptions?: ReadonlyArray<MqttSubscription>;
  /** Last-will-and-testament published by the broker if the actor disconnects ungracefully. */
  readonly will?: { readonly topic: string; readonly payload: Uint8Array | string; readonly qos?: MqttQos; readonly retain?: boolean };
  /** Clean-session flag.  Default `true`. */
  readonly cleanSession?: boolean;
  /** Keep-alive interval in seconds.  Default 60. */
  readonly keepAliveSec?: number;
  /**
   * MQTT protocol version negotiated with the broker.  Default `4`
   * (MQTT 3.1.1) for back-compat with every existing config; set to
   * `5` to opt in to MQTT 5.0 features (user properties + reason
   * codes — see {@link MqttPublish.userProperties} +
   * {@link MqttMessage.reasonCode}).  The peer-dep `mqtt` handles
   * the wire negotiation; we only flip the flag.
   */
  readonly protocolVersion?: 4 | 5;
}

export type MqttCmd =
  | { readonly kind: 'publish'; readonly publish: MqttPublish }
  | { readonly kind: 'subscribe'; readonly topic: string; readonly target: ActorRef<MqttMessage>; readonly qos?: MqttQos }
  | { readonly kind: 'unsubscribe'; readonly topic: string; readonly target?: ActorRef<MqttMessage> };

/**
 * MQTT 3.1.1 / 5.0 actor backed by the `mqtt` peer-dep.  Inbound
 * messages are routed to subscribers via the base class' fan-out;
 * wildcard subscriptions (`+`, `#`) are honoured on the broker side
 * and locally we deliver based on the *concrete* topic the message
 * was received on (matching Paho/mqtt.js semantics).
 *
 * The `subscriptions` setting wires up topic→actor mappings at
 * connect-time; runtime `tell({ kind: 'subscribe', ... })` adds more.
 */
export class MqttActor extends BrokerActor<MqttActorSettings, MqttCmd, MqttPublish> {
  private client: MqttClientLike | null = null;
  /**
   * topic-pattern → subscribers.  Patterns can be wildcard (`a/+/c`,
   * `a/#`).  We test inbound topics against every pattern at delivery
   * time — O(n) but n is small in practice (sub-100 patterns).
   */
  private readonly patternSubs = new Map<string, Set<ActorRef<MqttMessage>>>();

  constructor(settings: Partial<MqttActorSettings> = {}) { super(settings); }

  protected configKey(): string { return 'actor-ts.io.broker.mqtt'; }
  protected builtInDefaults(): Partial<MqttActorSettings> {
    return { defaultQos: 0, cleanSession: true, keepAliveSec: 60 };
  }
  protected readSettingsFromConfig(c: Config): Partial<MqttActorSettings> {
    const out: { -readonly [K in keyof MqttActorSettings]?: MqttActorSettings[K] } = {};
    if (c.hasPath('brokerUrl')) out.brokerUrl = c.getString('brokerUrl');
    if (c.hasPath('clientId')) out.clientId = c.getString('clientId');
    if (c.hasPath('credentials')) {
      const cc = c.getConfig('credentials');
      out.credentials = {
        username: cc.hasPath('username') ? cc.getString('username') : undefined,
        password: cc.hasPath('password') ? cc.getString('password') : undefined,
      };
    }
    if (c.hasPath('defaultQos')) out.defaultQos = c.getInt('defaultQos') as MqttQos;
    if (c.hasPath('cleanSession')) out.cleanSession = c.getBoolean('cleanSession');
    if (c.hasPath('keepAliveSec')) out.keepAliveSec = c.getInt('keepAliveSec');
    if (c.hasPath('protocolVersion')) {
      const v = c.getInt('protocolVersion');
      if (v !== 4 && v !== 5) {
        throw new Error(`MqttActor: protocolVersion must be 4 or 5, got ${v}`);
      }
      out.protocolVersion = v;
    }
    return out;
  }
  protected requiredSettings(): ReadonlyArray<keyof MqttActorSettings> { return ['brokerUrl']; }
  protected endpointLabel(): string { return this.settings.brokerUrl ?? '<unknown>'; }

  protected async connectImpl(): Promise<void> {
    const mqtt = await mqttLazy.get();
    const opts: MqttConnectOptions = {
      clientId: this.settings.clientId,
      username: this.settings.credentials?.username,
      password: this.settings.credentials?.password,
      clean: this.settings.cleanSession,
      keepalive: this.settings.keepAliveSec,
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
      client.once('connect', () => {
        if (done) return;
        done = true;
        client.removeAllListeners('error');
        this.client = client;
        client.on('message', (topic, payload, packet) => {
          // MQTT 5.0 v5 properties live under `packet.properties` per
          // mqtt-packet's shape; absent on 3.1.1.  We pass them
          // through verbatim so subscribers that care can read user-
          // properties / reasonCode straight off the inbound
          // message, and those that don't are unaffected.
          this.dispatchInbound({
            topic, payload,
            qos: (packet?.qos ?? 0) as MqttQos,
            retain: packet?.retain ?? false,
            userProperties: packet?.properties?.userProperties,
            reasonCode: packet?.properties?.reasonCode,
          });
        });
        client.on('error', (e) => this.handleConnectionLost(e));
        client.on('close', () => this.handleConnectionLost(new Error('mqtt connection closed')));
        // Wire up initial subscriptions (and re-subscribe after reconnect).
        for (const sub of this.settings.subscriptions ?? []) {
          this.patternSubscribe(sub.topic, sub.target);
          client.subscribe(sub.topic, { qos: sub.qos ?? this.settings.defaultQos ?? 0 }, (err) => {
            if (err) this.log.warn(`MqttActor: initial subscribe to '${sub.topic}' failed: ${err.message}`);
          });
        }
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
    const qos = p.qos ?? this.settings.defaultQos ?? 0;
    const retain = p.retain ?? false;
    const protocolVersion = this.settings.protocolVersion ?? 4;
    const opts: MqttPubOpts = { qos, retain };
    // User properties only carry on MQTT 5.0 — silently drop them
    // on 3.1.1 (the wire format has no slot for them).  Same
    // pattern mqtt.js follows when the option mismatches the
    // negotiated protocol version.
    const properties = buildPublishProperties(p, protocolVersion);
    if (properties) opts.properties = properties;
    return new Promise<void>((resolve, reject) => {
      this.client!.publish(p.topic, p.payload as string | Uint8Array, opts, (err) => {
        err ? reject(err) : resolve();
      });
    });
  }

  override onReceive(cmd: MqttCmd): void {
    // Compile-time exhaustiveness: adding a new MqttCmd variant
    // forces this site to handle it explicitly.
    match(cmd)
      .with({ kind: 'publish' }, (c) => {
        this.enqueueOutbound(c.publish);
      })
      .with({ kind: 'subscribe' }, (c) => {
        this.patternSubscribe(c.topic, c.target);
        // If already connected, register on the broker too.  Reconnect
        // re-runs the initial subscriptions; runtime additions persist
        // only via the local pattern map — we don't try to "remember"
        // them across reconnect (caller can re-tell after `BrokerConnected`).
        if (this.connectionState === 'connected' && this.client) {
          this.client.subscribe(c.topic, { qos: c.qos ?? this.settings.defaultQos ?? 0 },
            (err) => { if (err) this.log.warn(`MqttActor: subscribe '${c.topic}' failed: ${err.message}`); });
        }
      })
      .with({ kind: 'unsubscribe' }, (c) => {
        if (c.target) this.patternUnsubscribe(c.topic, c.target);
        else this.patternSubs.delete(c.topic);
        if (this.connectionState === 'connected' && this.client) {
          this.client.unsubscribe(c.topic, undefined, (err) => {
            if (err) this.log.warn(`MqttActor: unsubscribe '${c.topic}' failed: ${err.message}`);
          });
        }
      })
      .exhaustive();
  }

  /* ----------------------------- internals ------------------------------ */

  private patternSubscribe(pattern: string, ref: ActorRef<MqttMessage>): void {
    let set = this.patternSubs.get(pattern);
    if (!set) { set = new Set(); this.patternSubs.set(pattern, set); }
    set.add(ref);
  }

  private patternUnsubscribe(pattern: string, ref: ActorRef<MqttMessage>): void {
    const set = this.patternSubs.get(pattern);
    if (!set) return;
    set.delete(ref);
    if (set.size === 0) this.patternSubs.delete(pattern);
  }

  private dispatchInbound(msg: MqttMessage): void {
    for (const [pattern, subs] of this.patternSubs) {
      if (matchesMqttPattern(pattern, msg.topic)) {
        for (const ref of subs) ref.tell(msg);
      }
    }
  }
}

/* --------------------------- MQTT 5.0 helpers -------------------------- */

/**
 * Build the mqtt-packet `properties` object for an outbound publish,
 * or `undefined` if there's nothing v5-specific to attach.  Pure
 * function — testable without a real broker or mqtt.js install
 * (see `tests/unit/io/broker/MqttActor.test.ts`).
 *
 * `protocolVersion < 5` always returns undefined: the 3.1.1 wire
 * format has no slot for user properties, so we drop them rather
 * than letting them leak into the publish callsite and confuse
 * downstream tooling.
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

/* ----------------------------- internals -------------------------------- */

interface MqttConnectOptions {
  clientId?: string;
  username?: string;
  password?: string;
  clean?: boolean;
  keepalive?: number;
  /** mqtt.js: 3 (MQTT 3.1), 4 (3.1.1), 5 (5.0).  We allow 4 and 5. */
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
 * Inbound packet shape we read off mqtt.js.  v5 nests user
 * properties + reason codes under `properties`; on 3.1.1 it's
 * absent.  Typed permissively so the same callback signature works
 * for both versions.
 */
interface MqttInboundPacket {
  qos?: number;
  retain?: boolean;
  properties?: {
    userProperties?: MqttUserProperties;
    reasonCode?: number;
  };
}

interface MqttClientLike {
  on(event: 'message', cb: (topic: string, payload: Uint8Array, packet?: MqttInboundPacket) => void): void;
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

interface MqttModule {
  connect(url: string, opts?: MqttConnectOptions): MqttClientLike;
}

const mqttLazy: Lazy<Promise<MqttModule>> = Lazy.of(async () => {
  try {
    const name = 'mqtt';
    return (await import(name)) as unknown as MqttModule;
  } catch (e) {
    throw new Error(
      'MqttActor requires the "mqtt" package.  Install it with: npm install mqtt\n'
      + 'Original error: ' + (e instanceof Error ? e.message : String(e)),
    );
  }
});
