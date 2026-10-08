import { readFileSync } from 'node:fs';
import { match } from 'ts-pattern';
import type { ActorSystem } from '../ActorSystem.js';
import { Config, ConfigError } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { rejectRetiredLeaves, type RetiredLeaves } from '../config/RetiredKeys.js';
import { CoordinatedShutdownId, Phases } from '../CoordinatedShutdown.js';
import { extensionId, type Extension, type ExtensionId } from '../Extension.js';
import type { Logger } from '../Logger.js';
import { mergeOptions, stripUndefined } from '../util/OptionsMerge.js';
import type { HttpServerBackend, ServerBinding, ServerOptionsReport } from './backend/HttpServerBackend.js';
import { HttpClient } from './HttpClient.js';
import type { HttpClientOptions, HttpClientOptionsType, HttpRedirectMode } from './HttpClientOptions.js';
import {
  DEFAULT_HTTP_SERVER_HEADER_TIMEOUT_MS,
  DEFAULT_HTTP_SERVER_HTTP2,
  DEFAULT_HTTP_SERVER_REQUEST_TIMEOUT_MS,
  HttpServerOptionsValidator,
} from './HttpServerOptions.js';
import type { HttpServerOptions, HttpServerOptionsType, HttpTlsOptionsType } from './HttpServerOptions.js';
import { requestIdOf } from './middleware/RequestId.js';
import { resolveSecurityHeaders } from './middleware/SecurityHeaders.js';
import type { SecurityHeadersOptions } from './middleware/SecurityHeadersOptions.js';
import { compileServerRoutes, defaultErrorResponse, type Route } from './Route.js';
import { HttpError, type HttpRequest, type HttpResponse } from './Types.js';
import { ConnectionTracker, trackSocket } from './websocket/ConnectionWiring.js';

export interface ServerBuilder {
  /** Override the default Fastify backend (or use Express / Hono). */
  useBackend(backend: HttpServerBackend): ServerBuilder;
  /**
   * Security response headers for **this whole server**, stamped by the
   * backend onto every response it writes — including the error, not-found
   * and WebSocket upgrade-reject paths that never flow back through a
   * middleware, and the throw short-circuits that skip one.
   *
   * Left alone, a server sends `X-Content-Type-Options: nosniff` and nothing
   * else: it is the only header of the bundle that cannot change how an
   * existing application is embedded, framed or referred to.  Passing
   * options opts into the **full** {@link securityHeaders} bundle — its own
   * defaults included, so `X-Frame-Options: DENY` and
   * `Cross-Origin-Resource-Policy: same-origin` come along and will break
   * iframes and cross-origin embedding if that is how the app is used.
   * `false` turns the mechanism off entirely.
   *
   * A response's own header always wins, whatever is configured here.
   * Requires a backend that supports `setDefaultResponseHeaders` (all
   * shipped backends do).
   */
  withSecurityHeaders(options: SecurityHeadersOptions | false): ServerBuilder;
  /**
   * Last-resort handler for errors that escape every route-level
   * `handleErrors(...)`, plus backend-internal errors (body-parse
   * failures, etc.).  Overrides the framework's default 500 mapping; if
   * it throws, the default mapping still applies.  Requires a backend
   * that supports `setErrorHandler` (all shipped backends do).
   */
  withErrorHandler(handler: (err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse): ServerBuilder;
  /**
   * Connection-level bounds for **this whole server** — the idle window of a
   * keep-alive connection and of an HTTP/2 session, the header and request
   * receive deadlines, and a ceiling on concurrent connections.  They belong
   * to the listening socket rather than to a route, so they are resolved once
   * here and installed at `listen()`.
   *
   * This is the explicit layer over `actor-ts.http.server`: a field named here
   * wins, a field left unset falls through to HOCON and then to the built-in
   * default.  Two of the four ship no built-in default at all — leaving
   * `idleTimeoutMs` and `maxConnections` unset keeps whatever the backend
   * chose, which is not a number any layer could name.
   *
   * Not every backend can honour every field: `applyServerOptions` in
   * `backend/HttpServerBackend.ts` carries the per-runtime table.  Neither
   * `Bun.serve` nor `Deno.serve` exposes any of them, so the Hono backend is
   * tunable only on Node.  That is no longer silent: the backend reports what
   * it installed, the binding `bind()` returns carries that report as
   * `serverOptionsReport`, and a field set here or in HOCON that the report
   * says holds nothing is named in one warning at `bind()`, after the bound
   * line.
   */
  withServerOptions(options: HttpServerOptions): ServerBuilder;
  /** Register the full route tree and bind.  Returns the ServerBinding. */
  bind(routes: Route): Promise<ServerBinding>;
}

/**
 * System-wide HTTP extension — entry point for the routing DSL and the
 * shared HttpClient.  Every ActorSystem gets one HttpClient and a factory
 * for HTTP servers.  The default server backend is Fastify; swap it per
 * server via `builder.useBackend(new HonoBackend())`.
 */
export class HttpExtension implements Extension {
  /**
   * Shared HTTP client — uses the global fetch, on the limits from
   * `actor-ts.http.client` (30 s deadline, 8 MiB response ceiling by
   * default).  For different limits use {@link newClient} rather than
   * mutating this one: it is shared by every actor in the system, so raising a
   * bound for one integration would raise it for all of them.
   */
  readonly client: HttpClient;

  /**
   * Fire-and-forget request via the shared client.
   *
   * Assigned here rather than as a field initializer because it reads
   * {@link client}, which now reads config and so cannot be built before the
   * constructor has its system.  Class fields initialize *before* a parameter
   * property is assigned, so a `client` field initializer that reached for
   * `this.system` would find `undefined`.
   */
  readonly singleRequest: HttpClient['singleRequest'];

  constructor(private readonly system: ActorSystem) {
    this.client = this.newClient();
    this.singleRequest = this.client.singleRequest.bind(this.client);
  }

  /**
   * A client of your own, layered over the `actor-ts.http.client` defaults.
   *
   * The seam exists because the limits are per-client and deliberately strict:
   * an integration that legitimately downloads a large export, or that talks
   * to an endpoint slower than the default deadline, needs its own bounds
   * without loosening the ones every other caller inherits.  Per-request
   * overrides (`maxResponseBytes`, `timeoutMs`) cover the one-off case; this
   * covers a whole integration; HOCON covers the fleet.
   *
   * Precedence is the project's usual explicit > HOCON > built-in, so an
   * operator can raise the floor for a deployment without a code change, and
   * an integration that names a bound still wins over them.
   */
  newClient(options?: HttpClientOptions): HttpClient {
    return new HttpClient(mergeOptions<HttpClientOptionsType>(
      {},
      readHttpClientOptionsFromConfig(this.system.config),
      (options ?? {}) as Partial<HttpClientOptionsType>,
    ));
  }

  /** Start building a new server scope.  Call `bind(routes)` to start it. */
  newServerAt(host: string, port: number): ServerBuilder {
    let backend: HttpServerBackend | null = null;
    let errorHandler: ((err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse) | null = null;
    // `undefined` is "never configured" and must stay distinguishable from
    // `false`: the backends ship with their own default header set, so an
    // untouched builder has to leave it alone rather than overwrite it.
    let securityHeadersOptions: SecurityHeadersOptions | false | undefined;
    let serverOptions: HttpServerOptions | undefined;
    const system = this.system;
    return {
      useBackend(b: HttpServerBackend): ServerBuilder {
        backend = b;
        return this;
      },
      withServerOptions(options: HttpServerOptions): ServerBuilder {
        serverOptions = options;
        return this;
      },
      withSecurityHeaders(options: SecurityHeadersOptions | false): ServerBuilder {
        securityHeadersOptions = options;
        return this;
      },
      withErrorHandler(handler: (err: unknown, request: HttpRequest) => Promise<HttpResponse> | HttpResponse): ServerBuilder {
        errorHandler = handler;
        return this;
      },
      async bind(routes: Route): Promise<ServerBinding> {
        // Resolved first, and once: this is the only place the explicit layer
        // and a system to read config from are both in scope.  It has to
        // precede the backend, not merely `listen()`, because Fastify takes
        // TLS and HTTP/2 as *factory* options — a backend built here without
        // them could not be retrofitted at `listen()` (#1522).  Validating
        // here also moves an OptionsError from a malformed policy to bind()
        // rather than to the first connection that trips the bound, which is
        // where a configuration error belongs.  The two layers are kept apart
        // as well as merged: what the deployment set in each is what the
        // warning about an inert bound names, after `listen()`.
        const explicitServerOptions = (serverOptions ?? {}) as Partial<HttpServerOptionsType>;
        const configuredServerOptions = readHttpServerOptionsFromConfig(system.config);
        const resolvedServerOptions = mergeOptions<HttpServerOptionsType>(
          {
            headerTimeoutMs: DEFAULT_HTTP_SERVER_HEADER_TIMEOUT_MS,
            requestTimeoutMs: DEFAULT_HTTP_SERVER_REQUEST_TIMEOUT_MS,
            http2: DEFAULT_HTTP_SERVER_HTTP2,
          },
          configuredServerOptions,
          explicitServerOptions,
        );
        new HttpServerOptionsValidator().validate(resolvedServerOptions);
        // Fastify is the built-in default for an unset key.  The config is not
        // consulted at all when `useBackend` named one, so an unknown name in a
        // file the explicit layer overrides is never an error.
        const active: HttpServerBackend = backend ?? await createHttpBackend(
          readHttpBackendFromConfig(system.config) ?? 'fastify',
          resolvedServerOptions,
        );
        // The one place a route tree and an ActorSystem are both in scope, so
        // the one place a directive with a HOCON layer can be resolved (#878),
        // and a config-aware middleware with it (#1462).
        const { endpoints: compiled, unreadConfiguration } = compileServerRoutes(routes, system.config);
        const httpRoutes = compiled.filter((r) => r.kind === 'http');
        const wsRoutes = compiled.filter((r) => r.kind === 'websocket');
        const fallbacks = compiled.filter((r) => r.kind === 'fallback');

        if (wsRoutes.length > 0 && typeof active.registerWebSocket !== 'function') {
          throw new Error(
            `HTTP backend "${active.name}" does not support websocket() routes.`,
          );
        }

        // Reject duplicate / conflicting patterns up front — clearer than
        // the backend's own boot-time error, and it catches the WS-vs-GET
        // collision (a WS route occupies the GET verb at its pattern).
        //
        // The HTTP-vs-HTTP pass belongs here, and not only in the backends,
        // because only Fastify's router rejects a repeated method+pattern
        // today: Express and Hono replay their registrations in insertion
        // order and answer with the first that matches, so `concat()`
        // argument order would quietly decide which of an auth-guarded route
        // and an unguarded twin is reachable — a security boundary nobody
        // reads argument order as.  Deciding it here makes the answer the
        // same on every backend (#759).
        const wsPatterns = new Set<string>();
        for (const route of wsRoutes) {
          if (wsPatterns.has(route.pattern)) {
            throw new Error(`Duplicate websocket() route for pattern "${route.pattern}".`);
          }
          wsPatterns.add(route.pattern);
        }
        const httpEndpoints = new Set<string>();
        for (const route of httpRoutes) {
          if (route.method === 'GET' && wsPatterns.has(route.pattern)) {
            throw new Error(
              `Route conflict: GET ${route.pattern} collides with a websocket() route on the same path.`,
            );
          }
          const endpoint = `${route.method} ${route.pattern}`;
          if (httpEndpoints.has(endpoint)) {
            throw new Error(
              `Route conflict: ${endpoint} is declared more than once — a duplicate `
              + 'would resolve by declaration order, so one route would silently '
              + 'shadow the other.',
            );
          }
          httpEndpoints.add(endpoint);
        }

        // Wrap each HTTP route's handler with a request log + timing.
        // Done at the DSL level so backends don't need a Logger
        // reference — every backend gets the same per-request debug
        // line uniformly.
        for (const route of httpRoutes) {
          active.registerRoute({
            method: route.method,
            pattern: route.pattern,
            handler: async (request: HttpRequest): Promise<HttpResponse> => {
              const start = Date.now();
              system.log.debug(`[http] ${request.method} ${request.path}`);
              try {
                const out = await route.handler(request);
                system.log.debug(
                  `[http] ${request.method} ${request.path} → ${out.status} (${Date.now() - start} ms)`,
                );
                return out;
              } catch (err) {
                logRouteFailure(system.log, request, err, Date.now() - start);
                throw err;
              }
            },
          });
        }

        // WebSocket routes: every accepted socket flows through the
        // shared ConnectionTracker so unbind() can close it — otherwise
        // a long-lived socket keeps the server's close() pending forever.
        //
        // The policy is resolved here rather than left to the first
        // connection because this is the only place that holds both the
        // routes and the system whose config they resolve against, and the
        // backend needs `maxFrameBytes` one moment earlier than that — at
        // listen(), to size the runtime's own payload limit (#373).
        // Resolution is memoised per route, so the connections still see the
        // very same policy object.  It also moves an `OptionsError` from a
        // malformed policy to bind() instead of the first upgrade, which is
        // where a configuration error belongs.
        const tracker = new ConnectionTracker();
        for (const route of wsRoutes) {
          const policy = route.resolvePolicy(system);
          active.registerWebSocket!({
            pattern: route.pattern,
            maxFrameBytes: policy.maxFrameBytes,
            preAttachBuffer: {
              maxFrames: policy.maxPreAttachFrames,
              maxBytes: policy.maxPreAttachBytes,
            },
            authorize: route.authorize,
            onConnection: (request, socket) => {
              system.log.debug(`[ws] upgrade ${request.path}`);
              route.connect(system, request, trackSocket(tracker, socket));
            },
          });
        }

        // Fallback (not-found) route — at most one, wired to the backend's
        // method-agnostic not-found hook.  Wrap it like the per-route
        // handlers (debug log + default error mapping on throw).
        if (fallbacks.length > 1) {
          throw new Error(
            'Multiple fallback() routes registered — a server has exactly one not-found handler.',
          );
        }
        if (fallbacks.length === 1) {
          if (typeof active.setNotFound !== 'function') {
            throw new Error(
              `HTTP backend "${active.name}" does not support fallback() routes (no setNotFound hook).`,
            );
          }
          const fb = fallbacks[0]!;
          active.setNotFound(async (request: HttpRequest): Promise<HttpResponse> => {
            const start = Date.now();
            system.log.debug(`[http] (fallback) ${request.method} ${request.path}`);
            try {
              return await fb.handler(request);
            } catch (err) {
              // This branch answers with `defaultErrorResponse` instead of
              // re-throwing, so nothing downstream ever sees the error — the
              // log below is the only place it can survive at all.
              logRouteFailure(system.log, request, err, Date.now() - start);
              return defaultErrorResponse(err);
            }
          });
        }

        // Server-wide response headers.  Only pushed when the builder was
        // actually configured — see the declaration of the local above.
        if (securityHeadersOptions !== undefined) {
          if (typeof active.setDefaultResponseHeaders !== 'function') {
            throw new Error(
              `HTTP backend "${active.name}" does not support withSecurityHeaders (no setDefaultResponseHeaders hook).`,
            );
          }
          active.setDefaultResponseHeaders(
            securityHeadersOptions === false ? {} : resolveSecurityHeaders(securityHeadersOptions),
          );
        }

        // Server-wide error handler.  Backends consult it before their
        // default mapping and fall back to that mapping if it throws.
        if (errorHandler) {
          if (typeof active.setErrorHandler !== 'function') {
            throw new Error(
              `HTTP backend "${active.name}" does not support withErrorHandler (no setErrorHandler hook).`,
            );
          }
          active.setErrorHandler(errorHandler);
        }

        const raw = await active.listen(host, port, resolvedServerOptions);
        // Wrap `unbind` so it's idempotent — both the auto-registered
        // CoordinatedShutdown task and any manual caller can invoke it
        // safely; subsequent calls return the in-flight/resolved promise
        // from the first.  On unbind we also close then hard-terminate
        // live WebSocket sockets so the backend's close() can complete.
        let unbindOnce: Promise<void> | null = null;
        const shutdownTaskName = `http-unbind-${raw.host}:${raw.port}`;
        // Read once at bind time, not per unbind: the shutdown path is the
        // caller that never passes one, and it must not depend on config
        // being reachable while the system is already tearing down.
        const configuredGracePeriodMs = readHttpShutdownGracePeriodFromConfig(system.config);
        const binding: ServerBinding = {
          host: raw.host,
          port: raw.port,
          serverOptionsReport: raw.serverOptionsReport,
          unbind(gracePeriodMs?: number): Promise<void> {
            if (!unbindOnce) {
              unbindOnce = (async () => {
                const backendUnbind = raw.unbind(gracePeriodMs ?? configuredGracePeriodMs);
                tracker.closeAll(1001, 'server shutting down');
                tracker.terminateAll();
                await backendUnbind;
                // The task is named after the address, so leaving it
                // behind made re-binding that address impossible: the
                // next `bind()` collided with a task for a server that
                // no longer exists.
                system.extension(CoordinatedShutdownId)
                  .removeTask(Phases.ServiceUnbind, shutdownTaskName);
              })();
            }
            return unbindOnce;
          },
        };
        // Auto-register with CoordinatedShutdown's ServiceUnbind phase so
        // operator-triggered shutdown (SIGTERM, cluster-leave, etc.) closes
        // the server before the rest of the pipeline tears down the system.
        // Opt out with `actor-ts.coordinated-shutdown.auto-register-tasks`.
        system.extension(CoordinatedShutdownId).addFrameworkTask(
          Phases.ServiceUnbind,
          shutdownTaskName,
          () => binding.unbind(),
        );
        system.log.info(`HTTP server bound on ${binding.host}:${binding.port} (${active.name})`);
        system.log.debug(
          `[http] ${httpRoutes.length} route(s) + ${wsRoutes.length} websocket route(s) registered`,
        );
        // After the bound line, so the warning names the port actually taken.
        for (const warning of unreadConfiguration) system.log.warn(`[http] ${binding.host}:${binding.port}: ${warning}`);
        // The same place and prefix for the other kind of "configured but not
        // in effect", so an operator reading a bind sees one shape for both.
        const inertServerOptions = inertServerOptionsWarning(
          active.name,
          raw.serverOptionsReport,
          explicitServerOptions,
          configuredServerOptions,
        );
        if (inertServerOptions !== undefined) {
          system.log.warn(`[http] ${binding.host}:${binding.port}: ${inertServerOptions}`);
        }
        return binding;
      },
    };
  }
}

/**
 * Record a throw that escaped every `handleErrors(...)`, on the way to the
 * response the client will actually get.
 *
 * The level split is the point.  An `HttpError` is a response the handler
 * *chose* — a 404, a 401 — and its message is mapped straight into the body,
 * so it is ordinary traffic and belongs on the same debug line as a success.
 * Anything else becomes the generic 500 that deliberately withholds the
 * thrown text (#130), because that text routinely carries file paths, SQL
 * fragments or driver internals.  Redaction only works if the detail
 * survives on the server, and at `debug` it did not: nothing runs at debug
 * in production, so a redacted 500 was the sole trace of the failure
 * anywhere.  Hence `error`, and the error value itself — the `Logger`
 * contract passes it through to the sink, which is what preserves a stack.
 *
 * The id is reported as the header it came from rather than as "the" request
 * id: it is whatever the caller sent, and `requestId({ trustIncoming: false })`
 * would have replaced it downstream.  `requestIdOf` bounds it to a
 * well-formed id first — a raw client string on a log line can forge records
 * with an embedded newline.  Only the default header is consulted; a server
 * that renames it should log its own id from `withErrorHandler`.
 */
function logRouteFailure(
  log: Logger,
  request: HttpRequest,
  err: unknown,
  elapsedMs: number,
): void {
  if (err instanceof HttpError) {
    log.debug(`[http] ${request.method} ${request.path} → ${err.status} (${elapsedMs} ms)`);
    return;
  }
  const correlation = requestIdOf(request);
  log.error(
    `[http] ${request.method} ${request.path} → 500 after ${elapsedMs} ms`
    + `${correlation ? ` [x-request-id=${correlation}]` : ''}`,
    err,
  );
}

/**
 * The fields a {@link ServerOptionsReport} speaks for, each beside the HOCON
 * leaf an operator would search for — the name the warning gives them, since
 * it is the one spelling that is the same whichever layer set the value.
 */
const SERVER_OPTION_LEAVES: ReadonlyArray<readonly [keyof ServerOptionsReport, string]> = [
  ['idleTimeoutMs', ConfigKeys.http.server.idleTimeout],
  ['headerTimeoutMs', ConfigKeys.http.server.headerTimeout],
  ['requestTimeoutMs', ConfigKeys.http.server.requestTimeout],
  ['maxConnections', ConfigKeys.http.server.maxConnections],
];

/**
 * The one warning `bind()` logs for connection bounds the deployment set and
 * the backend reports holding nothing, or `undefined` when there are none.
 *
 * It exists because the alternative was silence: `max-connections` set for the
 * Hono backend under Bun — where `Bun.serve` hands back no server to install it
 * on — bound a server that took every connection, and nothing said so.
 *
 * **Set** means what the deployment chose, decided per field by the layer that
 * wins it.  A field named in `withServerOptions` is set, except an `Infinity`
 * cap, which is the code-side spelling of leaving the cap unset.  Below that, a
 * HOCON leaf is set when its value differs from what `reference.conf` ships —
 * the rule the unread-middleware warning applies, for the same reason:
 * `header-timeout` and `request-timeout` ship a value, so every resolved policy
 * carries them, and a value equal to the shipped one configures exactly what
 * leaving it out does.  Warned about, they would fire on every Hono-on-Bun bind
 * over a choice nobody made, and an operator who writes the shipped number by
 * hand gets the same server and the same silence as one who does not.
 *
 * **One warning per bind, naming every leaf**, rather than one per leaf: it is
 * one fact about one server — this backend cannot hold these here — and the
 * remedy is the same for all of them.
 *
 * A backend that reports nothing is not warned about: an absent report means
 * the backend did not say, and guessing on its behalf would turn every backend
 * written outside this repository into a source of false alarms.
 */
function inertServerOptionsWarning(
  backendName: string,
  report: ServerOptionsReport | undefined,
  explicit: Partial<HttpServerOptionsType>,
  configured: Partial<HttpServerOptionsType>,
): string | undefined {
  if (report === undefined) return undefined;
  const notInEffect = SERVER_OPTION_LEAVES.filter(([field]) => !report[field]);
  if (notInEffect.length === 0) return undefined;
  const shipped = readHttpServerOptionsFromConfig(Config.loadReference());
  const setByDeployment = (field: keyof ServerOptionsReport): boolean => {
    const inCode = explicit[field];
    if (inCode !== undefined) return !(field === 'maxConnections' && inCode === Infinity);
    return configured[field] !== undefined && configured[field] !== shipped[field];
  };
  const inert = notInEffect.filter(([field]) => setByDeployment(field)).map(([, leaf]) => leaf);
  if (inert.length === 0) return undefined;
  const named = inert.length === 1 ? inert[0] : `${inert.slice(0, -1).join(', ')} and ${inert[inert.length - 1]}`;
  const one = inert.length === 1;
  return `${named} ${one ? 'is' : 'are'} set, but the "${backendName}" backend reports ${one ? 'it' : 'them'} `
    + `not in effect on this server, so ${one ? 'it bounds' : 'they bound'} nothing here. `
    + `The ${ConfigKeys.http.server.root} table in the configuration reference says which backend and runtime can hold each.`;
}

/** The backends `actor-ts.http.backend` can name: the three that ship. */
export type HttpBackendName = 'fastify' | 'express' | 'hono';

/**
 * The backend `actor-ts.http.backend` names, or `undefined` when the key is
 * unset — the built-in default is `bind()`'s to apply, the way every reader
 * here returns only what the configuration says.
 *
 * Kept apart from {@link createHttpBackend} so the read builds nothing: it can
 * be asserted on its own, and no backend module is loaded to answer it.  That
 * makes this the only place an unknown name can be refused, so the
 * `ConfigError` naming the key is raised here, and the factory sees nothing
 * but a name it has an arm for.
 */
export function readHttpBackendFromConfig(config: Config): HttpBackendName | undefined {
  const key = ConfigKeys.http.backend;
  if (!config.hasPath(key)) return undefined;
  const name = config.getString(key);
  return match(name)
    .with('fastify', 'express', 'hono', (known) => known)
    .otherwise(() => {
      throw new ConfigError(
        `${key} = "${name}" is not a known backend — `
        + 'expected "fastify", "express" or "hono".  For a backend of your own, '
        + 'pass it to newServerAt(...).useBackend(...) instead.',
      );
    });
}

/**
 * Instantiate the backend `name` denotes.  Only reached when the builder was
 * not given one — `useBackend(...)` is the explicit layer and always wins.
 *
 * All three backends are imported dynamically rather than at module scope.
 * For Express and Hono that keeps optional peer dependencies out of the
 * bundle of an application that uses another backend.  Fastify is the
 * built-in default and a hard dependency, but ActorSystem reaches this
 * module statically (the newServerAt sugar needs the extension id and its
 * factory synchronously), so a static Fastify import here would make every
 * `import { ActorSystem } from 'actor-ts'` pay Fastify's parse cost (#1005)
 * — the lazy import moves it to the first bind, on an already-async path.
 */
async function createHttpBackend(
  name: HttpBackendName,
  serverOptions: Partial<HttpServerOptionsType>,
): Promise<HttpServerBackend> {
  return await match(name)
    // Fastify alone takes TLS and HTTP/2 at construction — `Fastify({ https,
    // http2 })` — so the framework-built instance is handed the resolved
    // answer here.  A `useBackend(new FastifyBackend(…))` never reaches this
    // function and has to carry its own; `FastifyBackend.listen` says so.
    .with('fastify', async () => {
      const { FastifyBackend, fastifyFactoryOptions } = await import('./backend/FastifyBackend.js');
      return new FastifyBackend(fastifyFactoryOptions(serverOptions));
    })
    .with('express', async () => new (await import('./backend/ExpressBackend.js')).ExpressBackend())
    .with('hono', async () => new (await import('./backend/HonoBackend.js')).HonoBackend())
    .exhaustive();
}

/**
 * `actor-ts.http.shutdown-grace-period` — the in-flight drain window `unbind()`
 * uses when its caller names none, or `undefined` when the key is unset.
 */
export function readHttpShutdownGracePeriodFromConfig(config: Config): number | undefined {
  const key = ConfigKeys.http.shutdownGracePeriod;
  return config.hasPath(key) ? config.getDuration(key) : undefined;
}

/**
 * The camelCase spellings this block shipped before #1405, mapped to the leaf
 * that replaced each one.  Present so an upgrade that leaves the old key in an
 * `application.conf` fails at startup rather than reverting a deliberately
 * lowered ceiling to the built-in default — see {@link rejectRetiredLeaves}.
 */
const RETIRED_HTTP_CLIENT_LEAVES: RetiredLeaves = {
  maxResponseBytes: 'max-response-bytes',
  defaultTimeoutMs: 'default-timeout',
  maxRedirects: 'max-redirects',
};

/**
 * The `actor-ts.http.client` layer — outbound bounds an operator set without
 * touching code, sitting under any explicit `HttpClientOptions`.
 *
 * The bounds exist to be operable, and until this block existed they were not:
 * the shared `HttpExtension.client` took the built-in numbers and offered no
 * way to change them, so a deployment that needed a larger ceiling had to stop
 * using the shared client altogether.  A ceiling nobody can raise gets raised
 * by deleting it.
 *
 * Leaves are read as-is and left to `HttpClientOptionsValidator`, which the
 * `HttpClient` constructor runs on the merged settings: a misspelled
 * `redirect` arrives as a plain string and comes back out as an `OptionsError`
 * naming the field, rather than as a bare throw from somewhere in the request
 * path.  An unset leaf is left out of the result rather than written as
 * `undefined`: an own `undefined` shadows the layer beneath in any spread that
 * does not strip it first, and `mergeOptions` is not the only way a partial
 * gets spread.
 *
 * Leaf names are the kebab-case of the `HttpClientOptions` fields with any
 * unit suffix dropped — `defaultTimeoutMs` is read from `default-timeout`,
 * because HOCON carries the unit in the value and `getDuration` already
 * accepts both `30s` and a bare millisecond count.
 */
export function readHttpClientOptionsFromConfig(config: Config): Partial<HttpClientOptionsType> {
  const keys = ConfigKeys.http.client;
  if (!config.hasPath(keys.root)) return {};
  rejectRetiredLeaves(config, keys.root, RETIRED_HTTP_CLIENT_LEAVES);
  const out: { -readonly [K in keyof HttpClientOptionsType]: HttpClientOptionsType[K] } = {};
  if (config.hasPath(keys.maxResponseBytes)) out.maxResponseBytes = config.getBytes(keys.maxResponseBytes);
  if (config.hasPath(keys.defaultTimeout)) out.defaultTimeoutMs = config.getDuration(keys.defaultTimeout);
  if (config.hasPath(keys.redirect)) out.redirect = config.getString(keys.redirect) as HttpRedirectMode;
  if (config.hasPath(keys.maxRedirects)) out.maxRedirects = config.getInt(keys.maxRedirects);
  return out;
}

/**
 * The `actor-ts.http.server` layer — the connection-level bounds of one bound
 * server, as an operator sets them without touching code.
 *
 * Written to match {@link readHttpClientOptionsFromConfig} exactly, and the
 * shape is load-bearing rather than stylistic: an unset leaf is left out of
 * the result, so the layer beneath is reached instead of shadowed by a key
 * present as `undefined`.  For `idle-timeout`, `max-connections`,
 * `max-content-length` and `max-header-bytes` that is the whole mechanism, not
 * a detail — all four ship **no leaf** in `reference.conf`, because "unset" is
 * a state none has a number for: unset keep-alive means *whatever the backend
 * chose* (72 s on Fastify, 5 s elsewhere — they disagree, deliberately), unset
 * `max-connections` means unlimited, and the two size caps unset keep each
 * backend's own — which is also what makes a backend built with a cap of its
 * own bind, where a set key that differs from it is refused.  A key that is
 * always present could not express any of them, which is the reason
 * `remote.tcp.advertised-host` and `cluster.bootstrap.await-ready` are
 * comments too.
 *
 * Leaf names are the kebab-case of the `HttpServerOptions` fields with the
 * unit suffix dropped, the convention the rest of `actor-ts.http` follows:
 * HOCON carries the unit in the value and `getDuration` accepts both `60s` and
 * a bare millisecond count.  Values are read as-is and left to
 * `HttpServerOptionsValidator`, which `bind()` runs on the merged settings, so
 * a bad one arrives as an `OptionsError` naming the field.
 *
 * `max-connections` is read with `getInt` and not `getBytes`: it counts
 * sockets, and a `getBytes` reader would silently accept `1K` as 1024
 * connections.  The two size caps are the opposite case and read with
 * `getBytes`, the way `max-response-bytes` is: they count bytes, and an
 * operator writes `8MiB`.
 */
export function readHttpServerOptionsFromConfig(config: Config): Partial<HttpServerOptionsType> {
  const keys = ConfigKeys.http.server;
  if (!config.hasPath(keys.root)) return {};
  const out: { -readonly [K in keyof HttpServerOptionsType]: HttpServerOptionsType[K] } = {};
  if (config.hasPath(keys.idleTimeout)) out.idleTimeoutMs = config.getDuration(keys.idleTimeout);
  if (config.hasPath(keys.headerTimeout)) out.headerTimeoutMs = config.getDuration(keys.headerTimeout);
  if (config.hasPath(keys.requestTimeout)) out.requestTimeoutMs = config.getDuration(keys.requestTimeout);
  if (config.hasPath(keys.maxConnections)) out.maxConnections = config.getInt(keys.maxConnections);
  if (config.hasPath(keys.maxContentLength)) out.maxContentLength = config.getBytes(keys.maxContentLength);
  if (config.hasPath(keys.maxHeaderBytes)) out.maxHeaderBytes = config.getBytes(keys.maxHeaderBytes);
  if (config.hasPath(keys.http2)) out.http2 = config.getBoolean(keys.http2);
  const tls = httpTlsFromConfig(config);
  if (tls !== undefined) out.tls = tls;
  return out;
}

/**
 * The `tls` block, with its three `*-file` leaves read as PEM.
 *
 * Read here, once, rather than deferred to `listen()`: a missing or
 * unreadable file is a configuration error and belongs with the other
 * `ConfigError`s, at the moment the block is read, not at the first
 * handshake.  `undefined` when the block names no certificate, so an absent
 * block and a present-but-empty one both mean plain HTTP; a block naming
 * only one of the pair still comes back with the one it has, and
 * `HttpServerOptionsValidator` is what refuses it — naming the field, as
 * every other bad value in this block is refused.  Inside the block an unset
 * leaf is left out, as it is everywhere in the reader this one nests in.
 */
function httpTlsFromConfig(config: Config): HttpTlsOptionsType | undefined {
  const keys = ConfigKeys.http.server.tls;
  const hasCert = config.hasPath(keys.certFile);
  const hasKey = config.hasPath(keys.keyFile);
  if (!hasCert && !hasKey) return undefined;
  const pem = (key: string): string => {
    const file = config.getString(key);
    try {
      return readFileSync(file, 'utf8');
    } catch (error) {
      throw new ConfigError(`${key} = "${file}" could not be read: ${(error as Error).message}`);
    }
  };
  // One literal, stripped afterwards, rather than field by field like the
  // readers above: the TLS verification guard (#755) admits a read of
  // `reject-unauthorized` only as exactly the ternary below, and a guard that
  // cannot see the read is no guard for it.
  return stripUndefined({
    cert: hasCert ? pem(keys.certFile) : undefined,
    key: hasKey ? pem(keys.keyFile) : undefined,
    ca: config.hasPath(keys.caFile) ? pem(keys.caFile) : undefined,
    requestClientCert: config.hasPath(keys.requestClientCert) ? config.getBoolean(keys.requestClientCert) : undefined,
    // Forwarded as the operator wrote it.  `false` at that leaf leaves a
    // client certificate unverified; the answer is `ca-file` instead.
    rejectUnauthorized: config.hasPath(keys.rejectUnauthorized) ? config.getBoolean(keys.rejectUnauthorized) : undefined,
  });
}

export const HttpExtensionId: ExtensionId<HttpExtension> = extensionId(
  'HttpExtension',
  (system) => new HttpExtension(system),
);
