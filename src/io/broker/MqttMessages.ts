/**
 * Message types, the lazily-decoding payload wrapper, external control
 * commands, and internal mailbox signals for {@link MqttActor}.  Split
 * out of `MqttActor.ts` so the payload wrapper + codec have no import
 * cycle with the actor class.
 */
import type { ActorRef } from '../../ActorRef.js';
import { MqttDecodeError, type MqttCodec } from './MqttCodec.js';

/** MQTT QoS levels.  0 = at-most-once, 1 = at-least-once, 2 = exactly-once. */
export type MqttQos = 0 | 1 | 2;

/**
 * Multi-valued user-property bag carried alongside an MQTT 5.0
 * message.  Same shape as the underlying mqtt-packet's
 * `properties.userProperties` field — a single key may map to one
 * value or an array of values (the protocol allows duplicates).
 * Absent when the broker / client is on MQTT 3.1.1.
 */
export type MqttUserProperties = Record<string, string | string[]>;

const textDecoder = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: false });

/**
 * Lazily-decoding view over an inbound MQTT payload.  The raw
 * {@link bytes} are always available; {@link text} and {@link entity}
 * decode on first call and cache the result — payloads are immutable
 * and fan-out delivers the same instance to multiple handlers, so the
 * common case is repeated reads of one value.
 *
 * Decode *errors* are not cached: decoding is deterministic, so a
 * repeated call re-throws an equivalent {@link MqttDecodeError} rather
 * than returning a stale success.
 *
 * `T` is the actor's default inbound entity type; `entity<U>()` lets a
 * single actor read a differently-typed payload on a specific topic.
 */
export class MqttPayload<T = unknown> {
  private _text: string | undefined;
  private _entity: unknown;
  private _entityDecoded = false;

  constructor(
    /** Raw payload bytes exactly as received from the broker. */
    public readonly bytes: Uint8Array,
    private readonly codec: MqttCodec<unknown>,
    /** Topic the payload arrived on — carried into decode errors. */
    private readonly topic?: string,
  ) {}

  /** Byte length of the raw payload. */
  get byteLength(): number {
    return this.bytes.byteLength;
  }

  /** UTF-8 view of the raw bytes.  Cached after the first call. */
  text(): string {
    return (this._text ??= textDecoder.decode(this.bytes));
  }

  /**
   * Decode the payload via the actor's codec (default: JSON).  Cached
   * after the first successful call; `U` is a type-assertion convenience
   * over the same cached value, **not** a re-decode with a different
   * codec.  Throws {@link MqttDecodeError} (carrying the topic + raw
   * bytes) on a malformed payload — non-`MqttDecodeError` codec throws
   * are wrapped.
   */
  entity<U = T>(): U {
    if (this._entityDecoded) return this._entity as U;
    let decoded: unknown;
    try {
      decoded = this.codec.decode(this.bytes);
    } catch (err) {
      if (err instanceof MqttDecodeError) {
        // Enrich the codec's error with the topic it couldn't reach;
        // chain the original as the cause (avoids reading Error.cause,
        // which needs an ES2022 lib target).
        throw new MqttDecodeError(err.message, err.bytes, this.topic, { cause: err });
      }
      throw new MqttDecodeError(
        `MqttPayload.entity: decode failed${this.topic ? ` on '${this.topic}'` : ''}`,
        this.bytes,
        this.topic,
        { cause: err },
      );
    }
    this._entity = decoded;
    this._entityDecoded = true;
    return decoded as U;
  }

  /** Alias of {@link text} — keeps `${msg.payload}` readable in logs. */
  toString(): string {
    return this.text();
  }
}

/**
 * Inbound MQTT message handed to `onMessage` / fan-out targets.  The
 * payload is a lazily-decoding {@link MqttPayload} wrapper.
 */
export interface MqttMessage<T = unknown> {
  readonly topic: string;
  readonly payload: MqttPayload<T>;
  readonly qos: MqttQos;
  readonly retain: boolean;
  /**
   * MQTT 5.0 user properties on the inbound packet, if any.  Always
   * `undefined` for MQTT 3.1.1 traffic — the protocol doesn't carry
   * them.
   */
  readonly userProperties?: MqttUserProperties;
  /**
   * MQTT 5.0 PUBACK / PUBREC reason code attached to the message, if
   * the broker emitted one.  `undefined` for MQTT 3.1.1.
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

/**
 * External control commands accepted via `ref.tell(...)`.  Deliberately
 * plain discriminated objects (not classes): `ActorRef.ask` injects
 * `replyTo` with an object spread, which would strip a class prototype
 * and break `instanceof` dispatch.
 *
 * `subscribe.target` is optional — omit it to deliver matching messages
 * to the actor's own `onMessage`; pass a `target` to fan out to another
 * actor (the classic external-router shape).
 */
/**
 * Publish to a topic via the actor's client.
 *
 * Named variant of {@link MqttCommand}.  Exported so `MqttActor`'s
 * handler in the sibling module can take it as a parameter type — the
 * generic parameter mirrors {@link MqttCommand}'s (`T` is unused here
 * but kept so `MqttCommand<T>` stays uniform over its members).
 */
export type MqttPublishCommand<T = unknown> = { readonly kind: 'publish'; readonly publish: MqttPublish };

/**
 * Subscribe to `topic`.  Omit `target` to deliver to the actor's own
 * `onMessage`; pass a `target` to fan matching messages out to it.
 *
 * Named variant of {@link MqttCommand}.
 */
export type MqttSubscribeCommand<T = unknown> = {
  readonly kind: 'subscribe';
  readonly topic: string;
  readonly target?: ActorRef<MqttMessage<T>>;
  readonly qos?: MqttQos;
};

/**
 * Remove a subscription (own delivery, or a specific `target`).
 *
 * Named variant of {@link MqttCommand}.
 */
export type MqttUnsubscribeCommand<T = unknown> = {
  readonly kind: 'unsubscribe';
  readonly topic: string;
  readonly target?: ActorRef<MqttMessage<T>>;
};

export type MqttCommand<T = unknown> =
  | MqttPublishCommand<T>
  | MqttSubscribeCommand<T>
  | MqttUnsubscribeCommand<T>;

/* --------------------- internal mailbox signals --------------------- */
/*
 * Delivered to the actor's own mailbox by `connectImplementation` so that
 * inbound messages and lifecycle transitions run on the actor thread
 * (single-threaded guarantee, per-connection order preserved).  Like the
 * external commands and the typed-actor `Signal`, these are `kind`-tagged
 * plain objects — dispatch is a single uniform `kind` switch, never
 * `instanceof`.  Users never construct or match these; the base class
 * fans them out to `onMessage` / `onConnected` / `onDisconnected`.
 */

/** A message arrived on a subscribed topic. */
export interface MqttInboundSignal<T = unknown> {
  readonly kind: 'mqtt-inbound';
  readonly message: MqttMessage<T>;
}

/** The connection (re)opened; the registry has been re-applied on the broker. */
export interface MqttConnectedSignal {
  readonly kind: 'mqtt-connected';
}

/** The connection dropped (a reconnect cycle may follow). */
export interface MqttDisconnectedSignal {
  readonly kind: 'mqtt-disconnected';
  readonly cause?: Error;
}

export type MqttSignal<T = unknown> =
  | MqttInboundSignal<T>
  | MqttConnectedSignal
  | MqttDisconnectedSignal;

/** @internal Construct the inbound signal (delivered to the actor's own mailbox). */
export function mqttInboundSignal<T = unknown>(message: MqttMessage<T>): MqttInboundSignal<T> {
  return { kind: 'mqtt-inbound', message };
}
/** @internal Construct the connected signal. */
export function mqttConnectedSignal(): MqttConnectedSignal {
  return { kind: 'mqtt-connected' };
}
/** @internal Construct the disconnected signal. */
export function mqttDisconnectedSignal(cause?: Error): MqttDisconnectedSignal {
  return { kind: 'mqtt-disconnected', cause };
}

/**
 * Full mailbox type of an {@link MqttActor}: external commands, any
 * application messages (`TSelf`) other actors `tell` it, and the
 * internal signals.  `TSelf` defaults to `never`.
 */
export type MqttActorMessage<T = unknown, TSelf = never> =
  | MqttCommand<T>
  | TSelf
  | MqttSignal<T>;

/** Convenience alias for a reference to an MQTT actor. */
export type MqttRef<T = unknown, TSelf = never> = ActorRef<MqttActorMessage<T, TSelf>>;
