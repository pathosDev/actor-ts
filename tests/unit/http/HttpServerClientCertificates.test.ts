import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { FastifyBackend, fastifyFactoryOptions } from '../../../src/http/backend/FastifyBackend.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { HttpServerOptions, type HttpServerOptionsType } from '../../../src/http/HttpServerOptions.js';
import { completeText, get, path } from '../../../src/http/Route.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { setRuntimeOverride, type RuntimeKind } from '../../../src/runtime/Detect.js';
import { mintCertificateAuthority, mintClientCertificate, type MintedCertificate } from './_TestCertificateAuthority.js';

/**
 * #1522 — a client-certificate demand is verified against the `ca` it names,
 * on every backend, through the public `bind()` route.
 *
 * The TLS fixtures hold no client certificate, so until these cases a demand
 * was only ever shown refusing a client that presented none — which a server
 * verifying against the wrong anchor does too.  Dropping `ca` from the
 * `node:tls` mapping the Express, Fastify and Node Hono listeners share kept
 * every test green, while the server then checked client certificates against
 * the runtime's default trust store: the configured CA's client refused, one
 * from that store admitted.  So each backend here gets two certificates minted
 * for the run, one signed by the CA it is configured with and one signed by an
 * unrelated CA, and has to tell them apart.  No key is committed for either.
 *
 * Hono runs twice, because the runtime decides its listener: `Bun.serve` here,
 * and `@hono/node-server` on `node:https` under the runtime seam — the listener
 * Node runs, exercised under Bun as `HttpServerTls.test.ts` does.  The real
 * Node and Deno answers are `tests/smoke/cases/36-http-tls-termination.mjs`'s.
 */

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
/** What the clients verify the *server* against — the other direction of the handshake. */
const SERVER_CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

const configuredAuthority = mintCertificateAuthority('actor-ts test client CA');
const unrelatedAuthority = mintCertificateAuthority('actor-ts test unrelated CA');
const configuredClient = mintClientCertificate(configuredAuthority, 'client of the configured CA');
const unrelatedClient = mintClientCertificate(unrelatedAuthority, 'client of an unrelated CA');

/** The cap on one request, inside the bun per-test budget: a refused handshake fails at once. */
const REQUEST_CAP_MS = 2_000;

type Outcome = { readonly answered: number } | { readonly refused: string };

/** One HTTPS request presenting `client`'s certificate, or none; never rejects. */
function requestPresenting(port: number, client: MintedCertificate | undefined): Promise<Outcome> {
  return new Promise((resolve) => {
    const request = httpsRequest({
      host: '127.0.0.1',
      port,
      path: '/',
      ca: SERVER_CA,
      servername: 'localhost',
      agent: false,
      ...(client === undefined ? {} : { cert: client.cert, key: client.key }),
    }, (response) => {
      response.resume();
      response.on('end', () => {
        clearTimeout(cap);
        resolve({ answered: response.statusCode ?? 0 });
      });
    });
    const cap = setTimeout(() => request.destroy(new Error(`no answer within ${REQUEST_CAP_MS} ms`)), REQUEST_CAP_MS);
    request.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(cap);
      resolve({ refused: error.code ?? error.message });
    });
    request.end();
  });
}

/** See `HttpServerTls.test.ts`: `@hono/node-server` replaces these and the replacement outlives the case. */
const nativeGlobals = { Request: globalThis.Request, Response: globalThis.Response };
function restoreNativeGlobals(): void {
  Object.defineProperty(globalThis, 'Request', { value: nativeGlobals.Request, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Response', { value: nativeGlobals.Response, configurable: true, writable: true });
}

const systems: ActorSystem[] = [];
const bindings: ServerBinding[] = [];
afterEach(async () => {
  for (const binding of bindings.splice(0)) await binding.unbind().catch(() => {});
  for (const system of systems.splice(0)) await system.terminate().catch(() => {});
  setRuntimeOverride(null);
  restoreNativeGlobals();
});

const routes = path('', get(() => completeText(200, 'verified')));

/** The backend under test, built by the framework from `actor-ts.http.backend`, bound through `bind()`. */
async function boundDemanding(backend: string, runtime: RuntimeKind | undefined, ca: string): Promise<ServerBinding> {
  if (runtime !== undefined) setRuntimeOverride(runtime);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { http: { backend } } });
  const system = ActorSystem.create(`http-client-certificates-${backend}`, systemOptions);
  systems.push(system);
  const serverOptions = HttpServerOptions.create().withTls({ cert: CERT, key: KEY, ca, requestClientCert: true });
  const binding = await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .withServerOptions(serverOptions)
    .bind(routes);
  bindings.push(binding);
  return binding;
}

const arms: ReadonlyArray<readonly [string, string, RuntimeKind | undefined]> = [
  ['Express', 'express', undefined],
  ['Fastify', 'fastify', undefined],
  ['Hono on Bun.serve', 'hono', undefined],
  ['Hono on @hono/node-server', 'hono', 'node'],
];

describe.each(arms)('%s — a client-certificate demand verifies against the configured ca (#1522)', (_label, backend, runtime) => {
  test('a certificate the configured CA signed is answered; one an unrelated CA signed, or none, is refused', async () => {
    const binding = await boundDemanding(backend, runtime, configuredAuthority.cert);
    expect(await requestPresenting(binding.port, configuredClient)).toEqual({ answered: 200 });
    expect(await requestPresenting(binding.port, unrelatedClient)).toHaveProperty('refused');
    expect(await requestPresenting(binding.port, undefined)).toHaveProperty('refused');
  });

  test('naming the other CA turns the verdicts around — the ca decides, not the certificates', async () => {
    // Without this, a listener that admitted the first client for some other
    // reason — any certificate at all, say — would pass the case above.
    const binding = await boundDemanding(backend, runtime, unrelatedAuthority.cert);
    expect(await requestPresenting(binding.port, unrelatedClient)).toEqual({ answered: 200 });
    expect(await requestPresenting(binding.port, configuredClient)).toHaveProperty('refused');
  });
});

/**
 * Fastify takes `https` at construction, so a backend built by hand and handed
 * to `useBackend(...)` verifies client certificates the way *it* was built,
 * whatever the server options passed to `bind()` say.  Built with the
 * certificate and key alone, it bound under a demand and answered a client that
 * presented no certificate; built with `requestCert` and no `ca`, it checked
 * client certificates against the runtime's default trust store instead of the
 * `ca` the options named.  The backend now holds the `https` it was built with
 * against the options, as it already did for TLS itself, HTTP/2 and the size
 * caps (found while #1522).
 */
describe('Fastify built by hand — it verifies the way the server options say, or refuses', () => {
  const demanding = { tls: { cert: CERT, key: KEY, ca: configuredAuthority.cert, requestClientCert: true } };

  /** Bind `backend` under `serverOptions` through bind(); the binding, or what refused it. */
  async function bindByHand(backend: FastifyBackend, serverOptions: Partial<HttpServerOptionsType>): Promise<ServerBinding | unknown> {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('http-client-certificates-fastify-by-hand', systemOptions);
    systems.push(system);
    return system.extension(HttpExtensionId)
      .newServerAt('127.0.0.1', 0)
      .useBackend(backend)
      .withServerOptions(serverOptions)
      .bind(routes)
      .then((binding) => {
        bindings.push(binding);
        return binding;
      }, (error: unknown) => error);
  }

  test('built without the demand, or without its ca, it refuses the demand rather than bind without it', async () => {
    for (const https of [{ cert: CERT, key: KEY }, { cert: CERT, key: KEY, requestCert: true }]) {
      const outcome = await bindByHand(new FastifyBackend({ https }), demanding);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain('FastifyBackend');
      expect((outcome as Error).message).toContain('fastifyFactoryOptions');
    }
  });

  test('built with a demand the options do not make, it refuses too — two settings and nothing to say which holds', async () => {
    const https = { cert: CERT, key: KEY, ca: configuredAuthority.cert, requestCert: true };
    const outcome = await bindByHand(new FastifyBackend({ https }), { tls: { cert: CERT, key: KEY } });
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('FastifyBackend');
  });

  test('built the documented way, from fastifyFactoryOptions, it binds and verifies against the configured ca', async () => {
    const outcome = await bindByHand(new FastifyBackend(fastifyFactoryOptions(demanding)), demanding);
    expect(outcome).not.toBeInstanceOf(Error);
    const port = (outcome as ServerBinding).port;
    expect(await requestPresenting(port, configuredClient)).toEqual({ answered: 200 });
    expect(await requestPresenting(port, unrelatedClient)).toHaveProperty('refused');
    // The same material read twice is the same `ca`: bytes are compared, not identities.
    const asBytes = { tls: { ...demanding.tls, ca: new TextEncoder().encode(configuredAuthority.cert) } };
    const rebuilt = await bindByHand(new FastifyBackend(fastifyFactoryOptions(asBytes)), { tls: { ...asBytes.tls, ca: new TextEncoder().encode(configuredAuthority.cert) } });
    expect(rebuilt).not.toBeInstanceOf(Error);
  });
});
