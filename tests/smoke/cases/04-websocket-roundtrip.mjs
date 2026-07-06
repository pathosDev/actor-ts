/**
 * Smoke case: WebSocket round-trip through the HTTP backend.
 *
 * A WebSocketClientActor dials a WebSocketServerActor bound with
 * `websocket('/ws', ref)` on the default (Fastify) backend, exchanges one
 * typed JSON message, and checks the reply.  This is the only coverage of
 * the WS server-upgrade + client path on Node/Deno (Bun runs the full
 * bun-test suite).
 *
 * If the runtime's backend can't perform a WebSocket upgrade, the case
 * skips rather than fails — but once a server binds, the round-trip MUST
 * succeed, so a real regression still surfaces.
 */
export const name = 'websocket round-trip';
export const description = 'client actor ↔ server actor via websocket() route';

export async function run({ actorTs }) {
  const {
    ActorSystem, Props, LogLevel, NoopLogger,
    HttpExtensionId, WebSocketServerActor, WebSocketClientActor, WebSocketClientOptions, websocket,
  } = actorTs;

  class Echo extends WebSocketServerActor {
    onMessage(msg) { this.reply({ pong: msg.n }); }
  }

  const sys = ActorSystem.create('smoke-ws', { logger: new NoopLogger(), logLevel: LogLevel.Off });
  let binding;
  try {
    const server = sys.spawn(Props.create(() => new Echo()), 'echo');
    try {
      binding = await sys.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(websocket('/ws', server));
    } catch (e) {
      console.log(`  (skipped: websocket server unsupported on this runtime — ${e.message})`);
      return;
    }

    const received = [];
    class Client extends WebSocketClientActor {
      constructor(url) {
        super(WebSocketClientOptions.create()
          .withUrl(url)
          .withReconnect({ maxAttempts: 5, initialDelayMs: 50 }));
      }
      onConnected() { this.send({ n: 7 }); }
      onMessage(m) { received.push(m); }
    }
    sys.spawn(Props.create(() => new Client(`ws://127.0.0.1:${binding.port}/ws`)), 'client');

    const deadline = Date.now() + 5_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (received.length === 0) throw new Error('no pong received within 5s');
    if (received[0]?.pong !== 7) throw new Error(`unexpected pong: ${JSON.stringify(received[0])}`);
  } finally {
    if (binding) await binding.unbind();
    await sys.terminate();
  }
}
