/**
 * Fluent builder for {@link MqttActorSettings}.  A subclass typically
 * takes an `MqttOptions` in its constructor and tacks on per-instance
 * settings before calling `super(...)`:
 *
 *     class MyClient extends MqttActor {
 *       constructor(opts: MqttOptions) {
 *         super(opts.withQos(1).withClientId('my-client'));
 *         this.subscribe('some/topic/#');
 *       }
 *     }
 *
 * The builder is a thin wrapper over a `Partial<MqttActorSettings>` — the
 * `MqttActor` constructor also accepts a plain partial, and `build()`
 * feeds the exact same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.mqtt` > built-in defaults).  Methods mutate and
 * return `this` for chaining; `build()` returns an independent copy so a
 * builder can be reused or branched safely.
 */
import type { BrokerCommonSettings } from './BrokerSettings.js';
import type { MqttCodec } from './MqttCodec.js';
import type { MqttQos } from './MqttMessages.js';
import type { MqttActorSettings, MqttCredentials } from './MqttActor.js';

export class MqttOptions {
  private readonly s: { -readonly [K in keyof MqttActorSettings]?: MqttActorSettings[K] } = {};

  /** Start a fresh builder.  Equivalent to `new MqttOptions()`. */
  static create(): MqttOptions {
    return new MqttOptions();
  }

  /** Broker URL — `mqtt://`, `mqtts://`, `ws://`, `wss://`. */
  withBrokerUrl(url: string): this {
    this.s.brokerUrl = url;
    return this;
  }

  /** Stable client id.  When omitted the broker assigns one. */
  withClientId(clientId: string): this {
    this.s.clientId = clientId;
    return this;
  }

  /** Username / password credentials. */
  withCredentials(username?: string, password?: string): this {
    this.s.credentials = { username, password };
    return this;
  }

  /** Default QoS used by `publish` / `subscribe` when not overridden per call. */
  withQos(qos: MqttQos): this {
    this.s.defaultQos = qos;
    return this;
  }

  /** Last-will-and-testament published by the broker on ungraceful disconnect. */
  withWill(will: NonNullable<MqttActorSettings['will']>): this {
    this.s.will = will;
    return this;
  }

  /** Clean-session flag.  Default `true`. */
  withCleanSession(clean = true): this {
    this.s.cleanSession = clean;
    return this;
  }

  /** Keep-alive interval in seconds.  Default 60. */
  withKeepAlive(seconds: number): this {
    this.s.keepAliveSec = seconds;
    return this;
  }

  /** MQTT protocol version — 4 (3.1.1, default) or 5. */
  withProtocolVersion(version: 4 | 5): this {
    this.s.protocolVersion = version;
    return this;
  }

  /** Payload codec for `entity()` decode + entity `publish` encode.  Default JSON. */
  withCodec(codec: MqttCodec<unknown>): this {
    this.s.codec = codec;
    return this;
  }

  /** Reconnect policy (or `false` to disable auto-reconnect). */
  withReconnect(policy: BrokerCommonSettings['reconnect']): this {
    this.s.reconnect = policy;
    return this;
  }

  /** Circuit breaker around connect attempts. */
  withCircuitBreaker(failureThreshold: number, resetMs: number): this {
    this.s.circuitBreaker = { failureThreshold, resetMs };
    return this;
  }

  /** Outbound buffer size (messages held while disconnected).  Default 1000; 0 = fail-fast. */
  withOutboundBuffer(limit: number): this {
    this.s.outboundBuffer = limit;
    return this;
  }

  /** Snapshot the accumulated settings as an independent partial. */
  build(): Partial<MqttActorSettings> {
    return { ...this.s };
  }
}

// Re-export for callers that build credentials inline.
export type { MqttCredentials };
