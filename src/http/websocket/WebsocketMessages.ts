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
import type { Props } from '../../Props.js';
import type { WebsocketDecodeError } from './WebsocketCodec.js';
import type { WebsocketConnection } from './WebsocketConnection.js';
import type { WebsocketCloseInfo } from './types.js';

/* ------------------------------ server-side ------------------------------ */

/**
 * Command — ask the hub to spawn a per-connection actor as its own child.
 * Sent by the wiring layer at upgrade time; the hub does `context.spawn(
 * props, name)` so the connection actor is a genuine sub-actor of the
 * server.  A command ("do X"), not a lifecycle signal.
 */
export interface WebsocketAcceptCommand {
  readonly kind: 'websocket-accept';
  readonly props: Props<unknown>;
  readonly name: string;
}
/** @internal */
export function websocketAcceptCommand(props: Props<unknown>, name: string): WebsocketAcceptCommand {
  return { kind: 'websocket-accept', props, name };
}

/** Signal — a connection opened. */
export interface WebsocketConnectedSignal<TOut> {
  readonly kind: 'websocket-connected';
  readonly connection: WebsocketConnection<TOut>;
}
/** @internal */
export function websocketConnectedSignal<TOut>(
  connection: WebsocketConnection<TOut>,
): WebsocketConnectedSignal<TOut> {
  return { kind: 'websocket-connected', connection };
}

/** Signal — a decoded message arrived on a connection. */
export interface WebsocketDataSignal<TOut, TIn> {
  readonly kind: 'websocket-data';
  readonly connection: WebsocketConnection<TOut>;
  readonly message: TIn;
}
/** @internal */
export function websocketDataSignal<TOut, TIn>(
  connection: WebsocketConnection<TOut>,
  message: TIn,
): WebsocketDataSignal<TOut, TIn> {
  return { kind: 'websocket-data', connection, message };
}

/** Signal — a connection closed. */
export interface WebsocketDisconnectedSignal<TOut> {
  readonly kind: 'websocket-disconnected';
  readonly connection: WebsocketConnection<TOut>;
  readonly info: WebsocketCloseInfo;
}
/** @internal */
export function websocketDisconnectedSignal<TOut>(
  connection: WebsocketConnection<TOut>,
  info: WebsocketCloseInfo,
): WebsocketDisconnectedSignal<TOut> {
  return { kind: 'websocket-disconnected', connection, info };
}

/** Signal — an inbound frame that failed to decode. */
export interface WebsocketInvalidSignal<TOut> {
  readonly kind: 'websocket-invalid';
  readonly connection: WebsocketConnection<TOut>;
  readonly error: WebsocketDecodeError;
}
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
export interface WebsocketClientSend<TOut> {
  readonly kind: 'websocket-client-send';
  readonly message: TOut;
}
/** Signal — a decoded inbound message from the server. */
export interface WebsocketClientInbound<TIn> {
  readonly kind: 'websocket-client-inbound';
  readonly message: TIn;
}
/** Signal — an inbound frame that failed to decode. */
export interface WebsocketClientInvalid {
  readonly kind: 'websocket-client-invalid';
  readonly error: WebsocketDecodeError;
}
/** Signal — the connection (re)opened. */
export interface WebsocketClientConnected {
  readonly kind: 'websocket-client-connected';
}
/** Signal — the connection dropped (a reconnect cycle may follow). */
export interface WebsocketClientDisconnected {
  readonly kind: 'websocket-client-disconnected';
  readonly cause?: Error;
}

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

/** @internal */
export function websocketClientInbound<TIn>(message: TIn): WebsocketClientInbound<TIn> {
  return { kind: 'websocket-client-inbound', message };
}
/** @internal */
export function websocketClientInvalid(error: WebsocketDecodeError): WebsocketClientInvalid {
  return { kind: 'websocket-client-invalid', error };
}
/** @internal */
export function websocketClientConnected(): WebsocketClientConnected {
  return { kind: 'websocket-client-connected' };
}
/** @internal */
export function websocketClientDisconnected(cause?: Error): WebsocketClientDisconnected {
  return { kind: 'websocket-client-disconnected', cause };
}

/** Push a typed outbound message through a client actor's ref: `ref.tell(websocketSend(m))`. */
export function websocketSend<TOut>(message: TOut): WebsocketClientSend<TOut> {
  return { kind: 'websocket-client-send', message };
}
