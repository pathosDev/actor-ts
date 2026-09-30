import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { connect as http2Connect, createSecureServer, type ClientHttp2Session } from 'node:http2';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { afterEach, describe, expect, test } from 'bun:test';
import { applyServerOptions, type NodeHttpServerLike } from '../../../src/http/backend/HttpServerBackend.js';

/**
 * The header deadline on the two transports where the socket `'connection'`
 * hands out is not the one a request arrives on: TLS and HTTP/2 (#870).
 *
 * The deadline is armed on the accepted TCP socket and has to be cleared by
 * whatever the server hands back once a header block completes.  On a
 * plaintext HTTP/1.1 server that is the same object, which is all the first
 * version of the guard knew.  Measured on node v26.10.0 and bun 1.4.2 against
 * `https.createServer` and `http2.createSecureServer({ allowHTTP1 })`, with the
 * listeners registered after `listen()` the way `applyServerOptions` does:
 *
 *   - **Node, TLS** — `'connection'` hands the raw TCP socket,
 *     `'secureConnection'` a *different* TLS socket, and `'request'` hands the
 *     TLS one.  The deadline never cleared, so a healthy keep-alive connection
 *     was reset one header timeout after it opened.
 *   - **Bun, TLS** — all three are one object, so Bun was correct by accident.
 *   - **Both, HTTP/2** — `'session'` fires *before* a `'secureConnection'`
 *     listener registered after the server's own, with a session socket that is
 *     neither object (a Proxy on Node, a third object on Bun), and a request's
 *     `socket` is per-stream.  Every HTTP/2 session died at the deadline.
 *
 * What every one of those objects does agree on is the connection's two
 * endpoints — local and remote address and port — which is what a TCP
 * connection *is*.  The repaired guard carries the deadline across the hops by
 * that pair, which is why the fakes below give each object its own identity and
 * one shared endpoint: that is the measured shape, and identity alone is the
 * defect.
 *
 * The first block drives this runtime's own servers.  Under `bun test` that
 * means Bun, where only the HTTP/2 case was red; the Node TLS shape is reached
 * for real by `tests/smoke/cases/36-http-tls-termination.mjs` under
 * `bun run smoke`, and here by the fakes in the second block.
 */

const FIXTURES = new URL('../../fixtures/tls/', import.meta.url);
const CERT = readFileSync(new URL('localhost-cert.pem', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('localhost-key.pem', FIXTURES), 'utf8');
const CA = readFileSync(new URL('test-ca.pem', FIXTURES), 'utf8');

const COMPLETE_REQUEST = 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n';
/** The slow-loris shape: a header block that never gets its terminating blank line. */
const PARTIAL_REQUEST = 'GET / HTTP/1.1\r\nHost: localhost\r\n';

describe('on this runtime\'s own TLS and HTTP/2 servers', () => {
  /** Short enough to keep the suite quick, long enough to be unambiguous under load. */
  const DEADLINE_MS = 400;
  /** How long a connection that must survive is watched — five deadlines. */
  const SURVIVAL_WINDOW_MS = 2_000;
  /** How long a connection that must be cut may take — the deadline plus slack for a loaded runner. */
  const EXPIRY_WINDOW_MS = 3_000;
  /** Real sockets and a watch window: past bun's 5 s default, stated rather than inherited. */
  const LIVE_TEST_TIMEOUT_MS = 10_000;

  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  const answer = (_request: unknown, response: { setHeader: (n: string, v: string) => void; end: (b: string) => void }): void => {
    response.setHeader('connection', 'keep-alive');
    response.end('ok');
  };

  async function listen(server: { listen: (port: number, host: string, cb: () => void) => unknown; address: () => unknown }): Promise<number> {
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    return (server.address() as { port: number }).port;
  }

  async function httpsServer(): Promise<number> {
    const server = createHttpsServer({ cert: CERT, key: KEY }, answer);
    const port = await listen(server);
    applyServerOptions(server as unknown as NodeHttpServerLike, { headerTimeoutMs: DEADLINE_MS, idleTimeoutMs: 30_000 });
    cleanups.push(() => { server.closeAllConnections(); server.close(); });
    return port;
  }

  async function http2Server(): Promise<number> {
    const server = createSecureServer({ cert: CERT, key: KEY, allowHTTP1: true }, answer as never);
    const port = await listen(server);
    applyServerOptions(server as unknown as NodeHttpServerLike, { headerTimeoutMs: DEADLINE_MS, idleTimeoutMs: 30_000 });
    cleanups.push(() => { server.close(); });
    return port;
  }

  /** A CA-verified TLS client that writes `payload` once the handshake is done. */
  function tlsClient(port: number, payload: string, alpn?: string[]): TLSSocket {
    const socket = tlsConnect(
      { host: '127.0.0.1', port, ca: CA, servername: 'localhost', ...(alpn ? { ALPNProtocols: alpn } : {}) },
      () => { socket.write(payload); },
    );
    socket.on('error', () => { /* a reset is observed as the 'close' that follows */ });
    cleanups.push(() => { socket.destroy(); });
    return socket;
  }

  /** Resolve once the peer closes `socket` or `withinMs` passes, with what it wrote first. */
  function watchSocket(socket: TLSSocket, withinMs: number): Promise<{ closed: boolean; received: string }> {
    return new Promise((resolve) => {
      let received = '';
      // Draining is not decoration: a paused socket never emits 'close'.
      socket.on('data', (chunk: Buffer) => { received += chunk.toString('latin1'); });
      socket.once('close', () => resolve({ closed: true, received }));
      const timer = setTimeout(() => resolve({ closed: false, received }), withinMs);
      (timer as { unref?: () => void }).unref?.();
    });
  }

  function http2Client(port: number): ClientHttp2Session {
    const session = http2Connect(`https://127.0.0.1:${port}`, { ca: CA });
    cleanups.push(() => { session.destroy(); });
    return session;
  }

  /** Resolve once `session` closes or `withinMs` passes, with how it ended. */
  function watchSession(session: ClientHttp2Session, withinMs: number): Promise<{ closed: boolean; error: string | null; goaway: number | null }> {
    return new Promise((resolve) => {
      let error: string | null = null;
      let goaway: number | null = null;
      session.on('error', (e: NodeJS.ErrnoException) => { error = e.code ?? e.message; });
      session.on('goaway', (code: number) => { goaway = code; });
      session.once('close', () => resolve({ closed: true, error, goaway }));
      const timer = setTimeout(() => resolve({ closed: false, error, goaway }), withinMs);
      (timer as { unref?: () => void }).unref?.();
    });
  }

  test('an HTTPS keep-alive connection that completed a request outlives the deadline', async () => {
    const port = await httpsServer();
    const socket = tlsClient(port, COMPLETE_REQUEST);

    const watched = await watchSocket(socket, SURVIVAL_WINDOW_MS);

    expect(watched.received, 'the request itself was never answered').toContain('200 OK');
    expect(watched.closed, 'a healthy TLS connection was torn down by the header deadline').toBe(false);
  }, LIVE_TEST_TIMEOUT_MS);

  test('an HTTP/2 session that completed a request outlives the deadline', async () => {
    const port = await http2Server();
    const session = http2Client(port);
    const request = session.request({ ':path': '/' });
    request.on('error', () => { /* reported through the session */ });
    const status = new Promise<unknown>((resolve) => { request.on('response', (headers) => resolve(headers[':status'])); });
    request.resume();

    const watched = await watchSession(session, SURVIVAL_WINDOW_MS);

    expect(await status, 'the request itself was never answered').toBe(200);
    expect(watched.closed, `a healthy HTTP/2 session was closed by the header deadline (${watched.error})`).toBe(false);
  }, LIVE_TEST_TIMEOUT_MS);

  test('a slow-loris over TLS is still cut, and answered 408 inside TLS', async () => {
    // The negative control for both cases above: a guard that stopped arming on
    // TLS listeners would pass them, and reopen the hole the key exists to close.
    const port = await httpsServer();
    const socket = tlsClient(port, PARTIAL_REQUEST);

    const watched = await watchSocket(socket, EXPIRY_WINDOW_MS);

    expect(watched.closed, 'the header deadline never closed a TLS slow-loris').toBe(true);
    expect(watched.received, 'the 408 did not reach the TLS client').toContain('408 Request Timeout');
  }, LIVE_TEST_TIMEOUT_MS);

  test('an HTTP/2 session that never opens a stream is closed at the deadline, with a GOAWAY', async () => {
    // The HTTP/2 slow-loris: a session that completes its handshake and then
    // never sends a HEADERS frame.  An HTTP/1.1 status line would be noise in
    // an HTTP/2 connection, so the session is closed as a session.
    const port = await http2Server();
    const session = http2Client(port);

    const watched = await watchSession(session, EXPIRY_WINDOW_MS);

    expect(watched.closed, 'the header deadline never closed an idle HTTP/2 session').toBe(true);
    expect(watched.error, 'the session was torn down with bytes it could not parse').toBeNull();
    expect(watched.goaway, 'the session was not told why it was closed').toBe(0);
  }, LIVE_TEST_TIMEOUT_MS);

  test('HTTP/1.1 on an HTTP/2 listener keeps the HTTP/1.1 rules', async () => {
    // `allowHTTP1` hands a TLS socket that negotiated http/1.1 to the ordinary
    // HTTP/1.1 handling, so both halves of the plaintext contract hold there.
    const port = await http2Server();
    const healthy = tlsClient(port, COMPLETE_REQUEST, ['http/1.1']);
    const slow = tlsClient(port, PARTIAL_REQUEST, ['http/1.1']);

    const [survivor, cut] = await Promise.all([
      watchSocket(healthy, SURVIVAL_WINDOW_MS),
      watchSocket(slow, EXPIRY_WINDOW_MS),
    ]);

    expect(survivor.received).toContain('200 OK');
    expect(survivor.closed, 'an HTTP/1.1 keep-alive connection on the HTTP/2 listener was torn down').toBe(false);
    expect(cut.closed, 'an HTTP/1.1 slow-loris on the HTTP/2 listener was not cut').toBe(true);
    expect(cut.received).toContain('408 Request Timeout');
  }, LIVE_TEST_TIMEOUT_MS);
});

/**
 * The shapes a runtime hands out, reproduced as measured, so the half this
 * runner cannot reach — Node's split TLS socket — is red here and not only in
 * the smoke run.  Every object gets its own identity; the ones that stand for
 * one connection share its endpoint pair, exactly as the probe found them.
 */
describe('the deadline follows the connection across the objects that stand for it', () => {
  type Endpoint = { localAddress: string; localPort: number; remoteAddress: string; remotePort: number };
  type FakeListener = (...args: ReadonlyArray<unknown>) => void;

  /** Long enough to be unambiguous under load, short enough to stay a unit test. */
  const DEADLINE_MS = 25;
  /** How long a fake that must survive is watched. */
  const SURVIVAL_WINDOW_MS = 400;

  let nextPort = 50_000;
  const endpoint = (): Endpoint => ({
    localAddress: '127.0.0.1',
    localPort: 8443,
    remoteAddress: '127.0.0.1',
    remotePort: nextPort++,
  });

  function fakeSocket(at?: Endpoint) {
    let destroyed = false;
    let wrote = '';
    const closeListeners: Array<() => void> = [];
    const destroyWaiters: Array<() => void> = [];
    const socket = {
      ...at,
      destroy: (): void => {
        if (destroyed) return;
        destroyed = true;
        for (const waiter of destroyWaiters) waiter();
      },
      once: (_event: 'close', listener: () => void): unknown => { closeListeners.push(listener); return socket; },
      end: (data?: string): unknown => { wrote += data ?? ''; return socket; },
    };
    return {
      socket,
      get destroyed() { return destroyed; },
      get wrote() { return wrote; },
      /** The peer went away: what a real socket reports through `'close'`. */
      close: (): void => { for (const listener of closeListeners) listener(); },
      /** Resolve `true` as soon as the guard destroys this socket, `false` if `withinMs` passes first. */
      destroyedWithin: (withinMs: number): Promise<boolean> => new Promise((resolve) => {
        if (destroyed) { resolve(true); return; }
        destroyWaiters.push(() => resolve(true));
        const timer = setTimeout(() => resolve(false), withinMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    };
  }

  /**
   * An HTTP/2 session as a server hands it out: its `socket` is a third object
   * with the connection's endpoint — Node's Proxy, Bun's own wrapper.
   */
  function fakeSession(at: Endpoint) {
    let destroyed = false;
    const destroyWaiters: Array<() => void> = [];
    const session = {
      socket: { ...at },
      destroy: (): void => {
        if (destroyed) return;
        destroyed = true;
        for (const waiter of destroyWaiters) waiter();
      },
    };
    return {
      session,
      get destroyed() { return destroyed; },
      destroyedWithin: (withinMs: number): Promise<boolean> => new Promise((resolve) => {
        if (destroyed) { resolve(true); return; }
        destroyWaiters.push(() => resolve(true));
        const timer = setTimeout(() => resolve(false), withinMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    };
  }

  /** A server that records listeners and emits on demand; `secure` gives it the TLS listener's mark. */
  function fakeServer(secure: boolean) {
    const listeners = new Map<string, FakeListener[]>();
    const record = (event: string, listener: FakeListener): unknown => {
      const existing = listeners.get(event);
      if (existing) existing.push(listener);
      else listeners.set(event, [listener]);
      return undefined;
    };
    const server = {
      on: record as NodeHttpServerLike['on'],
      ...(secure ? { setSecureContext: (): void => { /* only its presence is read */ } } : {}),
    } as NodeHttpServerLike;
    const emit = (event: string, ...args: ReadonlyArray<unknown>): void => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    };
    applyServerOptions(server, { headerTimeoutMs: DEADLINE_MS });
    return emit;
  }

  test('Node\'s TLS shape: a request on the TLS socket clears the deadline armed on the TCP socket', async () => {
    const emit = fakeServer(true);
    const at = endpoint();
    const raw = fakeSocket(at);
    const secured = fakeSocket(at);
    emit('connection', raw.socket);
    emit('secureConnection', secured.socket);
    emit('request', { socket: secured.socket }, {});

    expect(await raw.destroyedWithin(SURVIVAL_WINDOW_MS), 'the TCP socket of a completed request was cut').toBe(false);
    expect(secured.destroyed, 'the TLS socket of a completed request was cut').toBe(false);
  });

  test('…and a WebSocket upgrade on the TLS socket clears it too', async () => {
    const emit = fakeServer(true);
    const at = endpoint();
    const raw = fakeSocket(at);
    const secured = fakeSocket(at);
    emit('connection', raw.socket);
    emit('secureConnection', secured.socket);
    emit('upgrade', {}, secured.socket, new Uint8Array());

    expect(await raw.destroyedWithin(SURVIVAL_WINDOW_MS), 'a WSS connection was cut one header timeout in').toBe(false);
  });

  test('Node\'s TLS shape: a slow-loris is answered on the TLS socket, never beneath it', async () => {
    const emit = fakeServer(true);
    const at = endpoint();
    const raw = fakeSocket(at);
    const secured = fakeSocket(at);
    emit('connection', raw.socket);
    emit('secureConnection', secured.socket);

    expect(await secured.destroyedWithin(SURVIVAL_WINDOW_MS), 'the TLS slow-loris was not cut').toBe(true);
    expect(secured.wrote, 'the 408 did not go out inside TLS').toContain('408 Request Timeout');
    expect(raw.wrote, 'a plaintext status line was written beneath TLS').toBe('');
  });

  test('a handshake that never completes is cut inside the deadline, without a status line', async () => {
    // The handshake is part of the window: a peer that opens a TCP connection
    // and never finishes negotiating TLS is the slow-loris one layer down.
    // There is no HTTP layer yet to answer it, so it is only hung up on.
    const emit = fakeServer(true);
    const raw = fakeSocket(endpoint());
    emit('connection', raw.socket);

    expect(await raw.destroyedWithin(SURVIVAL_WINDOW_MS), 'a stalled handshake outlived the deadline').toBe(true);
    expect(raw.wrote, 'HTTP bytes were written into a TLS handshake').toBe('');
  });

  test('HTTP/2: the session arrives before secureConnection, and its first stream clears the deadline', async () => {
    // Listener order, measured on both runtimes: the server's own
    // `'secureConnection'` handler creates the session and emits `'session'`
    // synchronously, before any listener registered after `listen()` runs.
    // A request's `socket` is per stream and matches nothing.
    const emit = fakeServer(true);
    const at = endpoint();
    const raw = fakeSocket(at);
    const secured = fakeSocket(at);
    const faked = fakeSession(at);
    emit('connection', raw.socket);
    emit('session', faked.session);
    emit('secureConnection', secured.socket);
    emit('request', { socket: { ...at } }, {});
    emit('stream', { session: faked.session }, {}, 0);

    // The session is what an expiry closes, so it is what has to survive.
    expect(await faked.destroyedWithin(SURVIVAL_WINDOW_MS), 'a healthy HTTP/2 session was closed').toBe(false);
    expect(raw.destroyed).toBe(false);
    expect(secured.destroyed).toBe(false);
  });

  test('HTTP/2: a session that never opens a stream is closed as a session', async () => {
    const emit = fakeServer(true);
    const at = endpoint();
    const raw = fakeSocket(at);
    const secured = fakeSocket(at);
    const faked = fakeSession(at);
    emit('connection', raw.socket);
    emit('session', faked.session);
    emit('secureConnection', secured.socket);

    expect(await faked.destroyedWithin(SURVIVAL_WINDOW_MS), 'an HTTP/2 session with no stream outlived the deadline').toBe(true);
    expect(secured.wrote, 'an HTTP/1.1 status line was written into an HTTP/2 connection').toBe('');
    expect(raw.wrote).toBe('');
  });

  test('the endpoint names one connection: a TLS socket clears its own deadline and no other', async () => {
    // Guards against correlating by arrival order — the oldest or the newest
    // pending TCP socket — which concurrent handshakes finishing out of order
    // turn into one connection clearing another's deadline.  The middle one of
    // three completes, so neither end of the queue is the right answer.
    const emit = fakeServer(true);
    const [before, middle, after] = [endpoint(), endpoint(), endpoint()];
    const beforeRaw = fakeSocket(before);
    const middleRaw = fakeSocket(middle);
    const afterRaw = fakeSocket(after);
    const middleSecured = fakeSocket(middle);
    emit('connection', beforeRaw.socket);
    emit('connection', middleRaw.socket);
    emit('connection', afterRaw.socket);
    emit('secureConnection', middleSecured.socket);
    emit('request', { socket: middleSecured.socket }, {});

    const [beforeCut, afterCut] = await Promise.all([
      beforeRaw.destroyedWithin(SURVIVAL_WINDOW_MS),
      afterRaw.destroyedWithin(SURVIVAL_WINDOW_MS),
    ]);
    expect(beforeCut, 'a stalled connection was cleared by a neighbour').toBe(true);
    expect(afterCut, 'a stalled connection was cleared by a neighbour').toBe(true);
    expect(await middleRaw.destroyedWithin(SURVIVAL_WINDOW_MS), 'the connection that completed a request was cut').toBe(false);
  });

  test('a socket that reports no endpoint is matched by identity alone, never by an empty key', async () => {
    // A runtime that cannot name a socket's endpoint must not make every such
    // socket share one: then any request would clear every slow-loris.
    const emit = fakeServer(false);
    const completed = fakeSocket();
    const stalled = fakeSocket();
    emit('connection', completed.socket);
    emit('connection', stalled.socket);
    emit('secureConnection', fakeSocket().socket);
    emit('request', { socket: completed.socket }, {});

    expect(await stalled.destroyedWithin(SURVIVAL_WINDOW_MS), 'an endpoint-less slow-loris was cleared by another request').toBe(true);
    expect(stalled.wrote, 'the slow-loris was answered on some other socket').toContain('408 Request Timeout');
    expect(await completed.destroyedWithin(SURVIVAL_WINDOW_MS), 'the request that completed was cut').toBe(false);
  });

  test('a connection that reports its close late does not take a newer one\'s endpoint with it', async () => {
    // A client can reuse a port as soon as its side of the old connection is
    // gone, and the server may hear the new SYN before it has run the old
    // socket's 'close'.  Unmapping the pair unconditionally at that close would
    // orphan the newer connection, whose handshake then never re-keys — and a
    // healthy TLS connection is cut, which is the defect this file is about.
    const emit = fakeServer(true);
    const at = endpoint();
    const earlier = fakeSocket(at);
    const raw = fakeSocket(at);
    const secured = fakeSocket(at);
    emit('connection', earlier.socket);
    emit('connection', raw.socket);
    earlier.close();
    emit('secureConnection', secured.socket);
    emit('request', { socket: secured.socket }, {});

    expect(await raw.destroyedWithin(SURVIVAL_WINDOW_MS), 'the newer connection lost its deadline to the older one\'s close').toBe(false);
    expect(earlier.wrote, 'a connection that had closed was still answered').toBe('');
  });
});
