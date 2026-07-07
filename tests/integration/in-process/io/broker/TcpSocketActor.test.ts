import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Props } from '../../../../../src/Props.js';
import { Actor } from '../../../../../src/Actor.js';
import { TcpSocketActor } from '../../../../../src/io/broker/TcpSocketActor.js';
import { TcpSocketOptions } from '../../../../../src/io/broker/TcpSocketOptions.js';
import { BrokerConnected } from '../../../../../src/io/broker/BrokerEvents.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

class CollectActor extends Actor<unknown> {
  received: unknown[] = [];
  override onReceive(m: unknown): void { this.received.push(m); }
}

interface EchoServer {
  port: number;
  close(): Promise<void>;
}

/** Spin up a tiny TCP echo server on a random port. */
async function startEchoServer(transform?: (chunk: Buffer) => Buffer): Promise<EchoServer> {
  const server: Server = createServer((sock) => {
    sock.on('data', (chunk: Buffer) => {
      sock.write(transform ? transform(chunk) : chunk);
    });
    sock.on('error', () => { /* ignore client disconnects */ });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (typeof addr === 'string' || !addr) throw new Error('no port assigned');
  return {
    port: addr.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let server: EchoServer;
beforeEach(async () => { server = await startEchoServer(); });
afterEach(async () => { await server.close(); });

describe('TcpSocketActor — bytes framing (default)', () => {
  test('connects, sends bytes, receives echo', async () => {
    const sys = ActorSystem.create('tcp-1', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));

    let connected = false;
    sys.eventStream.subscribe(
      sys.spawnAnonymous(Props.create(() => new (class extends Actor<unknown> {
        override onReceive(_: unknown): void { connected = true; }
      })())),
      BrokerConnected,
    );

    const ref = sys.spawnAnonymous(Props.create(() => new TcpSocketActor(
      TcpSocketOptions.create().withHost('127.0.0.1').withPort(server.port).withTarget(target),
    )));
    await sleep(40);
    expect(connected).toBe(true);

    ref.tell({ kind: 'send', payload: 'hello' });
    await sleep(40);
    // Echo server returns the bytes; bytes-framing delivers as Uint8Array.
    expect(collector.received.length).toBeGreaterThanOrEqual(1);
    const first = collector.received[0] as Uint8Array;
    expect(new TextDecoder().decode(first)).toBe('hello');
    await sys.terminate();
  });
});

describe('TcpSocketActor — line framing', () => {
  test('extracts newline-delimited frames', async () => {
    const sys = ActorSystem.create('tcp-2', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));

    const ref = sys.spawnAnonymous(Props.create(() => new TcpSocketActor(
      TcpSocketOptions.create().withHost('127.0.0.1').withPort(server.port).withTarget(target)
        .withFraming({ kind: 'lines' }),
    )));
    await sleep(30);

    // Send three lines in one chunk; echo returns them.  The framing
    // strategy MUST split them into three deliveries.
    ref.tell({ kind: 'send', payload: 'one\ntwo\nthree\n' });
    await sleep(40);
    expect(collector.received).toEqual(['one', 'two', 'three']);
    await sys.terminate();
  });

  test('handles partial frames across multiple chunks', async () => {
    // Custom server: echoes byte by byte with a small delay so the
    // line crosses chunk boundaries.
    await server.close();
    server = await startEchoServer((chunk) => chunk);  // identity echo
    const sys = ActorSystem.create('tcp-3', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));
    const ref = sys.spawnAnonymous(Props.create(() => new TcpSocketActor(
      TcpSocketOptions.create().withHost('127.0.0.1').withPort(server.port).withTarget(target)
        .withFraming({ kind: 'lines' }),
    )));
    await sleep(30);
    ref.tell({ kind: 'send', payload: 'partial-' });
    await sleep(20);
    ref.tell({ kind: 'send', payload: 'frame\n' });
    await sleep(40);
    expect(collector.received).toContain('partial-frame');
    await sys.terminate();
  });
});

describe('TcpSocketActor — length-prefixed framing', () => {
  test('extracts u32-prefixed frames', async () => {
    const sys = ActorSystem.create('tcp-4', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));
    const ref = sys.spawnAnonymous(Props.create(() => new TcpSocketActor(
      TcpSocketOptions.create().withHost('127.0.0.1').withPort(server.port).withTarget(target)
        .withFraming({ kind: 'length-prefixed' }),
    )));
    await sleep(30);

    // Build a 5-byte frame with a 4-byte length prefix.
    const payload = new TextEncoder().encode('hello');
    const out = new Uint8Array(4 + payload.length);
    new DataView(out.buffer).setUint32(0, payload.length, false);  // big-endian
    out.set(payload, 4);
    ref.tell({ kind: 'send', payload: out });
    await sleep(40);
    expect(collector.received.length).toBe(1);
    const decoded = new TextDecoder().decode(collector.received[0] as Uint8Array);
    expect(decoded).toBe('hello');
    await sys.terminate();
  });
});

describe('TcpSocketActor — settings validation', () => {
  test('missing host/port throws BrokerSettingsError', async () => {
    const sys = ActorSystem.create('tcp-5', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));
    let captured: Error | null = null;
    sys.spawnAnonymous(Props.create(() => {
      const a = new TcpSocketActor(TcpSocketOptions.create().withTarget(target));  // host, port missing
      const orig = a.preStart.bind(a);
      a.preStart = async () => { try { await orig(); } catch (e) { captured = e as Error; } };
      return a as unknown as Actor<unknown>;
    }));
    await sleep(30);
    expect(captured).not.toBeNull();
    expect((captured as unknown as Error).message).toContain('host');
    expect((captured as unknown as Error).message).toContain('port');
    await sys.terminate();
  });
});
