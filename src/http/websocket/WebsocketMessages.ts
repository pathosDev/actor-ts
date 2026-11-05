/**
 * The internal envelopes that flow into a {@link WebsocketServerActor}'s or
 * {@link WebsocketClientActor}'s mailbox.  Like the typed-actor `Signal`
 * and the broker commands, these are `kind`-tagged plain objects —
 * dispatch is a single uniform `kind` switch, never `instanceof`.  Users
 * never construct or match these; the base class fans them out to
 * `onMessage` / `onClient*` / `onConnected` hooks.
 *
 * Delivering lifecycle events *through the mailbox* (rather than via
 * out-of-band callbacks) preserves the actor's single-threaded guarantee
 * and gives a strict per-connection order: connected → messages (in
 * order) → disconnected.
 */
import type { ActorRef } from '../../ActorRef.js';
import type { ActorFactory } from '../../Actor.js';
import type { ActorOptionsType } from '../../ActorOptions.js';
import type { WebsocketDecodeError } from './WebsocketCodec.js';
import type { WebsocketConnection } from './WebsocketConnection.js';
import type { WebsocketCloseInfo } from './Types.js';

/* ------------------------------ server-side ------------------------------ */

/**
 * Command — ask the hub to spawn a per-connection actor as its own child.
 * Sent by the wiring layer at upgrade time; the hub does `context.spawn(
 * actor, name, options)` so the connection actor is a genuine sub-actor of
 * the server.  A command ("do X"), not a lifecycle signal.
 *
 * The factory rides along on the message rather than being resolved by the
 * hub: only the wiring layer has the socket and codec to close over, and the
 * command never leaves the process.
 */
export type WebsocketAcceptCommand = {
  readonly kind: 'websocket-accept';
  readonly actor: ActorFactory<unknown>;
  readonly name: string;
  /**
   * What the connection actor is spawned with — the route's connection
   * mailbox bound (#1432).  Absent when the route sets none, so the actor is
   * spawned exactly as before and falls through to `actor-ts.mailbox.default.*`.
   * Built by the wiring layer from the resolved policy for the same reason the
   * factory is: the hub serves every route bound to it, and only the wiring
   * layer knows which route this connection came in on.
   */
  readonly options?: ActorOptionsType<unknown>;
};
/** @internal */
export function websocketAcceptCommand(
  actor: ActorFactory<unknown>,
  name: string,
  options?: ActorOptionsType<unknown>,
): WebsocketAcceptCommand {
  return options === undefined
    ? { kind: 'websocket-accept', actor, name }
    : { kind: 'websocket-accept', actor, name, options };
}

/** Signal — a connection opened. */
export type WebsocketConnectedSignal<TOut> = {
  readonly kind: 'websocket-connected';
  readonly connection: WebsocketConnection<TOut>;
};
/** @internal */
export function websocketConnectedSignal<TOut>(
  connection: WebsocketConnection<TOut>,
): WebsocketConnectedSignal<TOut> {
  return { kind: 'websocket-connected', connection };
}

/** Signal — a decoded message arrived on a connection. */
export type WebsocketDataSignal<TOut, TIn> = {
  readonly kind: 'websocket-data';
  readonly connection: WebsocketConnection<TOut>;
  readonly message: TIn;
};
/** @internal */
export function websocketDataSignal<TOut, TIn>(
  connection: WebsocketConnection<TOut>,
  message: TIn,
): WebsocketDataSignal<TOut, TIn> {
  return { kind: 'websocket-data', connection, message };
}

/** Signal — a connection closed. */
export type WebsocketDisconnectedSignal<TOut> = {
  readonly kind: 'websocket-disconnected';
  readonly connection: WebsocketConnection<TOut>;
  readonly info: WebsocketCloseInfo;
};
/** @internal */
export function websocketDisconnectedSignal<TOut>(
  connection: WebsocketConnection<TOut>,
  info: WebsocketCloseInfo,
): WebsocketDisconnectedSignal<TOut> {
  return { kind: 'websocket-disconnected', connection, info };
}

/** Signal — an inbound frame that failed to decode. */
export type WebsocketInvalidSignal<TOut> = {
  readonly kind: 'websocket-invalid';
  readonly connection: WebsocketConnection<TOut>;
  readonly error: WebsocketDecodeError;
};
/** @internal */
export function websocketInvalidSignal<TOut>(
  connection: WebsocketConnection<TOut>,
  error: WebsocketDecodeError,
): WebsocketInvalidSignal<TOut> {
  return { kind: 'websocket-invalid', connection, error };
}

/** Lifecycle/data signals delivered to a hub actor's mailbox. */
export type WebsocketServerSignal<TOut, TIn> =
  | WebsocketConnectedSignal<TOut>
  | WebsocketDataSignal<TOut, TIn>
  | WebsocketDisconnectedSignal<TOut>
  | WebsocketInvalidSignal<TOut>;

/**
 * Full mailbox type of a hub actor: the accept command, the internal
 * signals, plus any application messages (`TSelf`) other actors may
 * `tell` it — e.g. a ticker that triggers a broadcast.  `TSelf` defaults
 * to `never`.
 */
export type WebsocketServerMessage<TOut, TIn, TSelf = never> =
  | TSelf
  | WebsocketAcceptCommand
  | WebsocketServerSignal<TOut, TIn>;

/** Convenience alias for a reference to a hub actor. */
export type WebsocketServerRef<TOut, TIn, TSelf = never> = ActorRef<WebsocketServerMessage<TOut, TIn, TSelf>>;

/* ------------------------------ client-side ------------------------------ */

/** Command — push a typed outbound message through a client actor's ref. */
export type WebsocketClientSend<TOut> = {
  readonly kind: 'websocket-client-send';
  readonly message: TOut;
};
/** Signal — a decoded inbound message from the server. */
export type WebsocketClientInbound<TIn> = {
  readonly kind: 'websocket-client-inbound';
  readonly message: TIn;
};
/** Signal — an inbound frame that failed to decode. */
export type WebsocketClientInvalid = {
  readonly kind: 'websocket-client-invalid';
  readonly error: WebsocketDecodeError;
};
/** Signal — the connection (re)opened. */
export type WebsocketClientConnected = {
  readonly kind: 'websocket-client-connected';
};
/** Signal — the connection dropped (a reconnect cycle may follow). */
export type WebsocketClientDisconnected = {
  readonly kind: 'websocket-client-disconnected';
  readonly cause?: Error;
};

/** Lifecycle/data signals delivered to a client actor's mailbox. */
export type WebsocketClientSignal<TIn> =
  | WebsocketClientInbound<TIn>
  | WebsocketClientInvalid
  | WebsocketClientConnected
  | WebsocketClientDisconnected;

/**
 * Full mailbox type of a client actor: the outbound-send command, the
 * internal signals, plus any application messages (`TSelf`).
 */
export type WebsocketClientMessage<TOut, TIn, TSelf = never> =
  | TSelf
  | WebsocketClientSend<TOut>
  | WebsocketClientSignal<TIn>;

/**
 * The mark every client signal carries — the part of one that a decoded
 * message body cannot have.  The `kind` names a signal but does not make one;
 * `WebsocketClientActor`'s dispatch asks for this mark as well (see
 * {@link isWebsocketClientSignal}).
 *
 * A client actor sits at an ordinary `/user` path, so what a remote node
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
 *
 * `websocket-client-send` carries no mark: it is a command, the one
 * {@link websocketSend} builds for anyone who holds the ref.
 */
const WEBSOCKET_CLIENT_SIGNAL = Symbol('WebsocketClientActor.signal');

/** A client signal as the constructors below build it. */
type MarkedClientSignal = { readonly [WEBSOCKET_CLIENT_SIGNAL]: true };

/** @internal */
export function websocketClientInbound<TIn>(message: TIn): WebsocketClientInbound<TIn> {
  const signal: WebsocketClientInbound<TIn> & MarkedClientSignal = {
    kind: 'websocket-client-inbound', message, [WEBSOCKET_CLIENT_SIGNAL]: true,
  };
  return signal;
}
/** @internal */
export function websocketClientInvalid(error: WebsocketDecodeError): WebsocketClientInvalid {
  const signal: WebsocketClientInvalid & MarkedClientSignal = {
    kind: 'websocket-client-invalid', error, [WEBSOCKET_CLIENT_SIGNAL]: true,
  };
  return signal;
}
/** @internal */
export function websocketClientConnected(): WebsocketClientConnected {
  const signal: WebsocketClientConnected & MarkedClientSignal = {
    kind: 'websocket-client-connected', [WEBSOCKET_CLIENT_SIGNAL]: true,
  };
  return signal;
}
/** @internal */
export function websocketClientDisconnected(cause?: Error): WebsocketClientDisconnected {
  const signal: WebsocketClientDisconnected & MarkedClientSignal = {
    kind: 'websocket-client-disconnected', cause, [WEBSOCKET_CLIENT_SIGNAL]: true,
  };
  return signal;
}

/**
 * @internal Whether `signal` was built by one of the client signal
 * constructors above.
 *
 * `WebsocketClientActor`'s dispatch asks this before every signal arm, so a
 * body that merely spells a signal's `kind` — every decoded body does, if it
 * spells one at all — matches none of them and reaches `onSelfMessage`,
 * whose default declines it as a dead letter.  The requirement #1431 put on
 * the hub's signals.
 */
export function isWebsocketClientSignal(signal: object): boolean {
  return (signal as Partial<MarkedClientSignal>)[WEBSOCKET_CLIENT_SIGNAL] === true;
}

/** Push a typed outbound message through a client actor's ref: `ref.tell(websocketSend(m))`. */
export function websocketSend<TOut>(message: TOut): WebsocketClientSend<TOut> {
  return { kind: 'websocket-client-send', message };
}
