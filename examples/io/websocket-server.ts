/**
 * Server-side WebSocket integration demo (#1).
 *
 *   bun run examples/io/websocket-server.ts
 *   # then visit http://localhost:3000 and open the dev tools console:
 *   #   const ws = new WebSocket('ws://localhost:3000/ws');
 *   #   ws.onmessage = (e) => console.log('server says:', e.data);
 *   #   ws.send('hello');
 *
 * Pattern:
 *
 *   1. `bunWebSocketHandlers(system, ...)` builds the four
 *      `Bun.serve({ websocket: ... })` callbacks pre-wired to
 *      spawn a `ServerWebSocketActor` per connection.
 *
 *   2. The chat-room actor is the shared destination — every
 *      connection's actor is registered with it on `onOpen` and
 *      removed on `onClose`.
 *
 *   3. Each connection is a single actor; sends from the chatroom
 *      go through `connectionRef.tell({ kind: 'sendText', ... })`.
 */
import {
  Actor,
  ActorSystem,
  Props,
  bunWebSocketHandlers,
  type WebSocketCmd,
  type WebSocketFrame,
} from '../../src/index.js';
import type { ActorRef } from '../../src/index.js';

type ChatCmd =
  | { kind: 'join'; conn: ActorRef<WebSocketCmd> }
  | { kind: 'leave'; conn: ActorRef<WebSocketCmd> }
  | { kind: 'fromClient'; conn: ActorRef<WebSocketCmd>; frame: WebSocketFrame };

class ChatRoom extends Actor<ChatCmd> {
  private readonly clients = new Set<ActorRef<WebSocketCmd>>();

  override onReceive(cmd: ChatCmd): void {
    if (cmd.kind === 'join') {
      this.clients.add(cmd.conn);
      cmd.conn.tell({ kind: 'sendText', data: `welcome — ${this.clients.size} connected` });
      this.broadcast(`* a new client joined (${this.clients.size} total)`);
    } else if (cmd.kind === 'leave') {
      this.clients.delete(cmd.conn);
      this.broadcast(`* a client left (${this.clients.size} remaining)`);
    } else if (cmd.frame.kind === 'text') {
      this.broadcast(`peer: ${cmd.frame.data}`, cmd.conn);
    }
  }

  private broadcast(msg: string, except?: ActorRef<WebSocketCmd>): void {
    for (const c of this.clients) {
      if (c === except) continue;
      c.tell({ kind: 'sendText', data: msg });
    }
  }
}

class PerClientForwarder extends Actor<WebSocketFrame> {
  constructor(
    private readonly chat: ActorRef<ChatCmd>,
    private readonly self_: ActorRef<WebSocketCmd>,
  ) { super(); }
  override onReceive(frame: WebSocketFrame): void {
    this.chat.tell({ kind: 'fromClient', conn: this.self_, frame });
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('ws-server-demo');
  const chat = system.actorOf(Props.create(() => new ChatRoom()), 'chat');

  const handlers = bunWebSocketHandlers(system, {
    onOpen: (_ws, ref) => {
      // Spin up a per-client forwarder that bridges inbound frames
      // into the chat room.  Wire it AFTER the connection actor
      // exists so it can pass `ref` along.
      const forwarder = system.actorOf(
        Props.create(() => new PerClientForwarder(chat, ref)),
      );
      // Re-target the connection actor at the forwarder.  In a
      // production app you'd typically pass `target: forwarder` via
      // the handler options when the chat room itself doesn't need
      // to know about per-connection identity.
      void forwarder;
      chat.tell({ kind: 'join', conn: ref });
    },
    onClose: (_ws, ref) => chat.tell({ kind: 'leave', conn: ref }),
  });

  const server = Bun.serve({
    port: 3000,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (srv.upgrade(req)) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      return new Response(
        '<h1>actor-ts websocket demo</h1><p>connect to <code>ws://localhost:3000/ws</code></p>',
        { headers: { 'Content-Type': 'text/html' } },
      );
    },
    websocket: handlers,
  });

  console.log(`websocket demo: http://localhost:${server.port}/  (ws path: /ws)`);
  console.log('press Ctrl+C to exit');

  await new Promise<void>((resolve) => process.on('SIGINT', () => resolve()));
  server.stop();
  await system.terminate();
}

void main();
