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
} from './Route.js';
export type { CompiledRoute, Route } from './Route.js';

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
  ServerBinding,
} from './backend/HttpServerBackend.js';

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
