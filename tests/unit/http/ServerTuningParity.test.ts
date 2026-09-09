import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { HonoBackend } from '../../../src/http/backend/HonoBackend.js';
import {
  applyServerOptions,
  enforceHeaderTimeout,
  enforceMaxConnections,
  type HttpServerBackend,
  type NodeHttpServerLike,
  type ServerBinding,
} from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { HttpServerOptions } from '../../../src/http/HttpServerOptions.js';
import { complete, get, type Route } from '../../../src/http/Route.js';
import { Status } from '../../../src/http/Types.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

/**
 * #870 — `actor-ts.http.server` installs connection-level bounds on the server
 * a backend just started listening on.  Modelled on `BodySizeParity.test.ts`,
 * but with the opposite conclusion baked in: the body cap is a property of the
 * *framework* and holds on all three backends, while these bounds are
 * properties of a `node:http` server and hold only where one exists.
 *
 * So this suite asserts **per-target support explicitly**, in the shape
 * `BackendTransportFrameCap.test.ts` uses for the `ws` shim.  A test that
 * expected one behaviour everywhere would be wrong on Hono, and papering over
 * that is how a caveat becomes a surprise in production.
 *
 * **The Hono expectation is about the runtime, not about Hono.**  Hono owns no
 * server: it delegates to a per-runtime runner, and only `@hono/node-server`
 * hands its `node:http` server back (as `HonoServerHandle.raw`).  This suite
 * runs under Bun, where `Bun.serve` exposes neither that server nor an
 * equivalent knob — so the cap is *not installed*, and the test says so out
 * loud.  The day a Hono runner exposes one, this case goes red and both the
 * docs caveat and the table in `applyServerOptions` can be lifted.
 */

const backends: Array<[name: string, make: () => HttpServerBackend, installsCap: boolean]> = [
  ['fastify', () => new FastifyBackend({ logger: false }), true],
  ['express', () => new ExpressBackend(), true],
  // false under Bun — see the note above; it would be true under Node.
  ['hono', () => new HonoBackend(), false],
];

const live: Array<{ binding: ServerBinding; system: ActorSystem }> = [];
const sockets: Socket[] = [];

afterEach(async () => {
  while (sockets.length) sockets.shift()!.destroy();
  while (live.length) {
    const { binding, system } = live.shift()!;
    await binding.unbind();
    await system.terminate();
  }
});

const routes: Route = get(() => complete(Status.OK, 'ok'));

async function start(backend: HttpServerBackend, maxConnections: number): Promise<ServerBinding> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('http-server-tuning-parity', systemOptions);
  const serverOptions = HttpServerOptions.create().withMaxConnections(maxConnections);
  const binding = await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(backend)
    .withServerOptions(serverOptions)
    .bind(routes);
  live.push({ binding, system });
  return binding;
}

function open(binding: ServerBinding): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: binding.host, port: binding.port }, () => resolve(socket));
    socket.once('error', reject);
    sockets.push(socket);
  });
}

/** Resolve `true` if the server closes `socket` within `withinMs`. */
function closedWithin(socket: Socket, withinMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Without this listener the socket stays paused and never emits 'close',
    // so every case reads as "left open" whatever the server did.
    socket.on('data', () => { /* drain */ });
    socket.once('close', () => resolve(true));
    const timer = setTimeout(() => resolve(false), withinMs);
    (timer as { unref?: () => void }).unref?.();
  });
}

describe('the resolved server policy reaches each backend', () => {
  test.each(backends)('%s', async (name, make, installsCap) => {
    const binding = await start(make(), 1);
    await open(binding);
    const second = await open(binding);

    // One assertion, two meanings, and the boolean in the table is the whole
    // point: on a backend that owns a node:http server the cap closes the
    // second connection; on one that does not, the connection survives and
    // the key is documented as unavailable rather than quietly ineffective.
    expect(await closedWithin(second, 3_000)).toBe(installsCap);
  });
});

/**
 * The mapping itself, away from any server — the half that is the same on
 * every target, so it is worth pinning once rather than three times.
 */
describe('applyServerOptions', () => {
  test('writes every field the policy names', () => {
    const server: NodeHttpServerLike = {};
    const applied = applyServerOptions(server, {
      idleTimeoutMs: 1_000,
      headerTimeoutMs: 2_000,
      requestTimeoutMs: 3_000,
      maxConnections: 4,
    });

    expect(server.keepAliveTimeout).toBe(1_000);
    expect(server.headersTimeout).toBe(2_000);
    expect(server.requestTimeout).toBe(3_000);
    expect(server.maxConnections).toBe(4);
    expect(applied).toEqual({
      idleTimeoutMs: true,
      headerTimeoutMs: true,
      requestTimeoutMs: true,
      maxConnections: true,
    });
  });

  test('leaves a field the policy does not name completely alone', () => {
    // Load-bearing, not tidiness: Fastify sets keepAliveTimeout to 72 s on
    // purpose, and an unset idle-timeout has to preserve that rather than
    // overwrite it with `undefined`.
    const server: NodeHttpServerLike = { keepAliveTimeout: 72_000, requestTimeout: 0 };
    const applied = applyServerOptions(server, { headerTimeoutMs: 5_000 });

    expect(server.keepAliveTimeout).toBe(72_000);
    expect(server.requestTimeout).toBe(0);
    expect(server.headersTimeout).toBe(5_000);
    expect(applied.idleTimeoutMs).toBe(false);
    expect(applied.maxConnections).toBe(false);
  });

  test('does not write Infinity — it is the code spelling of "no cap", not a value', () => {
    const server: NodeHttpServerLike = {};
    const applied = applyServerOptions(server, { maxConnections: Infinity });

    expect(server.maxConnections).toBeUndefined();
    expect(applied.maxConnections).toBe(false);
  });

  test('0 IS written — it is the runtime\'s own "disable this guard"', () => {
    const server: NodeHttpServerLike = { requestTimeout: 300_000 };
    applyServerOptions(server, { requestTimeoutMs: 0 });

    expect(server.requestTimeout).toBe(0);
  });

  test('an absent server is ordinary — it is how an untunable runtime reports itself', () => {
    expect(applyServerOptions(undefined, { maxConnections: 1 }).maxConnections).toBe(false);
    expect(applyServerOptions(null, { maxConnections: 1 }).maxConnections).toBe(false);
  });
});

/**
 * The header deadline held in this repository, against a server that ignores
 * the property — which on the primary toolchain is every server there is.
 *
 * Measured on a bare `node:http` server, a socket that sends a header block
 * with no terminating blank line: node v26.7.0 answers `408` and closes;
 * bun 1.4.0 stores `headersTimeout`, reports it back unchanged and enforces
 * nothing (`2000`, `40000`, `120000` and `0` all closed at ~12 s with no bytes
 * received, which is Bun's own idle timeout); deno 2.6.8 ignores it and never
 * closes at all.  `HttpConfigDefaults.test.ts` observes the repaired behaviour
 * end to end; this pins the mechanism, including the two halves that suite
 * cannot reach — the `'upgrade'` path and a runtime with no seam (#870).
 */
describe('the header deadline is enforced here, not delegated', () => {
  type FakeSocket = {
    destroy: () => void;
    once: (event: 'close', listener: () => void) => unknown;
    end: (data?: string) => unknown;
  };
  type FakeListener = (...args: ReadonlyArray<unknown>) => void;

  /** Long enough to be unambiguous under load, short enough to stay a unit test. */
  const DEADLINE_MS = 25;
  const SETTLE_MS = 400;

  const settle = (): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, SETTLE_MS);
    (timer as { unref?: () => void }).unref?.();
  });

  function fakeServer() {
    const listeners = new Map<string, FakeListener[]>();
    const record = (event: string, listener: FakeListener): unknown => {
      const existing = listeners.get(event);
      if (existing) existing.push(listener);
      else listeners.set(event, [listener]);
      return undefined;
    };
    const server: NodeHttpServerLike = { on: record as NodeHttpServerLike['on'] };
    const emit = (event: string, ...args: ReadonlyArray<unknown>): void => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    };
    const connect = () => {
      let destroyed = false;
      let wrote = '';
      const closeListeners: Array<() => void> = [];
      const socket: FakeSocket = {
        destroy: () => { destroyed = true; },
        once: (_event, listener) => { closeListeners.push(listener); return socket; },
        end: (data) => { wrote += data ?? ''; return socket; },
      };
      emit('connection', socket);
      return {
        socket,
        get destroyed() { return destroyed; },
        get wrote() { return wrote; },
        close: () => { for (const listener of closeListeners) listener(); },
      };
    };
    return { server, connect, emit };
  }

  test('a runtime that ignores headersTimeout still hangs up on a slow-loris', async () => {
    const { server, connect } = fakeServer();
    applyServerOptions(server, { headerTimeoutMs: DEADLINE_MS });

    // The fake never acts on this, which is the whole point of the fake.
    expect(server.headersTimeout).toBe(DEADLINE_MS);

    const connection = connect();
    await settle();

    expect(connection.destroyed, 'the header deadline never fired').toBe(true);
    expect(connection.wrote, 'hung up without the documented 408').toContain('408 Request Timeout');
  });

  test('a completed header block disarms the deadline', async () => {
    // Both halves, or this passes against a guard that never arms: the socket
    // that finished its headers survives, the one beside it that did not does
    // not.
    const { server, connect, emit } = fakeServer();
    applyServerOptions(server, { headerTimeoutMs: DEADLINE_MS });

    const completed = connect();
    const dribbling = connect();
    emit('request', { socket: completed.socket }, {});
    await settle();

    expect(completed.destroyed, 'a request that delivered its headers was cut off').toBe(false);
    expect(dribbling.destroyed, 'the deadline was not armed at all').toBe(true);
  });

  test('a WebSocket upgrade disarms it too, or every socket dies one timeout in', async () => {
    // `'upgrade'` hands (request, socket, head) — the socket at a different
    // index than `'request'` puts it, which is why the guard matches by
    // identity.  Without this arm a WebSocket connection, whose whole purpose
    // is to outlive its handshake, is destroyed a header timeout after it
    // opens.
    const { server, connect, emit } = fakeServer();
    applyServerOptions(server, { headerTimeoutMs: DEADLINE_MS });

    const upgraded = connect();
    emit('upgrade', {}, upgraded.socket, new Uint8Array());
    await settle();

    expect(upgraded.destroyed).toBe(false);
  });

  test('0 arms nothing — the documented opt-out, not "close immediately"', async () => {
    const { server, connect } = fakeServer();
    applyServerOptions(server, { headerTimeoutMs: 0 });

    // Still written: `0` is also `node:http`'s own spelling for "no bound".
    expect(server.headersTimeout).toBe(0);

    const connection = connect();
    await settle();

    expect(connection.destroyed).toBe(false);
  });

  test('the other three knobs arm no deadline of their own', async () => {
    // The negative control: a policy that only caps connections must not start
    // hanging up on connections that are merely slow.
    const { server, connect } = fakeServer();
    applyServerOptions(server, { idleTimeoutMs: 1_000, requestTimeoutMs: 3_000, maxConnections: 10 });

    const connection = connect();
    await settle();

    expect(connection.destroyed).toBe(false);
  });

  test('a closed connection disarms itself, so nothing is left holding a timer', async () => {
    const { server, connect } = fakeServer();
    applyServerOptions(server, { headerTimeoutMs: DEADLINE_MS });

    const connection = connect();
    connection.close();
    await settle();

    // `destroy` on an already-closed socket is harmless, but a guard that
    // still fired would also still be writing to it — and, on a real server,
    // holding the timer that keeps the process awake.
    expect(connection.wrote).toBe('');
  });

  test('a server that emits no connections is left alone rather than half-guarded', () => {
    // `Bun.serve` / `Deno.serve` handles reach `applyServerOptions` with no
    // `on` at all, and Deno's `node:http` shim has one that never emits
    // `'connection'`.  Writing the property and installing nothing is the
    // honest outcome; throwing would take down a bind that works today.
    const server: NodeHttpServerLike = {};
    expect(() => applyServerOptions(server, { headerTimeoutMs: 1_000 })).not.toThrow();
    expect(server.headersTimeout).toBe(1_000);
    expect(enforceHeaderTimeout(server, 1_000)).toBe(false);
  });
});

/**
 * The cap held in this repository, against a server that ignores the property.
 *
 * This is the half no end-to-end case here can reach.  The three cases above
 * pass locally *because the runtime enforces `maxConnections` itself* — probed
 * on bun 1.4.0 and node v26.7.0, the second connection is closed and only one
 * `'connection'` event is emitted, the refused socket never reaching a
 * listener.  On GitHub's Linux runners the same bun release does not, which is
 * how those three cases were red on `develop` in two independent workflows
 * while green on every developer machine.
 *
 * A fake stands in for that runtime deliberately: it is the only way to write
 * "the property was set and the runtime did nothing about it" as a test that
 * fails on the machine reading it, rather than only on an operating system
 * this suite cannot run.  What the fake does *not* stand in for is whether the
 * event fires at all on that runtime — that stays a CI observation, and the
 * three cases above are what report it.
 */
describe('the connection cap is enforced here, not delegated', () => {
  type FakeSocket = { destroy: () => void; once: (event: 'close', listener: () => void) => unknown };

  function fakeServer() {
    const listeners: Array<(socket: FakeSocket) => void> = [];
    const server: NodeHttpServerLike = {
      on: (_event, listener) => { listeners.push(listener as (socket: FakeSocket) => void); return server; },
    };
    const open = (): { destroyed: boolean; close: () => void } => {
      let destroyed = false;
      const closeListeners: Array<() => void> = [];
      const socket: FakeSocket = {
        destroy: () => { destroyed = true; },
        once: (_event, listener) => { closeListeners.push(listener); return socket; },
      };
      for (const listener of listeners) listener(socket);
      return { get destroyed() { return destroyed; }, close: () => { for (const l of closeListeners) l(); } };
    };
    return { server, open };
  }

  test('a socket that cannot report its close is still counted, not waved through', () => {
    // The direction a security control has to degrade in.  The first shape of
    // this guard read `if (typeof socket.once !== 'function') { held--; return; }`
    // — so on a runtime whose sockets carry no `once`, every connection was
    // counted and immediately uncounted, `held` never grew, and the cap never
    // fired at all.  Failing open is the one outcome a cap must not have; a
    // count that only rises is stricter than asked for, which is the wrong
    // answer in the right direction.
    const listeners: Array<(socket: { destroy: () => void }) => void> = [];
    const server: NodeHttpServerLike = {
      on: (_event, listener) => {
        listeners.push(listener as (socket: { destroy: () => void }) => void);
        return server;
      },
    };
    const report = enforceMaxConnections(server, 1);
    const openWithoutOnce = (): boolean => {
      let destroyed = false;
      // No `once` — the shape the old guard silently gave up on.
      for (const listener of listeners) listener({ destroy: () => { destroyed = true; } });
      return destroyed;
    };

    expect(openWithoutOnce()).toBe(false);
    expect(openWithoutOnce(), 'the cap failed open on a socket with no close event').toBe(true);
    expect(report().refused).toBe(1);
  });

  test('a runtime that ignores maxConnections still gets the documented cap', () => {
    const { server, open } = fakeServer();
    applyServerOptions(server, { maxConnections: 2 });

    // The fake never acts on this, which is the whole point of the fake.
    expect(server.maxConnections).toBe(2);

    const first = open();
    const second = open();
    const third = open();

    expect(first.destroyed).toBe(false);
    expect(second.destroyed).toBe(false);
    expect(third.destroyed, 'the connection past the cap was admitted').toBe(true);
  });

  test('a closed connection releases its slot, so the cap bounds concurrency and not a lifetime', () => {
    // Without the 'close' bookkeeping the count only rises and `max-connections
    // = 2` becomes "two connections, ever" — a server that stops accepting
    // after its third client and reports nothing.
    const { server, open } = fakeServer();
    applyServerOptions(server, { maxConnections: 2 });

    const first = open();
    open();

    // Both halves, or this passes against no guard at all: with the cap full a
    // further connection must be refused, and after a close the next one must
    // not be.  Asserting only the second is true of a server that never
    // refuses anything.
    expect(open().destroyed, 'the cap was not holding before the close').toBe(true);
    first.close();
    expect(open().destroyed, 'a slot freed by a close was not reused').toBe(false);
  });

  test('an unset max-connections installs no cap at all', () => {
    // The negative control: the guard must not be armed by the other three
    // knobs, or a policy that only sets timeouts would start dropping traffic.
    const { server, open } = fakeServer();
    applyServerOptions(server, { idleTimeoutMs: 1_000, headerTimeoutMs: 2_000, requestTimeoutMs: 3_000 });

    for (let i = 0; i < 50; i++) expect(open().destroyed).toBe(false);
  });

  test('Infinity installs no cap, matching the property that is deliberately not written', () => {
    const { server, open } = fakeServer();
    applyServerOptions(server, { maxConnections: Infinity });

    expect(server.maxConnections).toBeUndefined();
    for (let i = 0; i < 50; i++) expect(open().destroyed).toBe(false);
  });

  test('a server that cannot report connections is left alone rather than half-guarded', () => {
    // `Bun.serve` / `Deno.serve` handles reach `applyServerOptions` as objects
    // with no `on`.  Writing the property and installing nothing is the honest
    // outcome; throwing would take down a bind that works today.
    const server: NodeHttpServerLike = {};
    expect(() => applyServerOptions(server, { maxConnections: 1 })).not.toThrow();
    expect(server.maxConnections).toBe(1);
  });
});

/**
 * The connection cap against a **real** `node:http` server, with the runtime's
 * own `maxConnections` deliberately left unset.
 *
 * This case exists to answer a question the three end-to-end cases above
 * cannot: they were red on GitHub's Linux runners and green on Windows and in
 * every local run, and a timeout tells you only that the second connection
 * lived — not whether the guard was installed, whether the connection event
 * ever reached it, or whether it hung up on a socket whose close the peer did
 * not observe.  Those are three different defects with three different fixes.
 *
 * So: no backend, no framework, no property for the runtime to honour.  If
 * this passes where those fail, the guard works and the gap is in what the
 * backend hands us; if it fails, the report in the message says which half.
 */
describe('the connection cap on a bare node:http server', () => {
  test('holds without the runtime property, and says what it saw if it does not', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_request, response) => { response.end('ok'); });
    // Unset on purpose: with it, a runtime that honours the property would
    // close the socket and this case would pass without exercising the guard.
    expect(server.maxConnections).toBeUndefined();

    const report = enforceMaxConnections(server as unknown as NodeHttpServerLike, 1);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const dial = (): Promise<Socket> => new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }, () => resolve(socket));
      socket.once('error', reject);
      sockets.push(socket);
    });

    try {
      await dial();
      const second = await dial();
      const closed = await closedWithin(second, 3_000);

      const seen = report();
      expect(
        closed,
        `the cap did not close the second connection — installed=${seen.installed} `
        + `seen=${seen.seen} refused=${seen.refused} held=${seen.held}. `
        + 'installed=false means the server exposed no `on`; seen=0 means the '
        + 'connection event never arrived; refused>0 with closed=false means the '
        + 'guard hung up and the peer did not observe it.',
      ).toBe(true);
      expect(seen.installed).toBe(true);
      expect(seen.seen).toBe(2);
      expect(seen.refused).toBe(1);
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });
});
