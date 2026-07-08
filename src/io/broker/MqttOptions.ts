/**
 * All MQTT option-relevant types live here:
 *
 *   - {@link MqttOptionsType} — the plain options-object shape (what you may
 *     also pass as a bare `{ … }` object).
 *   - {@link MqttOptionsBuilder} — the fluent builder (`MqttOptions.create()…`).
 *   - {@link MqttOptions} — the accepted-input **union**
 *     (`MqttOptionsBuilder | MqttOptionsType`), plus a value alias to the
 *     builder so `MqttOptions.create()` / `new MqttOptions()` keep working.
 *
 * A subclass takes `MqttOptions` in its constructor and tacks on per-instance
 * options before calling `super(...)`:
 *
 *     class MyClient extends MqttActor {
 *       constructor(options: MqttOptions = {}) {
 *         super(options);
 *         this.subscribe('some/topic/#');
 *       }
 *     }
 *
 * The builder records only the fields you set (as own enumerable props), so it
 * reads/spreads exactly like a plain object; the same three-layer merge applies
 * (constructor > HOCON under `actor-ts.io.broker.mqtt` > built-in defaults).
 * The common broker fields (`withReconnect` / `withCircuitBreaker` /
 * `withOutboundBuffer`) come from {@link BrokerOptionsBuilder}.
 */
import { BrokerOptionsBuilder } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import type { MqttCodec } from './MqttCodec.js';
import type { MqttQos } from './MqttMessages.js';

/** Username / password credentials. */
export interface MqttCredentials {
  readonly username?: string;
  readonly password?: string;
}

/** Plain options-object shape accepted by an {@link MqttActor}. */
export interface MqttOptionsType extends BrokerCommonOptionsType {
  /** Broker URL — `mqtt://`, `mqtts://`, `ws://`, `wss://`. */
  readonly brokerUrl?: string;
  /** Stable client id.  When omitted the broker assigns one. */
  readonly clientId?: string;
  readonly credentials?: MqttCredentials;
  /** Default QoS used by `publish` / `subscribe` when not overridden per call. */
  readonly qos?: MqttQos;
  /** Last-will-and-testament published by the broker if the actor disconnects ungracefully. */
  readonly will?: { readonly topic: string; readonly payload: Uint8Array | string; readonly qos?: MqttQos; readonly retain?: boolean };
  /** Clean-session flag.  Default `true`. */
  readonly cleanSession?: boolean;
  /** Keep-alive interval in seconds.  Default 60. */
  readonly keepAlive?: number;
  /**
   * MQTT protocol version negotiated with the broker.  Default `4`
   * (MQTT 3.1.1); set to `5` to opt in to MQTT 5.0 features (user
   * properties + reason codes — see {@link MqttPublish.userProperties}
   * + {@link MqttMessage.reasonCode}).
   */
  readonly protocolVersion?: 4 | 5;
  /**
   * Payload codec used by {@link MqttPayload.entity} (inbound decode) and
   * by `publish` when handed a non-string/non-`Uint8Array` entity.
   * Default: {@link mqttJsonCodec}.  One codec per actor.
   */
  readonly codec?: MqttCodec<unknown>;
}

/** Fluent builder for {@link MqttOptionsType}. */
export class MqttOptionsBuilder extends BrokerOptionsBuilder<MqttOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MqttOptionsBuilder()`. */
  static create(): MqttOptionsBuilder {
    return new MqttOptionsBuilder();
  }

  /** Broker URL — `mqtt://`, `mqtts://`, `ws://`, `wss://`. */
  withBrokerUrl(url: string): this {
    return this.set('brokerUrl', url);
  }

  /** Stable client id.  When omitted the broker assigns one. */
  withClientId(clientId: string): this {
    return this.set('clientId', clientId);
  }

  /** Username / password credentials. */
  withCredentials(username?: string, password?: string): this {
    return this.set('credentials', { username, password });
  }

  /** Default QoS used by `publish` / `subscribe` when not overridden per call. */
  withQos(qos: MqttQos): this {
    return this.set('qos', qos);
  }

  /** Last-will-and-testament published by the broker on ungraceful disconnect. */
  withWill(will: NonNullable<MqttOptionsType['will']>): this {
    return this.set('will', will);
  }

  /** Clean-session flag.  Default `true`. */
  withCleanSession(clean = true): this {
    return this.set('cleanSession', clean);
  }

  /** Keep-alive interval in seconds.  Default 60. */
  withKeepAlive(seconds: number): this {
    return this.set('keepAlive', seconds);
  }

  /** MQTT protocol version — 4 (3.1.1, default) or 5. */
  withProtocolVersion(version: 4 | 5): this {
    return this.set('protocolVersion', version);
  }

  /** Payload codec for `entity()` decode + entity `publish` encode.  Default JSON. */
  withCodec(codec: MqttCodec<unknown>): this {
    return this.set('codec', codec);
  }
}

/**
 * Accepted input for any MQTT-configurable constructor: the fluent
 * {@link MqttOptionsBuilder} OR a plain {@link MqttOptionsType} object.
 */
export type MqttOptions = MqttOptionsBuilder | Partial<MqttOptionsType>;
/** Value alias so `MqttOptions.create()` / `new MqttOptions()` resolve to the builder. */
export const MqttOptions = MqttOptionsBuilder;
