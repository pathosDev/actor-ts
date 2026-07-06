/**
 * Payload codec seam for {@link MqttActor}.  A codec turns an outbound
 * entity into wire bytes and decodes an inbound payload back into a
 * typed value:
 *
 *   - `encode(value: unknown): Uint8Array` — outbound (publish an entity)
 *   - `decode(bytes: Uint8Array): T`       — inbound (`payload.entity()`)
 *
 * The default is {@link mqttJsonCodec}.  Unlike the WebSocket stack's
 * {@link WsCodec} there is no text/binary frame distinction — MQTT
 * payloads are raw byte strings, so the codec works in `Uint8Array`
 * directly.
 *
 * We deliberately do **not** route through `JsonSerializer`: its tagged
 * wrappers (`{"__date__": …}`, `{"__bytes__": …}`) are an actor-ts wire
 * convention that would leak onto topics read by foreign, non-actor-ts
 * MQTT consumers.  A plain `JSON.stringify`/`JSON.parse` keeps payloads
 * interoperable.
 *
 * Error contract: `decode` throws {@link MqttDecodeError} on malformed
 * input.  Because decoding is lazy (`payload.entity()` is called by user
 * code inside `onMessage`), that error surfaces there and is routed to
 * the actor's `onDecodeError` hook.  `encode` throws
 * {@link MqttEncodeError}; since publishes are fire-and-forget the
 * message is logged and dropped rather than surfaced to the caller.
 */

/** Thrown by {@link MqttPayload.entity} / a codec's `decode` on malformed payloads. */
export class MqttDecodeError extends Error {
  constructor(
    message: string,
    /** Raw payload bytes — useful for logging / dead-lettering. */
    public readonly bytes: Uint8Array,
    /** Topic the payload arrived on, when known. */
    public readonly topic?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MqttDecodeError';
  }
}

/** Thrown by a codec's `encode` when an outbound entity can't be serialised. */
export class MqttEncodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MqttEncodeError';
  }
}

/**
 * Payload codec.  `T` types the *inbound* entity (what `decode` yields);
 * `encode` deliberately takes `unknown` so a single codec instance can
 * serialise arbitrary outbound entity types passed to `publish`.
 */
export interface MqttCodec<T = unknown> {
  /** Stable identifier — 'json' | custom.  Informational (logs). */
  readonly name: string;
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): T;
}

const textEncoder = /* @__PURE__ */ new TextEncoder();
const textDecoder = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: false });

/**
 * Default codec: entities ↔ UTF-8 JSON.  `encode` runs `JSON.stringify`
 * then UTF-8 encodes; `decode` UTF-8 decodes then `JSON.parse`s.
 *
 * Pass `validate` to run a schema check (e.g. a zod parser) on the
 * parsed value — it receives the `unknown` parse result and must return
 * (or throw for) a `T`.  A thrown validator is wrapped as a
 * {@link MqttDecodeError}.
 */
export function mqttJsonCodec<T = unknown>(opts: { validate?: (value: unknown) => T } = {}): MqttCodec<T> {
  const validate = opts.validate;
  return {
    name: 'json',
    encode(value: unknown): Uint8Array {
      let json: string;
      try {
        json = JSON.stringify(value);
      } catch (cause) {
        throw new MqttEncodeError('mqttJsonCodec: failed to stringify outbound entity', { cause });
      }
      if (json === undefined) {
        // JSON.stringify(undefined) / a function returns undefined.
        throw new MqttEncodeError('mqttJsonCodec: outbound entity is not JSON-serialisable');
      }
      return textEncoder.encode(json);
    },
    decode(bytes: Uint8Array): T {
      const text = textDecoder.decode(bytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new MqttDecodeError('mqttJsonCodec: payload is not valid JSON', bytes, undefined, { cause });
      }
      if (!validate) return parsed as T;
      try {
        return validate(parsed);
      } catch (cause) {
        throw new MqttDecodeError('mqttJsonCodec: payload failed validation', bytes, undefined, { cause });
      }
    },
  };
}
