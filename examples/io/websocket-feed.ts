/**
 * WebSocket broker actor — both server and client in one process for
 * a self-contained demo.  The server (raw `Bun.serve`) echoes everything
 * it receives; the actor sends JSON ticks and prints replies.
 *
 *   bun run examples/io/websocket-feed.ts
 */
import {
  Actor,
  ActorSystem,
  Props,
  WebSocketActor,
  type WebSocketFrame,
} from '../../src/index.js';

class Printer extends Actor<WebSocketFrame> {
  override onReceive(frame: WebSocketFrame): void {
    if (frame.kind === 'text') {
      console.log('[client] ←', frame.data);
    } else {
      console.log('[client] ← <binary>', frame.data.length, 'bytes');
    }
  }
}

async function main(): Promise<void> {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response('upgrade only', { status: 400 });
    },
    websocket: {
      message(ws, msg) {
        // Echo with a wrapper so it's clearly the server speaking.
        if (typeof msg === 'string') ws.send(`[server-echo] ${msg}`);
        else ws.send(msg as never);
      },
    },
  });
  console.log(`[server] listening on ws://localhost:${server.port}`);

  const sys = ActorSystem.create('ws-demo');
  const printer = sys.actorOf(Props.create(() => new Printer()), 'printer');

  const ws = sys.actorOf(Props.create(() => new WebSocketActor({
    url: `ws://localhost:${server.port}`,
    target: printer,
    pingIntervalMs: 5_000,
  })), 'ws');

  await Bun.sleep(100);
  for (let i = 0; i < 5; i++) {
    const tick = JSON.stringify({ tick: i, ts: Date.now() });
    ws.tell({ kind: 'sendText', data: tick });
    await Bun.sleep(150);
  }

  await Bun.sleep(500);
  await sys.terminate();
  server.stop(true);
}

void main();
