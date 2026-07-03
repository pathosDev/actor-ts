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
import type { WsDecodeError } from './WsCodec.js';
import type { WsConnection } from './WsConnection.js';
import type { WsCloseInfo } from './types.js';

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
