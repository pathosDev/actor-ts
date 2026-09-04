import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { ExpressBackend } from '../../../src/http/backend/ExpressBackend.js';
import { FastifyBackend } from '../../../src/http/backend/FastifyBackend.js';
import { HonoBackend } from '../../../src/http/backend/HonoBackend.js';
import {
  applyServerOptions,
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
