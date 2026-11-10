/**
 * The Hono backend's WebSocket adapter can hard-close a socket where the
 * runtime's own socket can.
 *
 * `terminate()` is how `WebsocketConnection.abort()` and the shutdown path
 * drop a connection without a close handshake; an adapter without it falls
 * back to `close()`, so on Hono an `abort()` sent a close frame, and a socket
 * whose `close()` throws could not be ended at all.  Hono hands each runtime's
 * own socket over as `WSContext.raw`: on Bun the `ServerWebSocket`, on Node
 * `@hono/node-ws`'s `ws` `WebSocket` — both have `terminate()` — and on Deno a
 * standard `WebSocket`, which has none.  Measured with a client on the other
 * end: under `raw.terminate()` it saw code 1006, not clean, on bun 1.4.2, bun
 * 1.4.4 and node v26.10.0; under `close(1000)` a clean 1000 everywhere.
 *
 * `bun test` reaches the Bun half; smoke case
 * `56-hono-websocket-terminate.mjs` runs the same exchange on Node and Deno.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { HonoBackend } from '../../../src/http/backend/HonoBackend.js';
import type { ServerBinding } from '../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { DEFAULT_PRE_ATTACH_BUFFER_LIMITS, type WebsocketSocketAdapter } from '../../../src/http/websocket/SocketAdapter.js';
import type { WebsocketConnection } from '../../../src/http/websocket/WebsocketConnection.js';
import type { WebsocketServerRef } from '../../../src/http/websocket/WebsocketMessages.js';
import { websocket } from '../../../src/http/websocket/WebsocketRoute.js';
import { WebsocketServerActor } from '../../../src/http/websocket/WebsocketServerActor.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

/** How long a client waits for its connection to end before the case reports that it did not. */
const ENDS_WITHIN_MS = 3_000;

const bindings: ServerBinding[] = [];
afterEach(async () => {
  for (const binding of bindings.splice(0)) await binding.unbind();
});

type Ending = { readonly code: number; readonly wasClean: boolean } | 'still open';

/**
 * Bind a Hono backend whose one WebSocket route hands each accepted socket's
 * adapter to `act`, connect a client, and resolve with how the client saw the
 * connection end.
 */
async function endingUnder(act: (adapter: WebsocketSocketAdapter) => void): Promise<{ readonly ending: Ending; readonly adapter: WebsocketSocketAdapter }> {
  let accepted: WebsocketSocketAdapter | undefined;
  const backend = new HonoBackend();
  backend.registerWebSocket({
    pattern: '/socket',
    maxFrameBytes: 1024,
    preAttachBuffer: DEFAULT_PRE_ATTACH_BUFFER_LIMITS,
    authorize: async () => null,
    onConnection: (_request, adapter) => {
      accepted = adapter;
      adapter.setListeners({ onMessage: () => {}, onClose: () => {}, onError: () => {} });
      act(adapter);
    },
  });
  const binding = await backend.listen('127.0.0.1', 0);
  bindings.push(binding);
  const ending = await new Promise<Ending>((resolve) => {
    const client = new WebSocket(`ws://127.0.0.1:${binding.port}/socket`);
    const timer = setTimeout(() => {
      client.close();
      resolve('still open');
    }, ENDS_WITHIN_MS);
    client.onclose = (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, wasClean: event.wasClean });
    };
  });
  if (accepted === undefined) throw new Error('the upgrade was never accepted');
  return { ending, adapter: accepted };
}

describe('the Hono WebSocket adapter terminates where the runtime\'s socket can', () => {
  test('on Bun the adapter has terminate(), and the client sees the connection drop without a close frame', async () => {
    const { ending, adapter } = await endingUnder((socket) => socket.terminate?.());

    expect(typeof adapter.terminate).toBe('function');
    expect(ending).toEqual({ code: 1006, wasClean: false });
  });

  test('close() still sends its code and reason in a close frame', async () => {
    const { ending } = await endingUnder((socket) => socket.close(4000, 'done'));

    expect(ending).toEqual({ code: 4000, wasClean: true });
  });

  test('terminate() after the socket has closed does not throw', async () => {
    const { adapter } = await endingUnder((socket) => socket.close(1000, 'done'));

    expect(() => adapter.terminate?.()).not.toThrow();
  });
});

class AbortingHub extends WebsocketServerActor<string, string> {
  onMessage(): void { /* nothing is sent */ }

  protected override onClientConnected(client: WebsocketConnection<string>): void {
    client.abort(4008, 'not served');
  }
}

describe('on Hono under Bun, WebsocketConnection.abort() drops the connection rather than closing it', () => {
  test('the client sees 1006 with no close frame, where it used to see the abort\'s code in one', async () => {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(Config.parseString('actor-ts.http.backend = hono'));
    const system = ActorSystem.create('hono-websocket-abort', systemOptions);
    try {
      const hub = system.spawn(AbortingHub, 'hub') as unknown as WebsocketServerRef<string, string, never>;
      const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(websocket('socket', hub));
      bindings.push(binding);

      const ending = await new Promise<Ending>((resolve) => {
        const client = new WebSocket(`ws://127.0.0.1:${binding.port}/socket`);
        const timer = setTimeout(() => {
          client.close();
          resolve('still open');
        }, ENDS_WITHIN_MS);
        client.onclose = (event) => {
          clearTimeout(timer);
          resolve({ code: event.code, wasClean: event.wasClean });
        };
      });

      expect(ending).toEqual({ code: 1006, wasClean: false });
    } finally {
      for (const binding of bindings.splice(0)) await binding.unbind();
      await system.terminate();
    }
  });
});
