/**
 * Codec seam for the typed WebSocket stack.  A codec turns application
 * messages into wire frames and back:
 *
 *   - `encode(msg: TOut): WsFrame`  — outbound (server→client / client→server)
 *   - `decode(frame: WsFrame): TIn` — inbound
 *
 * `TOut` comes first to match the actor-class generic order
 * (`WebSocketServerActor<TOut, TIn>`).  The default is {@link jsonCodec};
 * {@link rawCodec} is the escape hatch for apps that want the raw frames
 * (e.g. binary audio).  Custom codecs (CBOR, protobuf, a zod-validated
 * JSON codec) implement the same two methods.
 *
 * Error contract: `decode` throws {@link WsDecodeError} on malformed
 * input — the connection layer then applies the route's
 * `onInvalidMessage` policy (close / drop / hook).  `encode` throws
 * {@link WsEncodeError}; since sends are fire-and-forget the message is
 * logged and dropped rather than surfaced to the caller.
 */
import type { WsFrame } from './types.js';

/** Thrown by `decode` when an inbound frame can't be parsed or validated. */
export class WsDecodeError extends Error {
  constructor(
    message: string,
    /** The offending raw frame — useful for logging / an onInvalidMessage hook. */
    public readonly frame: WsFrame,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WsDecodeError';
  }
}

/** Thrown by `encode` when an outbound message can't be serialised. */
export class WsEncodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WsEncodeError';
  }
}

/** Bidirectional wire codec.  `TOut` = what we send, `TIn` = what we receive. */
export interface WsCodec<TOut, TIn> {
  /** Stable identifier — 'json' | 'raw' | custom.  Informational (logs). */
  readonly name: string;
  encode(msg: TOut): WsFrame;
  decode(frame: WsFrame): TIn;
}

const textDecoder = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: false });

/**
 * Default codec: application messages ↔ JSON.  Text frames are
 * `JSON.parse`d directly; binary frames are UTF-8 decoded first (so a
 * client that sends JSON as a binary frame still works).  Outbound
 * messages become text frames via `JSON.stringify`.
 *
 * Pass `validate` to run a schema check (e.g. a zod parser) on the
 * parsed value — it receives the `unknown` parse result and must return
 * (or throw for) a `TIn`.  A thrown validator is wrapped as a
 * {@link WsDecodeError}.
 */
export function jsonCodec<TOut, TIn>(opts: { validate?: (value: unknown) => TIn } = {}): WsCodec<TOut, TIn> {
  const validate = opts.validate;
  return {
    name: 'json',
    encode(msg: TOut): WsFrame {
      let data: string;
      try {
        data = JSON.stringify(msg);
      } catch (cause) {
        throw new WsEncodeError('jsonCodec: failed to stringify outbound message', { cause });
      }
      if (data === undefined) {
        // JSON.stringify(undefined) / a function returns undefined.
        throw new WsEncodeError('jsonCodec: outbound message is not JSON-serialisable');
      }
      return { kind: 'text', data };
    },
    decode(frame: WsFrame): TIn {
      const text = frame.kind === 'text' ? frame.data : textDecoder.decode(frame.data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new WsDecodeError('jsonCodec: inbound frame is not valid JSON', frame, { cause });
      }
      if (!validate) return parsed as TIn;
      try {
        return validate(parsed);
      } catch (cause) {
        throw new WsDecodeError('jsonCodec: inbound message failed validation', frame, { cause });
      }
    },
  };
}

/**
 * Escape-hatch codec: no encoding at all — `TOut` and `TIn` are both
 * {@link WsFrame}, so the actor sees and sends raw text/binary frames.
 * Use for binary protocols (audio/video) or when you want to own the
 * wire format entirely.
 */
export function rawCodec(): WsCodec<WsFrame, WsFrame> {
  return {
    name: 'raw',
    encode: (frame: WsFrame): WsFrame => frame,
    decode: (frame: WsFrame): WsFrame => frame,
  };
}
