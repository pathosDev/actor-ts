/**
 * Typed WebSocket client + server in one process (#1).  The server echoes
 * each tick back as an ack; the client sends ticks and prints the acks.
 *
 *   bun run examples/io/websocket-feed.ts
 *
 * Shows both halves of the typed API: a `WebsocketServerActor` bound with
 * `websocket('/ws', ref)`, and a `WebsocketClientActor` that dials it and
 * inherits reconnect-with-backoff + outbound buffering from BrokerActor.
 */
import {
  ActorSystem,
  HttpExtensionId,
  Props,
  WebsocketClientActor,
  WebsocketClientOptions,
  WebsocketServerActor,
  websocket,
  websocketSend,
} from '../../src/index.js';

type Up = { kind: 'tick'; n: number };   // client → server
type Down = { kind: 'ack'; n: number };  // server → client

class EchoServer extends WebsocketServerActor<Down, Up> {
  override onMessage(message: Up): void {
    this.reply({ kind: 'ack', n: message.n });
  }
}

class Feed extends WebsocketClientActor<Up, Down> {
  constructor(url: string) {
    const clientOptions = WebsocketClientOptions.create<Up, Down>().withUrl(url);
    super(clientOptions);
  }
  override onConnected(): void { console.log('[client] connected'); }
  override onMessage(message: Down): void { console.log('[client] ← ack', message.n); }
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
    client.tell(websocketSend({ kind: 'tick', n: i }));
    await sleep(150);
  }

  await sleep(400);
  await binding.unbind();
  await system.terminate();
}

void main();
