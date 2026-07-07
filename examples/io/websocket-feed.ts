/**
 * Typed WebSocket client + server in one process (#1).  The server echoes
 * each tick back as an ack; the client sends ticks and prints the acks.
 *
 *   bun run examples/io/websocket-feed.ts
 *
 * Shows both halves of the typed API: a `WebSocketServerActor` bound with
 * `websocket('/ws', ref)`, and a `WebSocketClientActor` that dials it and
 * inherits reconnect-with-backoff + outbound buffering from BrokerActor.
 */
import {
  ActorSystem,
  HttpExtensionId,
  Props,
  WebSocketClientActor,
  WebSocketClientOptions,
  WebSocketServerActor,
  websocket,
  wsSend,
} from '../../src/index.js';

type Up = { kind: 'tick'; n: number };   // client → server
type Down = { kind: 'ack'; n: number };  // server → client

class EchoServer extends WebSocketServerActor<Down, Up> {
  override onMessage(msg: Up): void {
    this.reply({ kind: 'ack', n: msg.n });
  }
}

class Feed extends WebSocketClientActor<Up, Down> {
  constructor(url: string) {
    const clientOptions = WebSocketClientOptions.create<Up, Down>()
      .withUrl(url);
    super(clientOptions);
  }
  override onConnected(): void { console.log('[client] connected'); }
  override onMessage(msg: Down): void { console.log('[client] ← ack', msg.n); }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const system = ActorSystem.create('ws-feed-demo');

  const server = system.spawn(Props.create(() => new EchoServer()), 'echo');
  const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(websocket('/ws', server));
  console.log(`[server] listening on ws://127.0.0.1:${binding.port}/ws`);

  const client = system.spawn(Props.create(() => new Feed(`ws://127.0.0.1:${binding.port}/ws`)), 'feed');

  await sleep(200);
  for (let i = 0; i < 5; i++) {
    client.tell(wsSend({ kind: 'tick', n: i }));
    await sleep(150);
  }

  await sleep(400);
  await binding.unbind();
  await system.terminate();
}

void main();
