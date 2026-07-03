/**
 * Server-side WebSocket demo using the routing DSL (#1).
 *
 *   bun run examples/io/websocket-server.ts
 *   # then open the dev-tools console and:
 *   #   const ws = new WebSocket('ws://localhost:3000/ws');
 *   #   ws.onmessage = (e) => console.log(e.data);
 *   #   ws.send(JSON.stringify({ kind: 'setName', name: 'alice' }));
 *   #   ws.send(JSON.stringify({ kind: 'say', text: 'hello!' }));
 *
 * The whole server is one actor bound to a route with `websocket('/ws', ref)`.
 * The framework spawns an internal session actor per connection; the hub
 * sees typed, JSON-decoded messages and replies to the sending connection
 * with `this.reply(...)` or fans out with `this.broadcast(...)`.
 */
import { match } from 'ts-pattern';
import {
  ActorSystem,
  completeText,
  concat,
  get,
  HttpExtensionId,
  Props,
  Status,
  WebSocketServerActor,
  websocket,
  type WsConnection,
} from '../../src/index.js';

type ClientMsg =
  | { kind: 'setName'; name: string }
  | { kind: 'say'; text: string };

type ServerMsg =
  | { kind: 'system'; text: string }
  | { kind: 'chat'; from: string; text: string };

class ChatRoom extends WebSocketServerActor<ServerMsg, ClientMsg> {
  private readonly names = new Map<string, string>();

  override onMessage(msg: ClientMsg): void {
    match(msg)
      .with({ kind: 'setName' }, ({ name }) => {
        this.names.set(this.connection.id, name);
        this.reply({ kind: 'system', text: `you are now "${name}"` });
        this.broadcast(
          { kind: 'system', text: `${name} joined` },
          (c) => c.id !== this.connection.id,
        );
      })
      .with({ kind: 'say' }, ({ text }) => {
        const from = this.names.get(this.connection.id) ?? 'anon';
        this.broadcast({ kind: 'chat', from, text });
      })
      .exhaustive();
  }

  protected override onClientConnected(c: WsConnection<ServerMsg>): void {
    c.tell({ kind: 'system', text: `welcome — ${this.clients.size} online` });
  }

  protected override onClientDisconnected(c: WsConnection<ServerMsg>): void {
    const name = this.names.get(c.id) ?? 'someone';
    this.names.delete(c.id);
    this.broadcast({ kind: 'system', text: `${name} left` });
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('ws-server-demo');
  const chat = system.spawn(Props.create(() => new ChatRoom()), 'chat');

  const routes = concat(
    websocket('/ws', chat),
    get(() => completeText(Status.OK, 'actor-ts websocket demo — connect to ws://localhost:3000/ws')),
  );

  const binding = await system.extension(HttpExtensionId).newServerAt('0.0.0.0', 3000).bind(routes);
  console.log(`websocket demo: http://${binding.host}:${binding.port}/  (ws path: /ws)`);
  console.log('press Ctrl+C to exit');

  await new Promise<void>((resolve) => process.on('SIGINT', () => resolve()));
  await binding.unbind();
  await system.terminate();
}

void main();
