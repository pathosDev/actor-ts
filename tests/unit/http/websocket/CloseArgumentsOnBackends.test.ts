/**
 * A close the hub asks for reaches the peer on every backend `bun test` runs,
 * whatever code and reason it was given (#1431).
 *
 * A close frame carries a code from a fixed set and at most 123 bytes of
 * reason (RFC 6455 §5.5 and §7.4).  What a transport does when asked for more
 * depends on the transport, and under `bun test` on the Bun release too.  Bun
 * answers `import 'ws'` with a module of its own, so Fastify, Express and
 * Hono's Node runner never get the `ws` package here:
 *
 *   - on **1.4.2**, the release `.bun-version` pins, that module hands the
 *     close to Bun's native socket, which never throws.  It replaces 1005 and
 *     1006 with an empty close frame, so the peer reads 1005; the peer never
 *     reads other codes as they were sent; and a long reason is cut at byte
 *     123, through the middle of a multi-byte character, which a peer that
 *     checks UTF-8 answers with 1007;
 *   - on **1.4.4** it is a port of the package's own `close()`, which throws
 *     after it has moved the socket to CLOSING: no close frame goes out, the
 *     peer stays connected and keeps its slot, and the hub has already heard
 *     it leave — the defect itself.
 *
 * Hono on Bun closes through `Bun.serve`'s socket on both: 1005 for 1006 as
 * above, and a long reason cut at byte 123 on 1.4.2, between two characters
 * on 1.4.4.  Measured without the fix, and before Hono's aborts hard-closed,
 * twelve of the sixteen cases fail on 1.4.2 and ten on 1.4.4: Fastify's and
 * Express's aborts hard-close and pass on both, and Hono on Bun's two
 * long-reason cases pass on 1.4.4.
 *
 * So the cases here pin the close as the peer reads it, and that it happens: a
 * code a close frame cannot carry goes out as the method's own default — 1008
 * for `abort()`, 1000 for `close()` — and the reason is cut between two
 * characters.  `abort()` still hard-closes where the backend can, so on
 * Fastify, Express and Hono the peer sees the connection drop (1006) whatever
 * it was given: Hono's adapter hands on the runtime socket's own
 * `terminate()`, which Bun's and Node's have (13309751d).  Only Hono under
 * Deno, whose socket has none, falls back to a close frame for an abort, and
 * the smoke case covers that.  `ConnectionCloseAndAbort.test.ts` reproduces
 * the `ws` package's and Deno's `close()` independently of the Bun release,
 * and the smoke case `52-websocket-close-arguments.mjs` drives the real ones
 * on Node and Deno.
 *
 * Each case then connects a second client to the same route, capped at one
 * connection: it is admitted only once the first socket has closed and given
 * its slot back.
 *
 * Hono's Node runner is reached through the runtime seam, the way
 * `HeaderSizeParity.test.ts` reaches `NodeHonoRunner`: the backend picks
 * `Bun.serve` under `bun test`, and the socket the Node runner hands the
 * adapter — `@hono/node-ws`'s, whose `terminate()` the adapter passes on — is
 * the path the abort takes on Node.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { HttpExtensionId } from '../../../../src/http/HttpExtension.js';
import { ExpressBackend } from '../../../../src/http/backend/ExpressBackend.js';
import { FastifyBackend } from '../../../../src/http/backend/FastifyBackend.js';
import { HonoBackend } from '../../../../src/http/backend/HonoBackend.js';
import type { HttpServerBackend, ServerBinding } from '../../../../src/http/backend/HttpServerBackend.js';
import { websocket } from '../../../../src/http/websocket/WebsocketRoute.js';
import { WebsocketRouteOptions } from '../../../../src/http/websocket/WebsocketRouteOptions.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import { setRuntimeOverride } from '../../../../src/runtime/Detect.js';
import { resetHonoRunnerCache } from '../../../../src/runtime/http/index.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type AbortMessage = { readonly kind: 'abort'; readonly code: number; readonly reason: string };
type CloseMessage = { readonly kind: 'close'; readonly code: number; readonly reason: string };
type PingMessage = { readonly kind: 'ping'; readonly n: number };
type ClientMessage = AbortMessage | CloseMessage | PingMessage;

type PongMessage = { readonly kind: 'pong'; readonly n: number };
type ServerMessage = PongMessage;

/** Closes the sending connection the way the message asks, and answers pings. */
class ClosingHub extends WebsocketServerActor<ServerMessage, ClientMessage> {
  onMessage(message: ClientMessage): void {
    match(message)
      .with({ kind: 'abort' }, (m) => this.onAbort(m))
      .with({ kind: 'close' }, (m) => this.onClose(m))
      .with({ kind: 'ping' }, (m) => this.onPing(m))
      .exhaustive();
  }

  private onAbort(message: AbortMessage): void {
    this.connection.abort(message.code, message.reason);
  }

  private onClose(message: CloseMessage): void {
    this.connection.close(message.code, message.reason);
  }

  private onPing(message: PingMessage): void {
    this.reply({ kind: 'pong', n: message.n });
  }
}

/** 100 two-byte characters: 200 bytes, so byte 123 falls inside one of them. */
const LONG_REASON = 'é'.repeat(100);
/** The longest prefix of {@link LONG_REASON} that fits: 61 characters, 122 bytes. */
const LONG_REASON_AS_SENT = 'é'.repeat(61);

/**
 * The second client's whole budget, and the first client's wait for its close.
 * A close on a loopback socket lands in milliseconds; the budget is for a
 * loaded machine, and stays under bun's 5 s per-test cap together.
 */
const CLIENT_BUDGET_MS = 2_000;

const systems: ActorSystem[] = [];
const bindings: ServerBinding[] = [];
const clients: WebSocket[] = [];

/**
 * `@hono/node-server` replaces `globalThis.Request` and `Response` the first
 * time `serve()` runs, and the override outlives the case — a later
 * `Bun.serve` then refuses the Hono backend's return value.  Captured before
 * any runner runs and put back after each case.
 */
const nativeGlobals = { Request: globalThis.Request, Response: globalThis.Response };
function restoreNativeGlobals(): void {
  Object.defineProperty(globalThis, 'Request', { value: nativeGlobals.Request, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Response', { value: nativeGlobals.Response, configurable: true, writable: true });
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try { client.close(); } catch { /* already closed */ }
  }
  while (bindings.length > 0) {
    try { await bindings.shift()!.unbind(); } catch { /* already unbound */ }
  }
  await Promise.all(systems.splice(0).map((system) => system.terminate().catch(() => {})));
  setRuntimeOverride(null);
  resetHonoRunnerCache();
  restoreNativeGlobals();
});

async function bindClosingHub(name: string, backend: HttpServerBackend): Promise<string> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  const hub = system.spawn(ClosingHub, 'hub');
  const routeOptions = WebsocketRouteOptions.create().withMaxConnections(1);
  const binding = await system
    .extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(backend)
    .bind(websocket('/ws', hub, routeOptions));
  bindings.push(binding);
  return `ws://127.0.0.1:${binding.port}/ws`;
}

async function openClient(url: string): Promise<WebSocket> {
  const client = new WebSocket(url);
  clients.push(client);
  let opened = false;
  client.addEventListener('open', () => { opened = true; });
  await awaitCondition(() => opened || client.readyState === WebSocket.CLOSED, {
    timeoutMs: CLIENT_BUDGET_MS,
    label: 'the client finished its handshake',
  });
  expect(client.readyState).toBe(WebSocket.OPEN);
  return client;
}

/** What the first client saw: the close event's code and reason. */
async function closeSeenAfter(url: string, request: AbortMessage | CloseMessage): Promise<{ readonly code: number; readonly reason: string }> {
  const client = await openClient(url);
  let seen: { readonly code: number; readonly reason: string } | null = null;
  client.addEventListener('close', (event) => { seen = { code: event.code, reason: event.reason }; });
  client.send(JSON.stringify(request));
  await awaitCondition(() => seen !== null, {
    timeoutMs: CLIENT_BUDGET_MS,
    label: `the client saw the server's close after ${request.kind}(${request.code})`,
  });
  return seen!;
}

/** The route is capped at one connection, so this one gets in only once the first has gone. */
async function expectSlotBack(url: string): Promise<void> {
  const client = await openClient(url);
  let answered = false;
  client.addEventListener('message', (event) => {
    if (JSON.parse(String(event.data)).n === 2) answered = true;
  });
  client.send(JSON.stringify({ kind: 'ping', n: 2 } satisfies PingMessage));
  await awaitCondition(() => answered, {
    timeoutMs: CLIENT_BUDGET_MS,
    label: 'the second client was admitted and answered',
  });
}

type BackendCase = {
  readonly name: string;
  readonly backend: () => HttpServerBackend;
  /** Whether `abort()` hard-closes there, so the peer sees the drop and no close frame. */
  readonly terminates: boolean;
  /** Runs before the backend binds — the runtime seam, for Hono on Node. */
  readonly arrange?: () => void;
};

const backends: readonly BackendCase[] = [
  { name: 'Fastify', backend: () => new FastifyBackend(), terminates: true },
  { name: 'Express', backend: () => new ExpressBackend(), terminates: true },
  { name: 'Hono on Bun', backend: () => new HonoBackend(), terminates: true },
  {
    name: 'Hono on Node',
    backend: () => new HonoBackend(),
    terminates: true,
    arrange: () => {
      setRuntimeOverride('node');
      resetHonoRunnerCache();
    },
  },
];

for (const backendCase of backends) {
  describe(`${backendCase.name}: a close that asks for more than a close frame carries still closes the socket (#1431)`, () => {
    const bind = (name: string): Promise<string> => {
      backendCase.arrange?.();
      return bindClosingHub(name, backendCase.backend());
    };

    // A hard close sends no close frame: the peer reads 1006, and the reason
    // it reads is its own client's wording, not the server's.
    test('abort() with a reserved code', async () => {
      const url = await bind('ws-abort-reserved-code');
      const seen = await closeSeenAfter(url, { kind: 'abort', code: 1006, reason: 'rate limited' });
      if (backendCase.terminates) expect(seen.code).toBe(1006);
      else expect(seen).toEqual({ code: 1008, reason: 'rate limited' });
      await expectSlotBack(url);
    });

    test('abort() with a reason over 123 bytes', async () => {
      const url = await bind('ws-abort-long-reason');
      const seen = await closeSeenAfter(url, { kind: 'abort', code: 1008, reason: LONG_REASON });
      if (backendCase.terminates) expect(seen.code).toBe(1006);
      else expect(seen).toEqual({ code: 1008, reason: LONG_REASON_AS_SENT });
      await expectSlotBack(url);
    });

    test('close() with a reserved code', async () => {
      const url = await bind('ws-close-reserved-code');
      const seen = await closeSeenAfter(url, { kind: 'close', code: 1006, reason: 'bye' });
      expect(seen).toEqual({ code: 1000, reason: 'bye' });
      await expectSlotBack(url);
    });

    test('close() with a reason over 123 bytes', async () => {
      const url = await bind('ws-close-long-reason');
      const seen = await closeSeenAfter(url, { kind: 'close', code: 4000, reason: LONG_REASON });
      expect(seen).toEqual({ code: 4000, reason: LONG_REASON_AS_SENT });
      await expectSlotBack(url);
    });
  });
}
