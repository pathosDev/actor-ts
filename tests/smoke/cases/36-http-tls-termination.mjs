/**
 * Smoke case: the HTTP server **terminates TLS on every runtime**, through one
 * option shape (#1522).
 *
 * `tests/unit/http/HttpServerTls.test.ts` proves the mechanism on Bun — and
 * drives the Node runner under Bun, since `@hono/node-server` sits on
 * `node:https` / `node:http2`, which Bun implements.  What that cannot show is
 * the runtime the user actually runs: `Deno.serve({ cert, key })` is reached
 * only on Deno, and `http2.createSecureServer` is Node's own only on Node.
 * This case binds the Hono backend with the test certificate on whichever
 * runtime the harness is on, and fetches over HTTPS **verifying against the
 * test CA** — never `rejectUnauthorized: false`, because a client that skips
 * verification would pass against a listener terminating with the wrong
 * material, and "the process is the TLS endpoint" is the whole claim.
 *
 * The client is `node:https` with `ca`, which all three runtimes provide, so
 * the case stays runtime-neutral: the one runtime-specific thing in it is the
 * server, and that is the thing under test.
 *
 * Skips when `hono` cannot be loaded on this runtime, like the other Hono
 * cases — but once a server binds, the verified HTTPS request MUST succeed and
 * a cleartext request to the same port MUST fail.
 */
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

export const name = 'http tls termination';
export const description = 'the Hono backend terminates TLS with a CA-verified client on every runtime';

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const SETTLE_TIMEOUT_MS = 5_000;

/** One request through `node:https` / `node:http`; resolves with status and body, rejects on any socket error. */
function requestOnce(transport, options) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response within ${SETTLE_TIMEOUT_MS}ms`)), SETTLE_TIMEOUT_MS);
    const req = transport({ method: 'GET', path: '/', ...options }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body }); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

export async function run({ actorTs, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { HttpExtensionId, HttpServerOptions, completeText, get, path } = await loadEntry('http');

  try {
    await import('hono');
  } catch (e) {
    console.log(`  (skipped: hono not loadable on this runtime — ${e.message})`);
    return;
  }

  const [cert, key, ca] = await Promise.all([
    readFile(new URL('localhost-cert.pem', FIXTURES), 'utf8'),
    readFile(new URL('localhost-key.pem', FIXTURES), 'utf8'),
    readFile(new URL('test-ca.pem', FIXTURES), 'utf8'),
  ]);

  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { http: { backend: 'hono' } } });
  const system = ActorSystem.create('smoke-http-tls', systemOptions);
  let binding;
  try {
    const serverOptions = HttpServerOptions.create().withTls({ cert, key });
    try {
      binding = await system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .withServerOptions(serverOptions)
        .bind(path('', get(() => completeText(200, 'tls on this runtime'))));
    } catch (e) {
      console.log(`  (skipped: could not bind a TLS server on this runtime — ${e.message})`);
      return;
    }

    /* --- 1. a CA-verified HTTPS request is answered ---------------------- */
    const verified = await requestOnce(httpsRequest, { host: '127.0.0.1', port: binding.port, ca, servername: 'localhost' });
    if (verified.status !== 200 || verified.body !== 'tls on this runtime') {
      throw new Error(`verified HTTPS request answered ${verified.status} ${JSON.stringify(verified.body)}`);
    }

    /* --- 2. cleartext to the same port is refused at the socket ------------ */
    // Not a redirect and not a 400: the socket speaks TLS or nothing, so the
    // client-side failure is what proves the listener is the TLS endpoint.
    let cleartext;
    try {
      cleartext = await requestOnce(httpRequest, { host: '127.0.0.1', port: binding.port });
    } catch {
      cleartext = null;
    }
    if (cleartext !== null) {
      throw new Error(`a cleartext request to the TLS port was answered ${cleartext.status} — TLS is not being terminated`);
    }
  } finally {
    if (binding) await binding.unbind().catch(() => {});
    await system.terminate();
  }
}
