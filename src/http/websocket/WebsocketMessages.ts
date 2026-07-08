/**
 * The internal envelope that flows into a {@link WebsocketServerActor}'s
 * mailbox.  Users never construct or match these — the base class
 * dispatches them to `onMessage` / `onClient*` hooks.  Delivering
 * lifecycle events *through the mailbox* (rather than via out-of-band
 * callbacks) preserves the actor's single-threaded guarantee and gives
 * a strict per-connection order: connected → messages (in order) →
 * disconnected.
 */
import type { ActorRef } from '../../ActorRef.js';
import type { Props } from '../../Props.js';
import type { WebsocketDecodeError } from './WebsocketCodec.js';
import type { WebsocketConnection } from './WebsocketConnection.js';
import type { WebsocketCloseInfo } from './types.js';

/**
 * Ask the hub to spawn a per-connection actor as its own child.  Sent by
 * the wiring layer at upgrade time; the hub does `context.spawn(props,
 * name)` so the connection actor is a genuine sub-actor of the server.
 */
export class WebsocketAcceptSignal {
  readonly _wsSignal = 'accept' as const;
  constructor(
    readonly props: Props<unknown>,
    readonly name: string,
  ) {}
}

export class WebsocketConnectedSignal<TOut> {
  readonly _wsSignal = 'connected' as const;
  constructor(readonly connection: WebsocketConnection<TOut>) {}
}

export class WebsocketDataSignal<TOut, TIn> {
  readonly _wsSignal = 'data' as const;
  constructor(
    readonly connection: WebsocketConnection<TOut>,
    readonly message: TIn,
  ) {}
}

export class WebsocketDisconnectedSignal<TOut> {
  readonly _wsSignal = 'disconnected' as const;
  constructor(
    readonly connection: WebsocketConnection<TOut>,
    readonly info: WebsocketCloseInfo,
  ) {}
}

export class WebsocketInvalidSignal<TOut> {
  readonly _wsSignal = 'invalid' as const;
  constructor(
    readonly connection: WebsocketConnection<TOut>,
    readonly error: WebsocketDecodeError,
  ) {}
}

export type WebsocketServerSignal<TOut, TIn> =
  | WebsocketAcceptSignal
  | WebsocketConnectedSignal<TOut>
  | WebsocketDataSignal<TOut, TIn>
  | WebsocketDisconnectedSignal<TOut>
  | WebsocketInvalidSignal<TOut>;

/**
 * Full mailbox type of a hub actor: the internal signals plus any
 * application messages (`TSelf`) other actors may `tell` it — e.g. a
 * ticker that triggers a broadcast.  `TSelf` defaults to `never`.
 */
export type WebsocketServerMessage<TOut, TIn, TSelf = never> = TSelf | WebsocketServerSignal<TOut, TIn>;

/** Convenience alias for a reference to a hub actor. */
export type WebsocketServerRef<TOut, TIn, TSelf = never> = ActorRef<WebsocketServerMessage<TOut, TIn, TSelf>>;

/* -------------------------- client-side signals -------------------------- */

/** Outbound send pushed into a client actor's mailbox by another actor. */
export class WebsocketClientSend<TOut> {
  readonly _wsClient = 'send' as const;
  constructor(readonly msg: TOut) {}
}
/** A decoded inbound message from the server (delivered to the actor's mailbox). */
export class WebsocketClientInbound<TIn> {
  readonly _wsClient = 'inbound' as const;
  constructor(readonly msg: TIn) {}
}
/** An inbound frame that failed to decode. */
export class WebsocketClientInvalid {
  readonly _wsClient = 'invalid' as const;
  constructor(readonly error: WebsocketDecodeError) {}
}
/** The connection (re)opened. */
export class WebsocketClientConnected {
  readonly _wsClient = 'connected' as const;
}
/** The connection dropped (a reconnect cycle may follow). */
export class WebsocketClientDisconnected {
  readonly _wsClient = 'disconnected' as const;
  constructor(readonly cause?: Error) {}
}

export type WebsocketClientSignal<TOut, TIn> =
  | WebsocketClientSend<TOut>
  | WebsocketClientInbound<TIn>
  | WebsocketClientInvalid
  | WebsocketClientConnected
  | WebsocketClientDisconnected;

/** Full mailbox type of a client actor: internal signals + app messages. */
export type WebsocketClientMessage<TOut, TIn, TSelf = never> = TSelf | WebsocketClientSignal<TOut, TIn>;

/** Push a typed outbound message through a client actor's ref: `ref.tell(websocketSend(m))`. */
export function websocketSend<TOut>(msg: TOut): WebsocketClientSend<TOut> {
  return new WebsocketClientSend(msg);
}
