/**
 * The recommended HTTP security stack, wired end to end.
 *
 *   bun run examples/http/secure-service.ts
 *   curl -i http://localhost:8080/                       # security headers + CSRF cookie
 *   curl -i http://localhost:8080/nope                   # fallback 404
 *   curl -i -X OPTIONS http://localhost:8080/api/echo \
 *        -H 'origin: https://app.example' \
 *        -H 'access-control-request-method: POST'        # CORS preflight
 *
 * Layer order (outermost first): requestId → securityHeaders → cors →
 * requestTimeout → csrfProtection → handleErrors → routes + fallback.
 * cors sits OUTSIDE auth so its (anonymous) preflight routes aren't gated.
 */
import {
  ActorSystem,
  CorsOptions,
  CsrfOptions,
  HttpError,
  Status,
  completeHtml,
  completeJson,
  concat,
  cors,
  csrfProtection,
  entity,
  fallback,
  get,
  handleErrors,
  html,
  path,
  post,
  readCsrfToken,
  requestId,
  requestTimeout,
  securityHeaders,
  withMiddleware,
} from '../../src/index.js';

async function main(): Promise<void> {
  const system = ActorSystem.create('secure-service');

  const corsOptions = CorsOptions.create()
    .withOrigins('https://app.example')
    .withCredentials();

  const csrfOptions = CsrfOptions.create()
    // Demo secret — load from a secret manager in production.
    .withSecret(process.env.CSRF_SECRET ?? 'dev-only-secret-change-me-0123456789')
    // The sample runs over plain HTTP; drop this in production (HTTPS).
    .withCookie({ secure: false });

  const routes =
    withMiddleware(requestId(),
    withMiddleware(securityHeaders(),
    cors(corsOptions,
    withMiddleware(requestTimeout(5000),
    withMiddleware(csrfProtection(csrfOptions),
    handleErrors(
      (err) => (err instanceof HttpError ? completeJson(err.status, { error: err.message }) : null),
      concat(
        get((request) => completeHtml(Status.OK, html`
          <h1>secure-service</h1>
          <p>Your CSRF token: <code>${readCsrfToken(request) ?? '(none)'}</code></p>
        `)),
        path('api', path('echo', post((request) => {
          const body = entity<{ readonly msg: string }>(request);
          return completeJson(Status.OK, { echo: body.msg });
        }))),
        fallback((request) => completeJson(Status.NotFound, { error: 'no such route', path: request.path })),
      ),
    ))))));

  const binding = await system.http(8080, { host: '127.0.0.1' }).bind(routes);
  system.log.info(`secure-service on http://${binding.host}:${binding.port}/`);

  process.on('SIGINT', async () => {
    await binding.unbind();
    await system.terminate();
    process.exit(0);
  });
}

void main();
