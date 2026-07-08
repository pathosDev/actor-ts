/**
 * Public WebSocket API surface.  Internals (session actor, connection
 * impl, wiring, socket adapter, message signals) are intentionally NOT
 * re-exported — users interact only through `websocket()`,
 * `WebsocketServerActor`, the `WebsocketConnection` handle, and the codecs.
 */
export { websocket } from './WebsocketRoute.js';
export { WebsocketRouteOptions, WebsocketRouteOptionsBuilder } from './WebsocketRouteOptions.js';
export type { WebsocketRouteOptionsType } from './WebsocketRouteOptions.js';

export { WebsocketServerActor } from './WebsocketServerActor.js';

export { WebsocketClientActor } from './WebsocketClientActor.js';
export { WebsocketClientOptions, WebsocketClientOptionsBuilder } from './WebsocketClientOptions.js';
export type { WebsocketClientOptionsType } from './WebsocketClientOptions.js';

export type { WebsocketConnection } from './WebsocketConnection.js';
export { websocketSend } from './WebsocketMessages.js';
export type { WebsocketServerMessage, WebsocketServerRef, WebsocketClientMessage } from './WebsocketMessages.js';

export {
  jsonCodec,
  rawCodec,
  WebsocketDecodeError,
  WebsocketEncodeError,
} from './WebsocketCodec.js';
export type { WebsocketCodec } from './WebsocketCodec.js';

export type {
  OversizeFramePolicy,
  InvalidMessagePolicy,
  BackpressurePolicy,
} from './WebsocketPolicy.js';

export {
  DEFAULT_WEBSOCKET_MAX_FRAME_BYTES,
} from './types.js';
export type { WebsocketFrame, WebsocketUpgradeInfo, WebsocketCloseInfo } from './types.js';
