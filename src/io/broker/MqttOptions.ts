/**
 * Fluent builder for {@link MqttActorSettings}.  A subclass takes an
 * `MqttOptions` in its constructor and tacks on per-instance settings
 * before calling `super(...)`:
 *
 *     class MyClient extends MqttActor {
 *       constructor(opts: MqttOptions) {
 *         super(opts.withQos(1).withClientId('my-client'));
 *         this.subscribe('some/topic/#');
 *       }
 *     }
 *
 * The builder accumulates a `Partial<MqttActorSettings>`; `build()` (from
 * {@link OptionsBuilder}) snapshots it and feeds the exact same
 * three-layer merge (constructor > HOCON under `actor-ts.io.broker.mqtt`
 * > built-in defaults).  The common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptions}.
 */
import { BrokerOptions } from './BrokerOptions.js';
import type { MqttCodec } from './MqttCodec.js';
import type { MqttQos } from './MqttMessages.js';
import type { MqttActorSettings, MqttCredentials } from './MqttActor.js';

export class MqttOptions extends BrokerOptions<MqttActorSettings> {
  /** Start a fresh builder.  Equivalent to `new MqttOptions()`. */
  static create(): MqttOptions {
    return new MqttOptions();
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
  withWill(will: NonNullable<MqttActorSettings['will']>): this {
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

// Re-export for callers that build credentials inline.
export type { MqttCredentials };
