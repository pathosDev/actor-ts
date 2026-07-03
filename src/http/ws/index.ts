/**
 * Public WebSocket API surface.  Internals (session actor, connection
 * impl, wiring, socket adapter, message signals) are intentionally NOT
 * re-exported — users interact only through `websocket()`,
 * `WebSocketServerActor`, the `WsConnection` handle, and the codecs.
 */
export { websocket } from './WebSocketRoute.js';
export type { WebSocketRouteOptions } from './WebSocketRoute.js';

export { WebSocketServerActor } from './WebSocketServerActor.js';

export type { WsConnection } from './WsConnection.js';
export type { WsServerMessage, WsServerRef } from './WsMessages.js';

export {
  jsonCodec,
  rawCodec,
  WsDecodeError,
  WsEncodeError,
} from './WsCodec.js';
export type { WsCodec } from './WsCodec.js';

export type {
  OversizeFramePolicy,
  InvalidMessagePolicy,
  BackpressurePolicy,
} from './WsPolicy.js';

export {
  DEFAULT_WS_MAX_FRAME_BYTES,
} from './types.js';
export type { WsFrame, WsUpgradeInfo, WsCloseInfo } from './types.js';
