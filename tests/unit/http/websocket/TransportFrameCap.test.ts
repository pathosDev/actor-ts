/**
 * #586 / #373 — end-to-end proof that a WebSocket route's frame cap is
 * enforced by the *transport*, not only by the connection actor, and that the
 * number the transport enforces is the route's own.
 *
 * The discriminator matters: the shared backend suite's oversize case sends a
 * frame only slightly over the route's cap, which is inside every runtime's
 * own buffering window, so it stays green whether or not a transport cap
 * exists.  Here each route is deliberately set *away* from the framework
 * default and the frame sits between the two numbers, so only a transport
 * limit derived from the route can produce the expected outcome:
 *
 *   - a 64 KiB route refusing a 2 MiB frame proves the cap is installed at
 *     all, and installed *below* the 1 MiB default (#586 kept that frame
 *     inside the transport window, and it was the actor that refused it);
 *   - an 8 MiB route accepting a 2 MiB frame proves the cap is the route's
 *     and not the default (before #373 the transport cut this one off, and
 *     this test asserted that as correct).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { DEFAULT_WEBSOCKET_MAX_FRAME_BYTES } from '../../../../src/http/Constants.js';
import { HonoBackend } from '../../../../src/http/backend/HonoBackend.js';
import { HttpExtensionId } from '../../../../src/http/HttpExtension.js';
import type { ServerBinding } from '../../../../src/http/backend/HttpServerBackend.js';
import { websocket } from '../../../../src/http/websocket/WebsocketRoute.js';
import { WebsocketRouteOptions } from '../../../../src/http/websocket/WebsocketRouteOptions.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';

type EchoIn = { kind: 'echo'; text: string };
type EchoOut = { kind: 'echoed'; length: number };

/** Reports the payload length back, so an accepted oversize frame is visible. */
class EchoServer extends WebsocketServerActor<EchoOut, EchoIn> {
  constructor(private readonly accepted: number[]) {
    super();
  }
  onMessage(message: EchoIn): void {
    this.accepted.push(message.text.length);
    this.reply({ kind: 'echoed', length: message.text.length });
  }
}

/** Route cap deliberately above the framework default — see the file header. */
const WIDE_ROUTE_FRAME_CAP_BYTES = 8 * 1024 * 1024;
/** Route cap deliberately below it. */
const NARROW_ROUTE_FRAME_CAP_BYTES = 64 * 1024;
/** The frame both routes are probed with — between the two caps. */
const PROBE_FRAME_BYTES = 2 * 1024 * 1024;

const systems: ActorSystem[] = [];
const bindings: ServerBinding[] = [];

afterEach(async () => {
  while (bindings.length) {
    try { await bindings.shift()!.unbind(); } catch { /* ignore */ }
  }
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function bindEchoServer(accepted: number[], maxFrameBytes: number): Promise<string> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('ws-transport-frame-cap', systemOptions);
  systems.push(system);
  const server = system.spawn(() => new EchoServer(accepted), 'echo-server');
  const routeOptions = WebsocketRouteOptions.create().withMaxFrameBytes(maxFrameBytes);
  const binding = await system
    .extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(new HonoBackend())
    .bind(websocket('/ws', server, routeOptions));
  bindings.push(binding);
  return `ws://127.0.0.1:${binding.port}/ws`;
}

/** Same, but the cap comes only from HOCON — no route option at all. */
async function bindEchoServerConfiguredOnly(accepted: number[], maxFrameBytes: number): Promise<string> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig({ 'actor-ts': { http: { websocket: { maxFrameBytes } } } });
  const system = ActorSystem.create('ws-transport-frame-cap-hocon', systemOptions);
  systems.push(system);
  const server = system.spawn(() => new EchoServer(accepted), 'echo-server');
  const binding = await system
    .extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(new HonoBackend())
    .bind(websocket('/ws', server));
  bindings.push(binding);
  return `ws://127.0.0.1:${binding.port}/ws`;
}

function wsOpen(url: string, timeoutMs = 5000): Promise<WebSocket> {
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
  });
}

/** Whichever comes first after the send: a server reply, or the socket closing. */
function replyOrClose(socket: WebSocket, timeoutMs = 5000): Promise<{ kind: 'message' } | { kind: 'close'; code: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for reply or close')), timeoutMs);
    socket.addEventListener('message', () => { clearTimeout(timer); resolve({ kind: 'message' }); }, { once: true });
    socket.addEventListener('close', (e: CloseEvent) => { clearTimeout(timer); resolve({ kind: 'close', code: e.code }); }, { once: true });
  });
}

/** A JSON `echo` message whose serialised form is at least `bytes` long. */
function probeFrame(bytes: number): string {
  const frame = JSON.stringify({ kind: 'echo', text: 'x'.repeat(bytes) });
  expect(frame.length).toBeGreaterThanOrEqual(bytes);
  return frame;
}

describe('Hono backend — transport-level WebSocket frame cap (#586, #373)', () => {
  test('a frame above the route\'s own cap is cut off by the transport', async () => {
    const accepted: number[] = [];
    const url = await bindEchoServer(accepted, NARROW_ROUTE_FRAME_CAP_BYTES);
    const socket = await wsOpen(url);

    // Over the route's 64 KiB *and* over the framework's 1 MiB default, so a
    // transport still wired to the default would refuse it too — what
    // separates the two is the raised-cap test below.
    const oversize = probeFrame(PROBE_FRAME_BYTES);
    const pending = replyOrClose(socket);
    socket.send(oversize);
    const outcome = await pending;

    expect(outcome.kind).toBe('close');
    // Bun drops the connection outright when a frame exceeds
    // `maxPayloadLength`, so the client synthesises 1006 (abnormal) rather
    // than seeing the clean 1009 the application-level cap sends.  Both are
    // accepted here: what this pins is that the frame is refused, not which
    // layer got to write a close code.
    expect([1006, 1009]).toContain((outcome as { code: number }).code);
    // The frame never became the application's problem: nothing was decoded,
    // which is the whole difference between a transport cap and the
    // post-materialisation check that already existed.
    expect(accepted).toEqual([]);
  });

  test('a route that raises maxFrameBytes past the default really receives that frame', async () => {
    // The #373 case.  Before it, the transport was wired to the 1 MiB
    // framework default whatever the route said, so this frame — comfortably
    // over the default and comfortably under the route's cap — was cut off,
    // and a test in this very file asserted that as correct behaviour.
    const accepted: number[] = [];
    const url = await bindEchoServer(accepted, WIDE_ROUTE_FRAME_CAP_BYTES);
    const socket = await wsOpen(url);

    const oversize = probeFrame(PROBE_FRAME_BYTES);
    expect(oversize.length).toBeGreaterThan(DEFAULT_WEBSOCKET_MAX_FRAME_BYTES);
    expect(oversize.length).toBeLessThan(WIDE_ROUTE_FRAME_CAP_BYTES);
    const pending = replyOrClose(socket);
    socket.send(oversize);

    expect(await pending).toEqual({ kind: 'message' });
    expect(accepted).toEqual([PROBE_FRAME_BYTES]);
    socket.close();
  });

  test('a HOCON-lowered cap narrows the transport window too', async () => {
    // The direction the issue never mentioned and the cheaper half of the
    // fix: an operator who lowers the cap server-wide used to keep a 1 MiB
    // buffering window regardless, which is the allocation amplification the
    // cap exists to prevent.
    const accepted: number[] = [];
    const url = await bindEchoServerConfiguredOnly(accepted, NARROW_ROUTE_FRAME_CAP_BYTES);
    const socket = await wsOpen(url);

    // Under the framework default, over the configured cap — only a transport
    // that read the configuration can refuse this one before the actor does.
    const oversize = probeFrame(256 * 1024);
    expect(oversize.length).toBeLessThan(DEFAULT_WEBSOCKET_MAX_FRAME_BYTES);
    const pending = replyOrClose(socket);
    socket.send(oversize);
    const outcome = await pending;

    expect(outcome.kind).toBe('close');
    expect([1006, 1009]).toContain((outcome as { code: number }).code);
    expect(accepted).toEqual([]);
  });

  test('a frame under the transport cap still reaches the actor', async () => {
    // Guards the obvious over-correction — a cap that closed everything would
    // pass the refusal tests above.
    const accepted: number[] = [];
    const url = await bindEchoServer(accepted, NARROW_ROUTE_FRAME_CAP_BYTES);
    const socket = await wsOpen(url);

    const outcome = replyOrClose(socket);
    socket.send(JSON.stringify({ kind: 'echo', text: 'y'.repeat(1024) }));

    expect(await outcome).toEqual({ kind: 'message' });
    expect(accepted).toEqual([1024]);
    socket.close();
  });
});
