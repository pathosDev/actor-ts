/**
 * The internal envelope that flows into a {@link WebSocketServerActor}'s
 * mailbox.  Users never construct or match these — the base class
 * dispatches them to `onMessage` / `onClient*` hooks.  Delivering
 * lifecycle events *through the mailbox* (rather than via out-of-band
 * callbacks) preserves the actor's single-threaded guarantee and gives
 * a strict per-connection order: connected → messages (in order) →
 * disconnected.
 */
import type { ActorRef } from '../../ActorRef.js';
import type { Props } from '../../Props.js';
import type { WsDecodeError } from './WsCodec.js';
import type { WsConnection } from './WsConnection.js';
import type { WsCloseInfo } from './types.js';

/**
 * Ask the hub to spawn a per-connection actor as its own child.  Sent by
 * the wiring layer at upgrade time; the hub does `context.spawn(props,
 * name)` so the connection actor is a genuine sub-actor of the server.
 */
export class WsAcceptSignal {
  readonly _wsSignal = 'accept' as const;
  constructor(
    readonly props: Props<unknown>,
    readonly name: string,
  ) {}
}

export class WsConnectedSignal<TOut> {
  readonly _wsSignal = 'connected' as const;
  constructor(readonly connection: WsConnection<TOut>) {}
}

export class WsDataSignal<TOut, TIn> {
  readonly _wsSignal = 'data' as const;
  constructor(
    readonly connection: WsConnection<TOut>,
    readonly message: TIn,
  ) {}
}

export class WsDisconnectedSignal<TOut> {
  readonly _wsSignal = 'disconnected' as const;
  constructor(
    readonly connection: WsConnection<TOut>,
    readonly info: WsCloseInfo,
  ) {}
}

export class WsInvalidSignal<TOut> {
  readonly _wsSignal = 'invalid' as const;
  constructor(
    readonly connection: WsConnection<TOut>,
    readonly error: WsDecodeError,
  ) {}
}

export type WsServerSignal<TOut, TIn> =
  | WsAcceptSignal
  | WsConnectedSignal<TOut>
  | WsDataSignal<TOut, TIn>
  | WsDisconnectedSignal<TOut>
  | WsInvalidSignal<TOut>;

/**
 * Full mailbox type of a hub actor: the internal signals plus any
 * application messages (`TSelf`) other actors may `tell` it — e.g. a
 * ticker that triggers a broadcast.  `TSelf` defaults to `never`.
 */
export type WsServerMessage<TOut, TIn, TSelf = never> = TSelf | WsServerSignal<TOut, TIn>;

/** Convenience alias for a reference to a hub actor. */
export type WsServerRef<TOut, TIn, TSelf = never> = ActorRef<WsServerMessage<TOut, TIn, TSelf>>;

/* -------------------------- client-side signals -------------------------- */

/** Outbound send pushed into a client actor's mailbox by another actor. */
export class WsClientSend<TOut> {
  readonly _wsClient = 'send' as const;
  constructor(readonly msg: TOut) {}
}
/** A decoded inbound message from the server (delivered to the actor's mailbox). */
export class WsClientInbound<TIn> {
  readonly _wsClient = 'inbound' as const;
  constructor(readonly msg: TIn) {}
}
/** An inbound frame that failed to decode. */
export class WsClientInvalid {
  readonly _wsClient = 'invalid' as const;
  constructor(readonly error: WsDecodeError) {}
}
/** The connection (re)opened. */
export class WsClientConnected {
  readonly _wsClient = 'connected' as const;
}
/** The connection dropped (a reconnect cycle may follow). */
export class WsClientDisconnected {
  readonly _wsClient = 'disconnected' as const;
  constructor(readonly cause?: Error) {}
}

export type WsClientSignal<TOut, TIn> =
  | WsClientSend<TOut>
  | WsClientInbound<TIn>
  | WsClientInvalid
  | WsClientConnected
  | WsClientDisconnected;

/** Full mailbox type of a client actor: internal signals + app messages. */
export type WsClientMessage<TOut, TIn, TSelf = never> = TSelf | WsClientSignal<TOut, TIn>;

/** Push a typed outbound message through a client actor's ref: `ref.tell(wsSend(m))`. */
export function wsSend<TOut>(msg: TOut): WsClientSend<TOut> {
  return new WsClientSend(msg);
}
