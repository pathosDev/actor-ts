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
  redirectExternal,
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
  DEFAULT_FORWARDED_HEADER,
  IpAllowlistOptions,
  IpAllowlistOptionsBuilder,
  IpAllowlistOptionsValidator,
  strictTransportSecurity,
  hsts,
  HstsOptions,
  HstsOptionsBuilder,
  HstsOptionsValidator,
  contentSecurityPolicy,
  CspOptions,
  CspOptionsBuilder,
  securityHeaders,
  SecurityHeadersOptions,
  SecurityHeadersOptionsBuilder,
  cors,
  CorsOptions,
  CorsOptionsBuilder,
  CorsOptionsValidator,
  csrfProtection,
  requireSameOrigin,
  readCsrfToken,
  CsrfOptions,
  CsrfOptionsBuilder,
  CsrfOptionsValidator,
  DEFAULT_CSRF_COOKIE_NAME,
  SameOriginOptions,
  SameOriginOptionsBuilder,
  SameOriginOptionsValidator,
  requestId,
  requestIdOf,
  DEFAULT_REQUEST_ID_HEADER,
  RequestIdOptions,
  RequestIdOptionsBuilder,
  BasicAuth,
  BasicAuthOptions,
  BasicAuthOptionsBuilder,
  requestTimeout,
  TimeoutOptions,
  TimeoutOptionsBuilder,
  TimeoutOptionsValidator,
} from './middleware/index.js';
export type {
  BearerTokenAuthOptions,
  IpAllowlistOptionsType,
  HstsOptionsType,
  CspOptionsType,
  CspDirectives,
  SecurityHeadersOptionsType,
  CorsOptionsType,
  CorsOrigin,
  CsrfOptionsType,
  CsrfCookieOptions,
  OriginScheme,
  SameOriginOptionsType,
  RequestIdOptionsType,
  BasicAuthOptionsType,
  TimeoutOptionsType,
} from './middleware/index.js';

export { entity, marshal, pickRequestSerializer, pickResponseSerializer } from './Marshalling.js';

// HTML form bodies — `application/x-www-form-urlencoded`, the one request
// media type that is not also a cluster-wire codec, hence its home here.
export { FormUrlEncodedSerializer } from './FormUrlEncodedSerializer.js';
export type { FormFields } from './FormUrlEncodedSerializer.js';

// MIME-type registry — extension → content-type for static-file responses.
export { contentTypeFor, DEFAULT_MIME_TYPES } from './MimeTypes.js';

// Static file serving — getFromFile / getFromDirectory / directory browsing.
export {
  getFromFile,
  getFromDirectory,
  getFromBrowseableDirectory,
  StaticFilesOptions,
  StaticFilesOptionsBuilder,
  StaticFilesOptionsValidator,
} from './static/index.js';
export type { StaticFilesOptionsType } from './static/index.js';

// HTML response helpers — escaping + the `html` tagged template (#352).
export { escapeHtml, html, rawHtml, completeHtml, SafeHtml } from './Html.js';

// Cookie parse/serialise helpers — used by CSRF, handy for handlers too.
export { parseCookies, serializeCookie } from './Cookies.js';
export type { CookieAttributes } from './Cookies.js';

export { HttpClient, HttpRedirectError, HttpResponseTooLargeError } from './HttpClient.js';
export type { HttpClientRequest, HttpClientResponse } from './HttpClient.js';
export {
  HttpClientOptions,
  HttpClientOptionsBuilder,
  HttpClientOptionsValidator,
  HttpClientRequestLimitsValidator,
  DEFAULT_HTTP_CLIENT_MAX_REDIRECTS,
  DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES,
  DEFAULT_HTTP_CLIENT_REDIRECT_MODE,
  DEFAULT_HTTP_CLIENT_TIMEOUT_MS,
} from './HttpClientOptions.js';
export type {
  HttpClientOptionsType,
  HttpClientRequestLimits,
  HttpRedirectMode,
} from './HttpClientOptions.js';

export { FastifyBackend } from './backend/FastifyBackend.js';
export { ExpressBackend } from './backend/ExpressBackend.js';
export { ExpressBackendOptions, ExpressBackendOptionsBuilder, ExpressBackendOptionsValidator } from './backend/ExpressBackendOptions.js';
export type { ExpressBackendOptionsType } from './backend/ExpressBackendOptions.js';
export { HonoBackend } from './backend/HonoBackend.js';
export { HonoBackendOptions, HonoBackendOptionsBuilder, HonoBackendOptionsValidator } from './backend/HonoBackendOptions.js';
export type { HonoBackendOptionsType } from './backend/HonoBackendOptions.js';
export { DEFAULT_HTTP_MAX_BODY_BYTES } from './Constants.js';
export {
  DEFAULT_HTTP_SERVER_HEADER_TIMEOUT_MS,
  DEFAULT_HTTP_SERVER_REQUEST_TIMEOUT_MS,
  HttpServerOptions,
  HttpServerOptionsBuilder,
  HttpServerOptionsValidator,
} from './HttpServerOptions.js';
export type { HttpServerOptionsType } from './HttpServerOptions.js';
export { DEFAULT_RESPONSE_SECURITY_HEADERS, PAYLOAD_TOO_LARGE_RESPONSE } from './backend/HttpServerBackend.js';
export type {
  HttpServerBackend,
  RouteRegistration,
  WebsocketRouteRegistration,
  ServerBinding,
} from './backend/HttpServerBackend.js';
export type {
  WebsocketSocketAdapter,
  WebsocketListeners,
  PreAttachBufferLimits,
} from './websocket/SocketAdapter.js';

// Typed WebSocket stack — websocket() directive, server actor, codecs.
export * from './websocket/index.js';

export {
  HttpError,
  Status,
} from './Types.js';
export type { HttpMethod, HttpRequest, HttpResponse } from './Types.js';

// HTTP caching middleware (response-cache, rate-limit, idempotency-key).
export {
  rateLimit,
  RateLimitOptions,
  RateLimitOptionsBuilder,
  RateLimitOptionsValidator,
  idempotent,
  DEFAULT_IDEMPOTENCY_MAX_KEY_LENGTH,
  DEFAULT_IDEMPOTENCY_MAX_SCOPE_LENGTH,
  IdempotencyOptions,
  IdempotencyOptionsBuilder,
  IdempotencyOptionsValidator,
  cached,
} from './cache/index.js';
export type {
  RateLimitOptionsType,
  RateLimitContext,
  IdempotencyOptionsType,
  ResponseCacheOptions,
} from './cache/index.js';
