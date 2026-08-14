/**
 * #586 — end-to-end proof that the Hono backend's frame cap is enforced by the
 * *transport*, not only by the connection actor.
 *
 * The discriminator matters: the shared backend suite's oversize case caps a
 * route at 64 KiB and sends 80 KiB, which is inside every runtime's own
 * buffering window, so it stays green whether or not a transport cap exists.
 * Here the route is opened *wider* than the transport cap on purpose, and the
 * frame sits between the two.  Only a runtime-level limit can reject it — the
 * application layer would happily accept it.
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

/** Route cap deliberately above the transport cap — see the file header. */
const ROUTE_FRAME_CAP_BYTES = 8 * 1024 * 1024;

const systems: ActorSystem[] = [];
const bindings: ServerBinding[] = [];

afterEach(async () => {
  while (bindings.length) {
    try { await bindings.shift()!.unbind(); } catch { /* ignore */ }
  }
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function bindEchoServer(accepted: number[]): Promise<string> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('ws-transport-frame-cap', systemOptions);
  systems.push(system);
  const server = system.spawn(() => new EchoServer(accepted), 'echo-server');
  const routeOptions = WebsocketRouteOptions.create().withMaxFrameBytes(ROUTE_FRAME_CAP_BYTES);
  const binding = await system
    .extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(new HonoBackend())
    .bind(websocket('/ws', server, routeOptions));
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

describe('Hono backend — transport-level WebSocket frame cap (#586)', () => {
  test('a frame over the transport cap is cut off even though the route allows it', async () => {
    const accepted: number[] = [];
    const url = await bindEchoServer(accepted);
    const socket = await wsOpen(url);

    // Comfortably over the 1 MiB transport cap, comfortably under the route's
    // 8 MiB — the byte range that only a runtime-level limit can refuse.
    const oversize = JSON.stringify({ kind: 'echo', text: 'x'.repeat(2 * 1024 * 1024) });
    expect(oversize.length).toBeGreaterThan(DEFAULT_WEBSOCKET_MAX_FRAME_BYTES);
    expect(oversize.length).toBeLessThan(ROUTE_FRAME_CAP_BYTES);
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

  test('a frame under the transport cap still reaches the actor', async () => {
    // Guards the obvious over-correction — a cap that closed everything would
    // pass the test above.
    const accepted: number[] = [];
    const url = await bindEchoServer(accepted);
    const socket = await wsOpen(url);

    const outcome = replyOrClose(socket);
    socket.send(JSON.stringify({ kind: 'echo', text: 'y'.repeat(1024) }));

    expect(await outcome).toEqual({ kind: 'message' });
    expect(accepted).toEqual([1024]);
    socket.close();
  });
});
