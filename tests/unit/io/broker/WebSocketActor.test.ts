import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { Actor } from '../../../../src/Actor.js';
import {
  WebSocketActor,
  type WebSocketFrame,
} from '../../../../src/io/broker/WebSocketActor.js';
import { BrokerConnected } from '../../../../src/io/broker/BrokerEvents.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

class CollectActor extends Actor<WebSocketFrame> {
  received: WebSocketFrame[] = [];
  override onReceive(m: WebSocketFrame): void { this.received.push(m); }
}

interface BunWsServer {
  port: number;
  stop(): void;
}

/** Tiny echo WebSocket server using Bun.serve. */
function startBunWsEcho(): BunWsServer {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response('not a ws upgrade', { status: 400 });
    },
    websocket: {
      message(ws, msg) { ws.send(msg as never); },
    },
  });
  return { port: server.port, stop: () => { server.stop(true); } };
}

describe('WebSocketActor — round-trip via Bun.serve echo', () => {
  test('text frames are echoed and delivered to target', async () => {
    const srv = startBunWsEcho();
    const sys = ActorSystem.create('ws-1', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const collector = new CollectActor();
    const target = sys.actorOf(Props.create(() => collector));

    let connected = false;
    sys.eventStream.subscribe(
      sys.actorOf(Props.create(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { connected = true; }
      })())),
      BrokerConnected,
    );

    const ref = sys.actorOf(Props.create(() => new WebSocketActor({
      url: `ws://localhost:${srv.port}`, target,
    })));
    await sleep(80);
    expect(connected).toBe(true);
    ref.tell({ kind: 'sendText', data: 'hello-ws' });
    await sleep(80);
    expect(collector.received.length).toBe(1);
    expect(collector.received[0]!.kind).toBe('text');
    expect((collector.received[0] as { data: string }).data).toBe('hello-ws');
    await sys.terminate();
    srv.stop();
  });

  test('binary frames are echoed back as Uint8Array', async () => {
    const srv = startBunWsEcho();
    const sys = ActorSystem.create('ws-2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const collector = new CollectActor();
    const target = sys.actorOf(Props.create(() => collector));
    const ref = sys.actorOf(Props.create(() => new WebSocketActor({
      url: `ws://localhost:${srv.port}`, target,
    })));
    await sleep(80);
    ref.tell({ kind: 'sendBinary', data: new Uint8Array([1, 2, 3, 4]) });
    await sleep(80);
    expect(collector.received.length).toBe(1);
    expect(collector.received[0]!.kind).toBe('binary');
    const bytes = (collector.received[0] as { data: Uint8Array }).data;
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    await sys.terminate();
    srv.stop();
  });
});
