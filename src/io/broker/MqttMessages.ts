/**
 * Message types, the lazily-decoding payload wrapper, external control
 * commands, and internal mailbox signals for {@link MqttActor}.  Split
 * out of `MqttActor.ts` so the payload wrapper + codec have no import
 * cycle with the actor class.
 */
import type { ActorRef } from '../../ActorRef.js';
import type { BrokerDeliveryReply } from './BrokerAcknowledgment.js';
import { MqttDecodeError, type MqttCodec } from './MqttCodec.js';

/**
 * MQTT QoS levels, and what each one means end to end through an
 * {@link MqttActor} under the default `acknowledgment: 'on-reply'` (#977):
 *
 *   - `0` — at-most-once.  The broker expects no acknowledgment.
 *   - `1` — at-least-once.  The PUBACK goes out only once the message was
 *     processed — `onMessage` returned and every fan-out target replied —
 *     and a delivery that fails or times out drops the connection without
 *     one, so the broker redelivers it.  Redelivery needs a persistent
 *     session (`cleanSession: false`): with a clean session the broker
 *     discards the unacknowledged message on reconnect.
 *   - `2` — exactly-once on the wire.  mqtt.js sends the PUBREC itself on
 *     receipt; the actor holds back only the PUBCOMP.  A delivery that fails
 *     is therefore not redelivered — use QoS 1 for at-least-once processing.
 *
 * Under `'on-delivery'` mqtt.js acknowledges as the message enters the
 * actor's mailbox, so every level is at-most-once end to end.
 */
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
export type MqttMessage<T = unknown> = {
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
  /**
   * Where a fan-out **target** replies `{ kind: 'acknowledgment' }` once it
   * has processed the message — present only on a target's copy under the
   * default `acknowledgment: 'on-reply'`.  The actor's own `onMessage` never
   * sees one: returning is its acknowledgment, throwing its refusal.  See
   * `acknowledgeDelivery`.
   */
  readonly replyTo?: ActorRef<BrokerDeliveryReply>;
};

/** Outbound publish envelope. */
export type MqttPublish = {
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
};

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
  /**
   * Requested QoS — it applies only to a pattern **this command creates**.
   * On a pattern the actor already holds it is ignored, the held QoS stands,
   * and the actor writes one info record naming both values; a subclass
   * changes the QoS of its own pattern with `subscribe(topic, { qos })`.
   *
   * Spelled out here because this is where the rule is read: the field is
   * optional and the SUBSCRIBE still succeeds, so a caller composing the
   * command in an editor would otherwise see nothing to suggest the value can
   * be dropped.  See *External control* in the MQTT docs.  #783, #1510.
   */
  readonly qos?: MqttQos;
};

/**
 * Remove a subscription — as a command, only ever one an external `subscribe`
 * put there.
 *
 * Omitting `target` detaches every externally attached target at once; naming
 * one detaches that one.  Neither form touches the actor's own `onMessage`
 * delivery or a target the subclass declared with `subscribe(topic, { target
 * })`, so this command cannot silence a subclass's constructor-declared
 * subscription in either form it was declared.  The subclass's own protected
 * `unsubscribe` is not restricted this way.  #1510.
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
 *
 * The `kind` names a signal but does not make one: each also carries
 * {@link MQTT_SIGNAL}, which only the constructors below set, and the
 * dispatch asks for both (see {@link isMqttSignal}).
 */

/**
 * The mark every internal signal carries — the part of one that a decoded
 * message body cannot have.
 *
 * An `MqttActor` sits at an ordinary `/user` path, so what a remote node
 * addresses to that path reaches its mailbox as a plain object with the
 * peer's keys as its own, `kind` among them.  A decoder produces string keys
 * only, so a symbol-keyed property is out of its reach, and a plain
 * `Symbol()` — never `Symbol.for()`, whose registry anyone holding the
 * description can read — is out of reach of every module but this one.
 *
 * A symbol *key*, not a symbol value under a string key: the message
 * boundary check (#1386) clones a message and round-trips it through the
 * serializer, both of which skip symbol keys and both of which would report a
 * symbol value, although a signal never leaves the process.  The signal
 * types do not mention the mark; nothing outside this module builds one.
 */
const MQTT_SIGNAL = Symbol('MqttActor.signal');

/** A signal as the constructors below build it. */
type MarkedSignal = { readonly [MQTT_SIGNAL]: true };

/**
 * Where an inbound signal carries the acknowledgment the actor settles once
 * the message was processed — under a symbol key for the reason
 * {@link MQTT_SIGNAL} is one: the message-boundary check skips it, and no
 * decoded body can supply one.
 */
const MQTT_INBOUND_ACKNOWLEDGMENT = Symbol('MqttActor.inboundAcknowledgment');

/**
 * @internal The acknowledgment of one inbound message under
 * `acknowledgment: 'on-reply'` (#977): settled once by whoever finishes with
 * the message, and turned into the PUBACK — or into a dropped connection the
 * broker redelivers on — by the actor.
 */
export interface MqttInboundAcknowledgment {
  /** The message was processed: let mqtt.js acknowledge it. */
  acknowledge(): void;
  /** The message was not processed: withhold the acknowledgment. */
  fail(cause: Error): void;
}

/** A message arrived on a subscribed topic. */
export type MqttInboundSignal<T = unknown> = {
  readonly kind: 'mqtt-inbound';
  readonly message: MqttMessage<T>;
};

/** The connection (re)opened; the registry has been re-applied on the broker. */
export type MqttConnectedSignal = {
  readonly kind: 'mqtt-connected';
};

/** The connection dropped (a reconnect cycle may follow). */
export type MqttDisconnectedSignal = {
  readonly kind: 'mqtt-disconnected';
  readonly cause?: Error;
};

export type MqttSignal<T = unknown> =
  | MqttInboundSignal<T>
  | MqttConnectedSignal
  | MqttDisconnectedSignal;

/**
 * @internal Construct the inbound signal (delivered to the actor's own
 * mailbox), carrying the message's acknowledgment when one is awaited.
 */
export function mqttInboundSignal<T = unknown>(
  message: MqttMessage<T>,
  acknowledgment?: MqttInboundAcknowledgment,
): MqttInboundSignal<T> {
  const signal: MqttInboundSignal<T> & MarkedSignal & { [MQTT_INBOUND_ACKNOWLEDGMENT]?: MqttInboundAcknowledgment } = {
    kind: 'mqtt-inbound', message, [MQTT_SIGNAL]: true,
  };
  if (acknowledgment !== undefined) signal[MQTT_INBOUND_ACKNOWLEDGMENT] = acknowledgment;
  return signal;
}

/** @internal The acknowledgment an inbound signal carries, if one is awaited. */
export function inboundAcknowledgmentOf(signal: MqttInboundSignal<unknown>): MqttInboundAcknowledgment | undefined {
  return (signal as { [MQTT_INBOUND_ACKNOWLEDGMENT]?: MqttInboundAcknowledgment })[MQTT_INBOUND_ACKNOWLEDGMENT];
}
/** @internal Construct the connected signal. */
export function mqttConnectedSignal(): MqttConnectedSignal {
  const signal: MqttConnectedSignal & MarkedSignal = { kind: 'mqtt-connected', [MQTT_SIGNAL]: true };
  return signal;
}
/** @internal Construct the disconnected signal. */
export function mqttDisconnectedSignal(cause?: Error): MqttDisconnectedSignal {
  const signal: MqttDisconnectedSignal & MarkedSignal = { kind: 'mqtt-disconnected', cause, [MQTT_SIGNAL]: true };
  return signal;
}

/**
 * @internal Whether `signal` was built by one of the constructors above.
 *
 * `MqttActor`'s dispatch asks this before every signal arm, so a body that
 * merely spells a signal's `kind` — every decoded body does, if it spells one
 * at all — matches none of them and reaches `onSelfMessage`, whose default
 * declines it as a dead letter.  The requirement #1431 put on the WebSocket
 * hub's signals.
 */
export function isMqttSignal(signal: object): boolean {
  return (signal as Partial<MarkedSignal>)[MQTT_SIGNAL] === true;
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
