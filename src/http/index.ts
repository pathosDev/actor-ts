export { HttpExtension, HttpExtensionId } from './HttpExtension.js';
export type { ServerBuilder } from './HttpExtension.js';

export {
  concat,
  complete,
  completeJson,
  completeText,
  compile,
  del,
  get,
  head,
  options,
  patch,
  path,
  pathParam,
  pathPrefix,
  post,
  put,
  queryParam,
  redirect,
  reject,
  withMiddleware,
} from './Route.js';
export type {
  CompiledRoute,
  CompiledWebSocketRoute,
  CompiledEndpoint,
  Middleware,
  Route,
  WebSocketConnectHandler,
} from './Route.js';

// Auth + IP-allowlist middleware (#312).  Exported from
// `./middleware/index.js`; barrel re-exports both for convenience.
export { BearerTokenAuth, IpAllowlist } from './middleware/index.js';
export type { BearerTokenAuthOptions, IpAllowlistOptions } from './middleware/index.js';

export { entity, marshal, pickRequestSerializer, pickResponseSerializer } from './Marshalling.js';

export { HttpClient } from './HttpClient.js';
export type { HttpClientRequest, HttpClientResponse } from './HttpClient.js';

export { FastifyBackend } from './backend/FastifyBackend.js';
export { ExpressBackend } from './backend/ExpressBackend.js';
export type { ExpressBackendOptions } from './backend/ExpressBackend.js';
export { HonoBackend } from './backend/HonoBackend.js';
export type { HonoBackendOptions } from './backend/HonoBackend.js';
export type {
  HttpServerBackend,
  RouteRegistration,
  WebSocketRouteRegistration,
  ServerBinding,
} from './backend/HttpServerBackend.js';
export type { WebSocketSocketAdapter, WebSocketListeners } from './ws/SocketAdapter.js';

export {
  HttpError,
  Status,
} from './types.js';
export type { HttpMethod, HttpRequest, HttpResponse } from './types.js';

// HTTP caching middleware (response-cache, rate-limit, idempotency-key).
export { rateLimit, idempotent, cached } from './cache/index.js';
export type {
  RateLimitOptions,
  RateLimitContext,
  IdempotencyOptions,
  ResponseCacheOptions,
} from './cache/index.js';
