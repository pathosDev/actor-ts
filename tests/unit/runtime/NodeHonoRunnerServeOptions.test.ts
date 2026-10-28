/**
 * #1486 — what `NodeHonoRunner.serve` hands `@hono/node-server`.
 *
 * `serveOptions` is the channel every per-runtime server option travels down,
 * and on Node it reached nothing: the runner built `serve()`'s bag from
 * `hostname`, `port`, `fetch` and, since #1522, its TLS factory, and read the
 * caller's bag nowhere.  The other suites all pass the WebSocket bridge's empty
 * bag, so a case that only asserts "it starts" stays green against the drop.
 *
 * Most cases stand in a module that records the bag `serve()` receives — the
 * only place it is visible, since the real module consumes it.  The runner is
 * handed the stand-in through its constructor; a
 * `mock.module('@hono/node-server')` would not do, because `mock.restore()`
 * does not undo it (`tests/unit/ci/ModuleMockDiscipline.test.ts`) and the
 * runner's default loader caches the first module it resolves for the whole
 * process.  One case then drives the real module, to show that the keys the
 * stand-in sees are keys `@hono/node-server` acts on; its TLS counterpart,
 * verified against the test CA, sits with the other TLS cases in
 * `tests/unit/http/HttpServerTls.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createSecureServer as createSecureHttp2Server } from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';
import type { HonoServeOptions, HonoServerHandle } from '../../../src/runtime/http/HonoServerRunner.js';
import { NodeHonoRunner } from '../../../src/runtime/http/NodeHonoRunner.js';

type ServerModuleLoader = NonNullable<ConstructorParameters<typeof NodeHonoRunner>[0]>;
type ServerModule = Awaited<ReturnType<ServerModuleLoader>>;
type ServeBag = Parameters<ServerModule['serve']>[0];

/** The port the stand-in reports as bound, so a case can tell its handle from a real one. */
const STAND_IN_PORT = 4321;

/** Stand-in TLS material: nothing parses it here, the cases follow where it ends up. */
const TLS = { cert: 'the configured certificate', key: 'the configured key' } as const;

/**
 * A stand-in for `@hono/node-server` that records every bag `serve()` is
 * handed and binds nothing.  `holdsMaxHeaderSize` decides whether the server it
 * returns reports the `maxHeaderSize` it was built with, the way `node:http`
 * does on Node and Bun — and Deno's shim does not.
 */
function capturingModule(holdsMaxHeaderSize = false): { readonly load: ServerModuleLoader; readonly bags: ServeBag[] } {
  const bags: ServeBag[] = [];
  const module: ServerModule = {
    serve(options, onReady) {
      bags.push(options);
      // The real module reports from `listen()`'s callback, after `serve()` has
      // returned — and the runner reads `serve()`'s return value inside it.
      queueMicrotask(() => onReady?.({ address: '127.0.0.1', port: STAND_IN_PORT }));
      const built = (options.serverOptions as { maxHeaderSize?: number }).maxHeaderSize;
      return {
        close: (callback?: () => void) => { callback?.(); },
        address: () => ({ address: '127.0.0.1', port: STAND_IN_PORT }),
        ...(holdsMaxHeaderSize ? { maxHeaderSize: built } : {}),
      };
    },
  };
  return { load: async () => module, bags };
}

const hello = (): Response => new Response('hello');

/** A listener factory of the caller's — compared by identity, and loud if anything ever calls it. */
function callerFactory(): never {
  throw new Error('the caller-supplied createServer built the listener');
}

/**
 * `@hono/node-server` replaces `globalThis.Request` and `Response` with its own
 * classes on `serve()` unless told not to.  The real-module case tells it not
 * to — that is one of its observables — so a regression would leave the
 * replacements behind for the rest of the file; they are put back after each.
 */
const nativeGlobals = { Request: globalThis.Request, Response: globalThis.Response };
function restoreNativeGlobals(): void {
  Object.defineProperty(globalThis, 'Request', { value: nativeGlobals.Request, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Response', { value: nativeGlobals.Response, configurable: true, writable: true });
}

const handles: HonoServerHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop(false).catch(() => {});
  restoreNativeGlobals();
});

/** Serve through a fresh stand-in and return the one bag it recorded. */
async function bagFor(options: Omit<HonoServeOptions, 'host' | 'port' | 'fetch'>): Promise<ServeBag> {
  const stub = capturingModule();
  handles.push(await new NodeHonoRunner(stub.load).serve({ host: '127.0.0.1', port: 0, fetch: hello, ...options }));
  expect(stub.bags).toHaveLength(1);
  return stub.bags[0]!;
}

describe('NodeHonoRunner — the @hono/node-server loader (#1486)', () => {
  test('serve() reaches @hono/node-server through the loader it was constructed with', async () => {
    const stub = capturingModule();

    const handle = await new NodeHonoRunner(stub.load).serve({ host: '127.0.0.1', port: 0, fetch: hello });
    handles.push(handle);

    expect(stub.bags).toHaveLength(1);
    expect(handle.port).toBe(STAND_IN_PORT);
  });
});

describe('NodeHonoRunner — serveOptions reach @hono/node-server (#1486)', () => {
  test('every serveOptions key arrives, and host, port and fetch stay the runner\'s', async () => {
    const websocket = { server: 'the bridge\'s server' };
    const bag = await bagFor({
      serveOptions: {
        overrideGlobalObjects: false,
        autoCleanupIncoming: false,
        websocket,
        serverOptions: { maxHeaderSize: 8192 },
        hostname: '0.0.0.0',
        port: 9,
        fetch: () => new Response('not the runner\'s handler'),
      },
    });

    expect(bag.overrideGlobalObjects).toBe(false);
    expect(bag.autoCleanupIncoming).toBe(false);
    expect(bag.websocket).toBe(websocket);
    expect(bag.serverOptions).toEqual({ maxHeaderSize: 8192 });
    // Where the listener binds and what answers on it are not the bag's to move.
    expect(bag.hostname).toBe('127.0.0.1');
    expect(bag.port).toBe(0);
    expect(bag.fetch).toBe(hello);
  });

  test('with tls, the caller\'s serverOptions merge beneath the certificate and the TLS factory builds the listener', async () => {
    const bag = await bagFor({
      tls: TLS,
      serveOptions: {
        serverOptions: { maxHeaderSize: 1024, cert: 'a certificate of the caller\'s', key: 'a key of the caller\'s' },
        createServer: callerFactory,
      },
    });

    // Both halves survive the merge: the caller's tuning key, and the
    // configured material over the caller's own.
    expect(bag.serverOptions).toEqual({ maxHeaderSize: 1024, cert: TLS.cert, key: TLS.key });
    expect(bag.createServer as unknown).toBe(createHttpsServer);
  });

  test('with tls and http2, the secure HTTP/2 factory keeps HTTP/1.1 beside the caller\'s keys', async () => {
    const bag = await bagFor({
      tls: TLS,
      http2: true,
      serveOptions: { serverOptions: { maxHeaderSize: 1024, allowHTTP1: false } },
    });

    // `allowHTTP1` is what keeps HTTP/1.1 on the h2 port (#1522); the caller's
    // `false` does not get to take it away.
    expect(bag.serverOptions).toEqual({ maxHeaderSize: 1024, cert: TLS.cert, key: TLS.key, allowHTTP1: true });
    expect(bag.createServer as unknown).toBe(createSecureHttp2Server);
  });

  test('with a client-certificate demand, ca, requestCert and rejectUnauthorized arrive in node:tls\'s spelling, over the caller\'s', async () => {
    // The verifying half of the mapping (#1522).  Without `ca` the listener
    // checks client certificates against the runtime's default trust store,
    // and a caller's `ca` or `requestCert: false` left standing in the bag
    // would decide who the demand admits — so the typed fields outrank them,
    // as the certificate and key do.
    const bag = await bagFor({
      tls: { ...TLS, ca: 'the configured authority', requestClientCert: true, rejectUnauthorized: true },
      serveOptions: { serverOptions: { ca: 'an authority of the caller\'s', requestCert: false, rejectUnauthorized: false } },
    });

    expect(bag.serverOptions).toEqual({
      cert: TLS.cert,
      key: TLS.key,
      ca: 'the configured authority',
      requestCert: true,
      rejectUnauthorized: true,
    });
    expect(bag.createServer as unknown).toBe(createHttpsServer);
  });

  test('the bag cannot choose the listener: without tls a caller\'s createServer is not used either', async () => {
    // The factory decides whether the socket speaks TLS or HTTP/2 at all, and
    // that is `tls`/`http2`'s to say — a plain `http2.createServer` arriving
    // here would be the h2c listener the options validator refuses (#1522).
    const bag = await bagFor({ serveOptions: { createServer: callerFactory } });

    expect(bag.createServer).toBeUndefined();
  });
});

describe('NodeHonoRunner — the typed maxHeaderBytes reaches @hono/node-server as maxHeaderSize (#1488)', () => {
  test('without tls, it lands in serverOptions beside the caller\'s keys, and the module builds the listener', async () => {
    const bag = await bagFor({ maxHeaderBytes: 1024, serveOptions: { serverOptions: { keepAliveTimeout: 7_000 } } });

    expect(bag.serverOptions).toEqual({ keepAliveTimeout: 7_000, maxHeaderSize: 1024 });
    expect(bag.createServer).toBeUndefined();
  });

  test('with tls, it lands in the TLS factory\'s serverOptions beside the certificate', async () => {
    // Under TLS `@hono/node-server` hands `serverOptions` to the https factory
    // the runner picked, so this is the one place a header cap can reach a
    // TLS listener at all.
    const bag = await bagFor({ tls: TLS, maxHeaderBytes: 1024 });

    expect(bag.serverOptions).toEqual({ maxHeaderSize: 1024, cert: TLS.cert, key: TLS.key });
    expect(bag.createServer as unknown).toBe(createHttpsServer);
  });

  test('with tls and http2 too — the secure HTTP/2 factory gets it beside allowHTTP1', async () => {
    const bag = await bagFor({ tls: TLS, http2: true, maxHeaderBytes: 1024 });

    expect(bag.serverOptions).toEqual({ maxHeaderSize: 1024, cert: TLS.cert, key: TLS.key, allowHTTP1: true });
    expect(bag.createServer as unknown).toBe(createSecureHttp2Server);
  });

  test('the typed member outranks a maxHeaderSize in the caller\'s bag', async () => {
    // The bag goes beneath everything the runner writes (#1486), and the
    // server option is something the runner writes.
    const bag = await bagFor({ maxHeaderBytes: 1024, serveOptions: { serverOptions: { maxHeaderSize: 8192 } } });

    expect(bag.serverOptions).toEqual({ maxHeaderSize: 1024 });
  });

  test('unset, the runner writes nothing, and a caller\'s own maxHeaderSize passes as it came', async () => {
    const bag = await bagFor({ serveOptions: { serverOptions: { maxHeaderSize: 8192 } } });

    expect(bag.serverOptions).toEqual({ maxHeaderSize: 8192 });
  });

  test('the handle claims the cap only when the server it got back holds it', async () => {
    // Read back rather than assumed: a runtime whose node:http ignores the
    // option — Deno's shim reads it back as undefined and lets a 4 KiB header
    // through (deno 2.6.8) — must report the cap not in effect.
    const holding = capturingModule(true);
    const ignoring = capturingModule(false);
    const held = await new NodeHonoRunner(holding.load).serve({ host: '127.0.0.1', port: 0, fetch: hello, maxHeaderBytes: 1024 });
    const ignored = await new NodeHonoRunner(ignoring.load).serve({ host: '127.0.0.1', port: 0, fetch: hello, maxHeaderBytes: 1024 });
    handles.push(held, ignored);

    expect(held.appliedServeOptions).toEqual({ maxHeaderBytes: true });
    expect(ignored.appliedServeOptions).toEqual({ maxHeaderBytes: false });
  });
});

describe('NodeHonoRunner — the real @hono/node-server acts on what is forwarded (#1486)', () => {
  test('overrideGlobalObjects and serverOptions.maxHeaderSize both take effect', async () => {
    const handle = await new NodeHonoRunner().serve({
      host: '127.0.0.1',
      port: 0,
      fetch: hello,
      serveOptions: { overrideGlobalObjects: false, serverOptions: { maxHeaderSize: 1024 } },
    });
    handles.push(handle);

    // Left to its default, the module swaps in its own Request/Response classes.
    expect(globalThis.Request).toBe(nativeGlobals.Request);
    expect(globalThis.Response).toBe(nativeGlobals.Response);

    const plain = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(plain.status).toBe(200);
    expect(await plain.text()).toBe('hello');

    // A header block past the caller's cap is refused by `node:http` itself.
    const oversized = await fetch(`http://127.0.0.1:${handle.port}/`, { headers: { 'x-oversized': 'a'.repeat(4096) } });
    expect(oversized.status).toBe(431);
  });
});
