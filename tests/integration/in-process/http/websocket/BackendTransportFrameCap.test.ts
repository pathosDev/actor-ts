/**
 * #373 — what the `ws`-backed backends actually hand their transport, and
 * which layer refuses an oversize frame once they have.
 *
 * Every other test of this change binds `new HonoBackend()`
 * (`tests/unit/http/websocket/TransportFrameCap.test.ts:74`,
 * `tests/smoke/cases/25-websocket-route-frame-cap.mjs:68`), and the two
 * backends #373 names are covered only end-to-end, by the shared suite's
 * raised-cap case.  That case cannot discriminate here: the unit + in-process
 * suite runs under Bun alone (`package.json`: `test = bun test`), and on Bun
 * the `ws` specifier resolves to a built-in shim that ignores `maxPayload`
 * entirely — so on Express and Fastify it passes whether or not the fix is
 * present.  Nothing asserted the argument either backend passes `ws`.
 *
 * These tests assert that argument directly, which is the strongest claim that
 * *can* be made on Bun, and then pin the consequence of the shim so the
 * limitation the docs promise is checked rather than merely written down:
 *
 *   - `describe('… installs …')` — the number reaches the `ws` server, is the
 *     route's own rather than the framework default, and reconciles several
 *     routes by the widest.  Reverting either backend to the constant turns
 *     all six red.
 *   - `describe('… which layer refuses …')` — on Bun the cap is installed and
 *     not honoured, so the *connection actor* is what refuses the frame.  The
 *     framework guarantee still holds and is asserted positively: the
 *     application never sees the payload.  This is a canary on the peer, not
 *     an endorsement — the day Bun's shim enforces `maxPayload`, the
 *     `initiatedBy` assertion goes red, and that red is the signal to lift the
 *     caveat in `docs/…/http/websocket.mdx` and its DE twin.
 *
 * Reading the option back is deliberately *not* the whole check.  Bun's shim
 * stores `maxPayload` and reports it unchanged, which is why
 * `tests/unit/runtime/HonoRunnerFrameCap.test.ts:93` — a readback assertion —
 * cannot see this defect either.  The readback proves the framework's half
 * (the right number is handed over); the refusal test names who honours it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { DEFAULT_WEBSOCKET_MAX_FRAME_BYTES } from '../../../../../src/http/Constants.js';
import { HttpExtensionId } from '../../../../../src/http/HttpExtension.js';
import { ExpressBackend } from '../../../../../src/http/backend/ExpressBackend.js';
import { FastifyBackend } from '../../../../../src/http/backend/FastifyBackend.js';
import type { HttpServerBackend, ServerBinding } from '../../../../../src/http/backend/HttpServerBackend.js';
import { concat, type Route } from '../../../../../src/http/Route.js';
import { detectRuntime } from '../../../../../src/runtime/Detect.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';
import type { WebsocketConnection } from '../../../../../src/http/websocket/WebsocketConnection.js';
import type { WebsocketCloseInfo } from '../../../../../src/http/websocket/Types.js';
import { websocket } from '../../../../../src/http/websocket/WebsocketRoute.js';
import { WebsocketRouteOptions } from '../../../../../src/http/websocket/WebsocketRouteOptions.js';
import { WebsocketServerActor } from '../../../../../src/http/websocket/WebsocketServerActor.js';

type EchoMessage = { kind: 'echo'; text: string };
type EchoedMessage = { kind: 'echoed'; length: number };

/**
 * Records every payload it was handed and every disconnect it was told about.
 * Both halves matter: `accepted` is how "the application never saw the frame"
 * is asserted positively, and `closes` carries the `initiatedBy` that names
 * the refusing layer.
 */
class RecordingEchoServer extends WebsocketServerActor<EchoedMessage, EchoMessage> {
  constructor(
    private readonly accepted: number[],
    private readonly closes: WebsocketCloseInfo[],
  ) {
    super();
  }

  onMessage(message: EchoMessage): void {
    this.accepted.push(message.text.length);
    this.reply({ kind: 'echoed', length: message.text.length });
  }

  override onClientDisconnected(_client: WebsocketConnection<EchoedMessage>, info: WebsocketCloseInfo): void {
    this.closes.push(info);
  }
}

/** Route cap deliberately above the framework default. */
const WIDE_ROUTE_FRAME_CAP_BYTES = 8 * 1024 * 1024;
/** Route cap deliberately below it. */
const NARROW_ROUTE_FRAME_CAP_BYTES = 64 * 1024;
/** A third value, between the two, for the reconciliation cases. */
const MIDDLE_ROUTE_FRAME_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Just enough of `ws`'s `WebSocketServer` to read the payload limit back.
 * Both the npm package and Bun's shim expose the option bag under this name.
 */
type WebsocketServerView = { readonly options?: { readonly maxPayload?: number } };

/** `ExpressBackend` keeps its one `noServer` server on a private field. */
type ExpressBackendView = { readonly wss: WebsocketServerView | null };

/** `@fastify/websocket` 11.x decorates the instance with `websocketServer`. */
type FastifyBackendView = { readonly app: { readonly websocketServer?: WebsocketServerView } };

const systems: ActorSystem[] = [];
const bindings: ServerBinding[] = [];

afterEach(async () => {
  while (bindings.length) {
    try { await bindings.shift()!.unbind(); } catch { /* ignore */ }
  }
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

type BindRequest = {
  readonly name: string;
  readonly backend: HttpServerBackend;
  readonly makeRoutes: (server: ReturnType<ActorSystem['spawn']>) => Route;
  /** Payload lengths the server actor was handed, in arrival order. */
  readonly accepted?: number[];
  /** Close info for every disconnect the server actor was told about. */
  readonly closes?: WebsocketCloseInfo[];
  /**
   * Feeds only the HOCON layer, so a route option still outranks it — which is
   * what makes the server-wide precedence case distinguishable at all.
   */
  readonly configuredMaxFrameBytes?: number;
};

/** Bind the request's routes on its backend and return the bound port. */
async function bind(request: BindRequest): Promise<number> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (request.configuredMaxFrameBytes !== undefined) {
    systemOptions.withConfig({
      'actor-ts': { http: { websocket: { maxFrameBytes: request.configuredMaxFrameBytes } } },
    });
  }
  const system = ActorSystem.create(request.name, systemOptions);
  systems.push(system);
  const accepted = request.accepted ?? [];
  const closes = request.closes ?? [];
  const server = system.spawn(() => new RecordingEchoServer(accepted, closes), 'echo-server');
  const binding = await system
    .extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(request.backend)
    .bind(request.makeRoutes(server));
  bindings.push(binding);
  return binding.port;
}

/** The `maxPayload` the Express backend built its `WebSocketServer` with. */
function expressInstalledCap(backend: ExpressBackend): number | undefined {
  return (backend as unknown as ExpressBackendView).wss?.options?.maxPayload;
}

/** The `maxPayload` the `@fastify/websocket` plugin was registered with. */
function fastifyInstalledCap(backend: FastifyBackend): number | undefined {
  return (backend as unknown as FastifyBackendView).app.websocketServer?.options?.maxPayload;
}

function routeWithCap(server: ReturnType<ActorSystem['spawn']>, pattern: string, maxFrameBytes: number): Route {
  const routeOptions = WebsocketRouteOptions.create().withMaxFrameBytes(maxFrameBytes);
  return websocket(pattern, server, routeOptions);
}

function openSocket(url: string, timeoutMs = 5000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('timeout opening ws')), timeoutMs);
    socket.onopen = () => {
      clearTimeout(timer);
      socket.onopen = null;
      socket.onerror = null;
      resolve(socket);
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('ws errored before open')); };
    socket.onclose = (e) => { clearTimeout(timer); reject(new Error(`ws closed before open (code ${e.code})`)); };
  });
}

type MessageOutcome = { readonly kind: 'message' };
type CloseOutcome = { readonly kind: 'close'; readonly code: number };
type SendOutcome = MessageOutcome | CloseOutcome;

/** Whichever comes first after the send: a server reply, or the socket closing. */
function replyOrClose(socket: WebSocket, timeoutMs = 5000): Promise<SendOutcome> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for reply or close')), timeoutMs);
    socket.addEventListener('message', () => { clearTimeout(timer); resolve({ kind: 'message' }); }, { once: true });
    socket.addEventListener(
      'close',
      (e: CloseEvent) => { clearTimeout(timer); resolve({ kind: 'close', code: e.code }); },
      { once: true },
    );
  });
}

describe('Express backend — the transport frame cap it installs (#373)', () => {
  test("the ws server is built with the route's own cap, not the framework default", async () => {
    const backend = new ExpressBackend();
    await bind({
      name: 'ws-cap-express-route',
      backend,
      makeRoutes: (s) => routeWithCap(s, '/ws', WIDE_ROUTE_FRAME_CAP_BYTES),
    });

    expect(expressInstalledCap(backend)).toBe(WIDE_ROUTE_FRAME_CAP_BYTES);
    // Named separately from the equality above: this is the assertion that
    // fails if the backend goes back to passing the constant, and it says so.
    expect(expressInstalledCap(backend)).not.toBe(DEFAULT_WEBSOCKET_MAX_FRAME_BYTES);
  });

  test('a route that lowers the cap narrows the installed window below the default', async () => {
    const backend = new ExpressBackend();
    await bind({
      name: 'ws-cap-express-narrow',
      backend,
      makeRoutes: (s) => routeWithCap(s, '/ws', NARROW_ROUTE_FRAME_CAP_BYTES),
    });

    expect(expressInstalledCap(backend)).toBe(NARROW_ROUTE_FRAME_CAP_BYTES);
    expect(expressInstalledCap(backend)!).toBeLessThan(DEFAULT_WEBSOCKET_MAX_FRAME_BYTES);
  });

  test('two routes on one app reconcile to the widest of them', async () => {
    // One `WebSocketServer` serves the whole Express app, so the two routes
    // have to agree on one number; `transportFrameCapOf` picks the widest.
    const backend = new ExpressBackend();
    await bind({
      name: 'ws-cap-express-two',
      backend,
      makeRoutes: (s) => concat(
        routeWithCap(s, '/narrow', NARROW_ROUTE_FRAME_CAP_BYTES),
        routeWithCap(s, '/middle', MIDDLE_ROUTE_FRAME_CAP_BYTES),
      ),
    });

    expect(expressInstalledCap(backend)).toBe(MIDDLE_ROUTE_FRAME_CAP_BYTES);
  });

  test('a HOCON-lowered cap reaches the ws server with no route option at all', async () => {
    const backend = new ExpressBackend();
    await bind({
      name: 'ws-cap-express-hocon',
      backend,
      makeRoutes: (s) => websocket('/ws', s),
      configuredMaxFrameBytes: NARROW_ROUTE_FRAME_CAP_BYTES,
    });

    expect(expressInstalledCap(backend)).toBe(NARROW_ROUTE_FRAME_CAP_BYTES);
  });
});

describe('Fastify backend — the transport frame cap it installs (#373)', () => {
  test("the plugin's ws server is built with the route's own cap, not the framework default", async () => {
    const backend = new FastifyBackend({ logger: false });
    await bind({
      name: 'ws-cap-fastify-route',
      backend,
      makeRoutes: (s) => routeWithCap(s, '/ws', WIDE_ROUTE_FRAME_CAP_BYTES),
    });

    expect(fastifyInstalledCap(backend)).toBe(WIDE_ROUTE_FRAME_CAP_BYTES);
    expect(fastifyInstalledCap(backend)).not.toBe(DEFAULT_WEBSOCKET_MAX_FRAME_BYTES);
  });

  test('two routes on one instance reconcile to the widest of them', async () => {
    // `@fastify/websocket` is registered once for the whole instance, so the
    // single number is a hard constraint here rather than an implementation
    // choice — see the note on `transportFrameCapOf`.
    const backend = new FastifyBackend({ logger: false });
    await bind({
      name: 'ws-cap-fastify-two',
      backend,
      makeRoutes: (s) => concat(
        routeWithCap(s, '/narrow', NARROW_ROUTE_FRAME_CAP_BYTES),
        routeWithCap(s, '/middle', MIDDLE_ROUTE_FRAME_CAP_BYTES),
      ),
    });

    expect(fastifyInstalledCap(backend)).toBe(MIDDLE_ROUTE_FRAME_CAP_BYTES);
  });

  test('a HOCON-lowered cap reaches the ws server with no route option at all', async () => {
    const backend = new FastifyBackend({ logger: false });
    await bind({
      name: 'ws-cap-fastify-hocon',
      backend,
      makeRoutes: (s) => websocket('/ws', s),
      configuredMaxFrameBytes: NARROW_ROUTE_FRAME_CAP_BYTES,
    });

    expect(fastifyInstalledCap(backend)).toBe(NARROW_ROUTE_FRAME_CAP_BYTES);
  });
});

describe('Express backend — which layer refuses the oversize frame (#373)', () => {
  test('the frame never reaches the application, and on Bun the actor is what refused it', async () => {
    const accepted: number[] = [];
    const closes: WebsocketCloseInfo[] = [];
    const backend = new ExpressBackend();
    const port = await bind({
      name: 'ws-cap-express-refusal',
      backend,
      makeRoutes: (s) => routeWithCap(s, '/ws', NARROW_ROUTE_FRAME_CAP_BYTES),
      accepted,
      closes,
    });
    // Precondition, not the claim: the 64 KiB the route asked for really is
    // the number the transport was given, so an unenforced refusal below can
    // only mean the transport ignored it.
    expect(expressInstalledCap(backend)).toBe(NARROW_ROUTE_FRAME_CAP_BYTES);

    const socket = await openSocket(`ws://127.0.0.1:${port}/ws`);
    const outcome = replyOrClose(socket);
    // Comfortably over the route's cap and comfortably under the 100 MiB `ws`
    // default, so on a runtime that honours `maxPayload` the transport refuses
    // it and on one that does not the frame arrives whole.
    socket.send(JSON.stringify({ kind: 'echo', text: 'x'.repeat(256 * 1024) }));
    const settled = await outcome;

    // The guarantee the docs promise for this pair, asserted positively: the
    // application never sees the payload, whichever layer said no.
    expect(settled.kind).toBe('close');
    expect(accepted).toEqual([]);
    // The client's close event beats the hub's mailbox — the disconnect signal
    // is still in flight when the socket is already gone on this side.
    await awaitCondition(
      () => closes.length === 1,
      { timeoutMs: 4_000, intervalMs: 10, label: 'the server actor was told about the disconnect' },
    );

    // And the part the caveat is about.  `initiatedBy: 'server'` means the
    // connection actor's own post-materialisation check closed the socket —
    // the frame was buffered in full first, which is exactly the allocation
    // the transport cap exists to avoid.  `'client'` means the transport
    // refused it and the close came back off the wire.
    //
    // Measured on this tree: Bun 1.3.1's built-in `ws` shim reads
    // `maxPayload` back unchanged and enforces nothing, so Bun lands on
    // `'server'`; Node with `ws` 8.20.0 refuses in `ws/lib/receiver.js` with
    // `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` and lands on `'client'`.  Pinning
    // it per runtime rather than accepting either keeps this a canary: when
    // Bun starts enforcing, this line goes red, and that red is the signal to
    // lift the caveat in `docs/…/http/websocket.mdx` and its DE twin.
    const refusedByTransport = detectRuntime() !== 'bun';
    expect(closes[0]!.initiatedBy).toBe(refusedByTransport ? 'client' : 'server');
    if (!refusedByTransport) expect(closes[0]!.code).toBe(1009);
  });

  test('a frame under the route cap still reaches the application', async () => {
    // Guards the over-correction: a transport or an actor that refused
    // everything would pass the refusal test above.
    const accepted: number[] = [];
    const backend = new ExpressBackend();
    const port = await bind({
      name: 'ws-cap-express-accepts',
      backend,
      makeRoutes: (s) => routeWithCap(s, '/ws', NARROW_ROUTE_FRAME_CAP_BYTES),
      accepted,
    });

    const socket = await openSocket(`ws://127.0.0.1:${port}/ws`);
    const outcome = replyOrClose(socket);
    socket.send(JSON.stringify({ kind: 'echo', text: 'y'.repeat(1024) }));

    expect(await outcome).toEqual({ kind: 'message' });
    expect(accepted).toEqual([1024]);
    socket.close();
  });
});
