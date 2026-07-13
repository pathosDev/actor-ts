export { HttpExtension, HttpExtensionId } from './HttpExtension.js';
export type { ServerBuilder } from './HttpExtension.js';

export {
  concat,
  complete,
  completeJson,
  completeText,
  compile,
  defaultErrorResponse,
  del,
  fallback,
  get,
  handleErrors,
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
  CompiledWebsocketRoute,
  CompiledFallback,
  CompiledEndpoint,
  ExceptionHandler,
  Middleware,
  Route,
  WebsocketConnectHandler,
} from './Route.js';

// Auth + IP-allowlist middleware (#312) and the security-header suite
// (#353).  Exported from `./middleware/index.js`; the barrel re-exports.
export {
  BearerTokenAuth,
  IpAllowlist,
  strictTransportSecurity,
  hsts,
  HstsOptions,
  HstsOptionsBuilder,
  contentSecurityPolicy,
  CspOptions,
  CspOptionsBuilder,
  securityHeaders,
  SecurityHeadersOptions,
  SecurityHeadersOptionsBuilder,
  cors,
  CorsOptions,
  CorsOptionsBuilder,
  csrfProtection,
  requireSameOrigin,
  readCsrfToken,
  CsrfOptions,
  CsrfOptionsBuilder,
  SameOriginOptions,
  SameOriginOptionsBuilder,
  requestId,
  RequestIdOptions,
  RequestIdOptionsBuilder,
  BasicAuth,
  BasicAuthOptions,
  BasicAuthOptionsBuilder,
  requestTimeout,
  TimeoutOptions,
  TimeoutOptionsBuilder,
} from './middleware/index.js';
export type {
  BearerTokenAuthOptions,
  IpAllowlistOptions,
  HstsOptionsType,
  CspOptionsType,
  CspDirectives,
  SecurityHeadersOptionsType,
  CorsOptionsType,
  CorsOrigin,
  CsrfOptionsType,
  CsrfCookieOptions,
  SameOriginOptionsType,
  RequestIdOptionsType,
  BasicAuthOptionsType,
  TimeoutOptionsType,
} from './middleware/index.js';

export { entity, marshal, pickRequestSerializer, pickResponseSerializer } from './Marshalling.js';

// MIME-type registry — extension → content-type for static-file responses.
export { contentTypeFor, DEFAULT_MIME_TYPES } from './MimeTypes.js';

// Static file serving — getFromFile / getFromDirectory / directory browsing.
export {
  getFromFile,
  getFromDirectory,
  getFromBrowseableDirectory,
  StaticFilesOptions,
  StaticFilesOptionsBuilder,
} from './static/index.js';
export type { StaticFilesOptionsType } from './static/index.js';

// HTML response helpers — escaping + the `html` tagged template (#352).
export { escapeHtml, html, rawHtml, completeHtml, SafeHtml } from './Html.js';

// Cookie parse/serialise helpers — used by CSRF, handy for handlers too.
export { parseCookies, serializeCookie } from './cookies.js';
export type { CookieAttributes } from './cookies.js';

export { HttpClient } from './HttpClient.js';
export type { HttpClientRequest, HttpClientResponse } from './HttpClient.js';

export { FastifyBackend } from './backend/FastifyBackend.js';
export { ExpressBackend } from './backend/ExpressBackend.js';
export { ExpressBackendOptions, ExpressBackendOptionsBuilder, ExpressBackendOptionsValidator } from './backend/ExpressBackendOptions.js';
export type { ExpressBackendOptionsType } from './backend/ExpressBackendOptions.js';
export { HonoBackend } from './backend/HonoBackend.js';
export { HonoBackendOptions, HonoBackendOptionsBuilder, HonoBackendOptionsValidator } from './backend/HonoBackendOptions.js';
export type { HonoBackendOptionsType } from './backend/HonoBackendOptions.js';
export type {
  HttpServerBackend,
  RouteRegistration,
  WebsocketRouteRegistration,
  ServerBinding,
} from './backend/HttpServerBackend.js';
export type { WebsocketSocketAdapter, WebsocketListeners } from './websocket/SocketAdapter.js';

// Typed WebSocket stack — websocket() directive, server actor, codecs.
export * from './websocket/index.js';

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
