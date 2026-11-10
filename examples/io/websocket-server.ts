/**
 * Server-side WebSocket demo using the routing DSL (#1).
 *
 *   bun run examples/io/websocket-server.ts
 *   # then open http://localhost:3000/ and, in that page's dev-tools console:
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
} from '../../src/index.js';
import {
  completeText,
  concat,
  get,
  HttpExtensionId,
  Status,
  WebsocketServerActor,
  websocket,
  type WebsocketConnection,
} from '../../src/http/index.js';
import { attachDevTools } from '../devtools.js';

type SetNameMessage = { kind: 'setName'; name: string };
type SayMessage = { kind: 'say'; text: string };
type ClientMessage = SetNameMessage | SayMessage;

type ServerMessage =
  | { kind: 'system'; text: string }
  | { kind: 'chat'; from: string; text: string };

class ChatRoom extends WebsocketServerActor<ServerMessage, ClientMessage> {
  private readonly names = new Map<string, string>();

  override onMessage(message: ClientMessage): void {
    match(message)
      .with({ kind: 'setName' }, (m) => this.onSetName(m))
      .with({ kind: 'say' }, (m) => this.onSay(m))
      .exhaustive();
  }

  private onSetName({ name }: SetNameMessage): void {
    this.names.set(this.connection.id, name);
    this.reply({ kind: 'system', text: `you are now "${name}"` });
    this.broadcast(
      { kind: 'system', text: `${name} joined` },
      (c) => c.id !== this.connection.id,
    );
  }

  private onSay({ text }: SayMessage): void {
    const from = this.names.get(this.connection.id) ?? 'anon';
    this.broadcast({ kind: 'chat', from, text });
  }

  protected override onClientConnected(c: WebsocketConnection<ServerMessage>): void {
    c.tell({ kind: 'system', text: `welcome — ${this.clients.size} online` });
  }

  protected override onClientDisconnected(c: WebsocketConnection<ServerMessage>): void {
    const name = this.names.get(c.id) ?? 'someone';
    this.names.delete(c.id);
    this.broadcast({ kind: 'system', text: `${name} left` });
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('ws-server-demo');
  const devtools = await attachDevTools(system);
  const chat = system.spawn(ChatRoom, 'chat');

  const routes = concat(
    websocket('/ws', chat),
    get(() => completeText(Status.OK, 'actor-ts websocket demo — connect to ws://localhost:3000/ws')),
  );

  // Loopback, like every other HTTP example in this tree.  This one used to
  // bind the wildcard address, which put an unauthenticated broadcast relay on
  // every interface of whatever machine ran the demo — and it is the file the
  // WebSocket docs point at, so the outlier was also the template (#756).
  // Widen it deliberately, once the service is meant to be reached from
  // elsewhere and has auth of its own.
  //
  // The origin control the security page asks for is on this route already:
  // `websocket()` requires a same-origin `Origin` by default, so the browser
  // console snippet above works (the page is this server's) and a page on
  // another origin is refused the upgrade with 403.  See /http/security/.
  const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 3000).bind(routes);
  console.log(`websocket demo: http://${binding.host}:${binding.port}/  (ws path: /ws)`);
  console.log('press Ctrl+C to exit');

  // Unbinding closes every live WebSocket with a 1001 "going away" first —
  // one more thing `bind()`'s own `service-unbind` task already knows how to
  // do, and one more reason not to re-implement it in a signal handler.
  await system.runUntilTerminated();
}

void main();
