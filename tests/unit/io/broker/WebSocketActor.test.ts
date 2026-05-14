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
    const target = sys.spawnAnonymous(Props.create(() => collector));

    let connected = false;
    sys.eventStream.subscribe(
      sys.spawnAnonymous(Props.create(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { connected = true; }
      })())),
      BrokerConnected,
    );

    const ref = sys.spawnAnonymous(Props.create(() => new WebSocketActor({
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
    const target = sys.spawnAnonymous(Props.create(() => collector));
    const ref = sys.spawnAnonymous(Props.create(() => new WebSocketActor({
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

/* ------------------------- security: oversize-frame DoS -------------------------- */

/**
 * **Exploit walkthrough (pre-fix).**  WebSocket inbound frames had no
 * size cap.  A malicious server (or a man-in-the-middle on plain
 * `ws://`) could push 100-MiB frames; `WebSocketActor.handleMessage`
 * called `target.tell({ kind: 'binary', data })` immediately,
 * queueing the giant buffer in the target actor's mailbox.  If
 * `target` consumed slowly, the cluster's memory exploded.
 *
 * Fix: `maxInboundFrameBytes` setting (default 1 MiB).  Oversize
 * frames are logged at warn level and dropped — no `target.tell`,
 * so no mailbox pressure.
 */

/** Echo server that, on every connection, pushes one frame of `bytes` bytes. */
function startBunWsFlooder(bytes: number, kind: 'text' | 'binary' = 'binary'): BunWsServer {
  const payload: string | Uint8Array = kind === 'text'
    ? 'x'.repeat(bytes)
    : new Uint8Array(bytes);
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response('nope', { status: 400 });
    },
    websocket: {
      open(ws) { ws.send(payload as never); },
      message() { /* ignore */ },
    },
  });
  return { port: server.port, stop: () => { server.stop(true); } };
}

describe('WebSocketActor — oversize-frame DoS hardening', () => {
  test('exploit: oversize inbound binary frame is dropped (default cap)', async () => {
    // Server floods a 2-MiB binary frame; default cap is 1 MiB → dropped.
    const srv = startBunWsFlooder(2 * 1024 * 1024, 'binary');
    const sys = ActorSystem.create('ws-evil-1', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));
    sys.spawnAnonymous(Props.create(() => new WebSocketActor({
      url: `ws://localhost:${srv.port}`, target,
    })));
    await sleep(200);
    // No frame delivered — cap rejected the flood.
    expect(collector.received.length).toBe(0);
    await sys.terminate();
    srv.stop();
  }, 5_000);

  test('exploit: oversize inbound text frame is dropped (default cap)', async () => {
    const srv = startBunWsFlooder(2 * 1024 * 1024, 'text');
    const sys = ActorSystem.create('ws-evil-2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));
    sys.spawnAnonymous(Props.create(() => new WebSocketActor({
      url: `ws://localhost:${srv.port}`, target,
    })));
    await sleep(200);
    expect(collector.received.length).toBe(0);
    await sys.terminate();
    srv.stop();
  }, 5_000);

  test('defense: tighter custom cap drops smaller frames too', async () => {
    const srv = startBunWsFlooder(200 * 1024, 'binary');     // 200 KiB
    const sys = ActorSystem.create('ws-evil-3', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));
    sys.spawnAnonymous(Props.create(() => new WebSocketActor({
      url: `ws://localhost:${srv.port}`,
      target,
      maxInboundFrameBytes: 100 * 1024,    // 100 KiB cap → 200 KiB rejected
    })));
    await sleep(200);
    expect(collector.received.length).toBe(0);
    await sys.terminate();
    srv.stop();
  }, 5_000);

  test('regression: legitimate sub-cap frames still delivered', async () => {
    const srv = startBunWsFlooder(512 * 1024, 'binary');     // 512 KiB, under 1 MiB default
    const sys = ActorSystem.create('ws-ok', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));
    sys.spawnAnonymous(Props.create(() => new WebSocketActor({
      url: `ws://localhost:${srv.port}`, target,
    })));
    await sleep(200);
    expect(collector.received.length).toBe(1);
    expect(collector.received[0]!.kind).toBe('binary');
    expect((collector.received[0] as { data: Uint8Array }).data.byteLength).toBe(512 * 1024);
    await sys.terminate();
    srv.stop();
  }, 5_000);

  test('escape hatch: maxInboundFrameBytes=Infinity disables the cap', async () => {
    // Confirm power users can opt out of the cap.
    const srv = startBunWsFlooder(2 * 1024 * 1024, 'binary');
    const sys = ActorSystem.create('ws-uncapped', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));
    sys.spawnAnonymous(Props.create(() => new WebSocketActor({
      url: `ws://localhost:${srv.port}`,
      target,
      maxInboundFrameBytes: Number.POSITIVE_INFINITY,
    })));
    await sleep(200);
    expect(collector.received.length).toBe(1);
    await sys.terminate();
    srv.stop();
  }, 5_000);
});
