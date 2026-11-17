/**
 * Hono under Node: the pong of the runtime's socket reaches the connection's
 * heartbeat (#651).
 *
 * On Node, `@hono/node-ws` hands the adapter `ws`'s `WebSocket` as
 * `WSContext.raw`, which reports a pong as an event, not through a handler
 * Hono calls — so the backend subscribes to it in `onOpen`.  Without that
 * subscription the heartbeat pings, hears nothing back, and drops a healthy
 * peer on its second tick.  `bun test` runs Hono on `Bun.serve`, whose pongs
 * take the runner's `pong` handler instead, so this case reaches the Node
 * runner through the runtime seam, the way `CloseArgumentsOnBackends.test.ts`
 * does: the socket it hands the adapter is the one the pong subscription is
 * for.  Smoke case `62-websocket-server-heartbeat.mjs` drives the same path on
 * a real Node.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { HonoBackend } from '../../../../src/http/backend/HonoBackend.js';
import type { ServerBinding } from '../../../../src/http/backend/HttpServerBackend.js';
import { DEFAULT_PRE_ATTACH_BUFFER_LIMITS, type WebsocketSocketAdapter } from '../../../../src/http/websocket/SocketAdapter.js';
import { setRuntimeOverride } from '../../../../src/runtime/Detect.js';
import { resetHonoRunnerCache } from '../../../../src/runtime/http/index.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/**
 * `@hono/node-server` replaces `globalThis.Request` and `Response` the first
 * time `serve()` runs, and the override outlives the case; put back after it,
 * as `CloseArgumentsOnBackends.test.ts` does.
 */
const nativeGlobals = { Request: globalThis.Request, Response: globalThis.Response };
function restoreNativeGlobals(): void {
  Object.defineProperty(globalThis, 'Request', { value: nativeGlobals.Request, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Response', { value: nativeGlobals.Response, configurable: true, writable: true });
}

const bindings: ServerBinding[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try { client.close(); } catch { /* already closed */ }
  }
  for (const binding of bindings.splice(0)) {
    try { await binding.unbind(); } catch { /* already unbound */ }
  }
  setRuntimeOverride(null);
  resetHonoRunnerCache();
  restoreNativeGlobals();
});

describe('Hono under Node: the runtime socket\'s pong reaches the heartbeat (#651)', () => {
  test('a ping through the adapter comes back as the listener\'s onPong', async () => {
    setRuntimeOverride('node');
    resetHonoRunnerCache();

    let accepted: WebsocketSocketAdapter | undefined;
    let pongs = 0;
    const backend = new HonoBackend();
    backend.registerWebSocket({
      pattern: '/socket',
      maxFrameBytes: 1024,
      preAttachBuffer: DEFAULT_PRE_ATTACH_BUFFER_LIMITS,
      authorize: async () => null,
      onConnection: (_request, adapter) => {
        adapter.setListeners({
          onMessage: () => {},
          onClose: () => {},
          onError: () => {},
          onPong: () => { pongs += 1; },
        });
        accepted = adapter;
      },
    });
    const binding = await backend.listen('127.0.0.1', 0);
    bindings.push(binding);

    const client = new WebSocket(`ws://127.0.0.1:${binding.port}/socket`);
    clients.push(client);
    await awaitCondition(() => accepted !== undefined && client.readyState === WebSocket.OPEN, { timeoutMs: 3_000 });

    // The runtime's socket can ping: the heartbeat is on for this transport.
    expect(typeof accepted!.ping).toBe('function');
    accepted!.ping!();
    await awaitCondition(() => pongs >= 1, { timeoutMs: 3_000 });
    accepted!.ping!();
    await awaitCondition(() => pongs >= 2, { timeoutMs: 3_000 });
    expect(pongs).toBe(2);
  });
});
