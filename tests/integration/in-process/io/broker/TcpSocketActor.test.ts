import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Actor } from '../../../../../src/Actor.js';
import { TcpSocketActor } from '../../../../../src/io/broker/TcpSocketActor.js';
import { TcpSocketOptions } from '../../../../../src/io/broker/TcpSocketOptions.js';
import { BrokerConnected } from '../../../../../src/io/broker/BrokerEvents.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/**
 * Settle window for the assertions that also carry an *upper* bound
 * ("exactly three frames").  Polling alone cannot see an overshoot — it
 * returns on the delivery that reaches the count — so those wait for
 * `>=` and then give a short beat in which a surplus frame would show
 * up (#418).
 */
const SETTLE_MS = 20;

class CollectActor extends Actor<unknown> {
  received: unknown[] = [];
  override onReceive(m: unknown): void { this.received.push(m); }
}

/**
 * A real TCP connect crosses the kernel and the event loop, so the 30 ms
 * these tests used to allow for it is a bet on an idle machine, and
 * every one of them sends into the socket immediately afterwards.
 * `BrokerConnected` is the actual signal; watch it instead.
 */
function connectionWatcher(sys: ActorSystem): { connected: boolean } {
  const link = { connected: false };
  sys.eventStream.subscribe(
    sys.spawnAnonymous(() => new (class extends Actor<unknown> {
      override onReceive(_: unknown): void { link.connected = true; }
    })()),
    BrokerConnected,
  );
  return link;
}

function awaitConnected(link: { connected: boolean }, what: string): Promise<void> {
  return awaitCondition(() => link.connected, {
    timeoutMs: 4_000, label: `${what}: the socket reported BrokerConnected`,
  });
}

function awaitFrames(collector: CollectActor, count: number, what: string): Promise<void> {
  return awaitCondition(() => collector.received.length >= count, {
    timeoutMs: 4_000, label: `${what}: ${count} frame(s) delivered to the target`,
  });
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
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tcp-1', sysOptions);
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);

    const link = connectionWatcher(sys);

    const tcpOptions = TcpSocketOptions.create()
      .withHost('127.0.0.1')
      .withPort(server.port)
      .withTarget(target);
    const ref = sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));
    await awaitConnected(link, 'bytes framing');
    expect(link.connected).toBe(true);

    ref.tell({ kind: 'send', payload: 'hello' });
    await awaitFrames(collector, 1, 'bytes framing');
    // Echo server returns the bytes; bytes-framing delivers as Uint8Array.
    expect(collector.received.length).toBeGreaterThanOrEqual(1);
    const first = collector.received[0] as Uint8Array;
    expect(new TextDecoder().decode(first)).toBe('hello');
    await sys.terminate();
  });
});

describe('TcpSocketActor — line framing', () => {
  test('extracts newline-delimited frames', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tcp-2', sysOptions);
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);

    const tcpOptions = TcpSocketOptions.create()
      .withHost('127.0.0.1')
      .withPort(server.port)
      .withTarget(target)
      .withFraming({ kind: 'lines' });
    const link = connectionWatcher(sys);
    const ref = sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));
    await awaitConnected(link, 'line framing');

    // Send three lines in one chunk; echo returns them.  The framing
    // strategy MUST split them into three deliveries.
    ref.tell({ kind: 'send', payload: 'one\ntwo\nthree\n' });
    await awaitFrames(collector, 3, 'line framing');
    // "exactly three" is half the claim — give a fourth a chance to appear.
    await sleep(SETTLE_MS);
    expect(collector.received).toEqual(['one', 'two', 'three']);
    await sys.terminate();
  });

  test('handles partial frames across multiple chunks', async () => {
    // Custom server: echoes byte by byte with a small delay so the
    // line crosses chunk boundaries.
    await server.close();
    server = await startEchoServer((chunk) => chunk);  // identity echo
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tcp-3', sysOptions);
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);
    const tcpOptions = TcpSocketOptions.create()
      .withHost('127.0.0.1')
      .withPort(server.port)
      .withTarget(target)
      .withFraming({ kind: 'lines' });
    const link = connectionWatcher(sys);
    const ref = sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));
    await awaitConnected(link, 'partial frames');
    ref.tell({ kind: 'send', payload: 'partial-' });
    // Fixture, not a wait: the gap is what splits the line across chunks.
    await sleep(20);
    ref.tell({ kind: 'send', payload: 'frame\n' });
    await awaitFrames(collector, 1, 'partial frames');
    expect(collector.received).toContain('partial-frame');
    await sys.terminate();
  });
});

describe('TcpSocketActor — length-prefixed framing', () => {
  test('extracts u32-prefixed frames', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tcp-4', sysOptions);
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);
    const tcpOptions = TcpSocketOptions.create()
      .withHost('127.0.0.1')
      .withPort(server.port)
      .withTarget(target)
      .withFraming({ kind: 'length-prefixed' });
    const link = connectionWatcher(sys);
    const ref = sys.spawnAnonymous(() => new TcpSocketActor(tcpOptions));
    await awaitConnected(link, 'length-prefixed framing');

    // Build a 5-byte frame with a 4-byte length prefix.
    const payload = new TextEncoder().encode('hello');
    const out = new Uint8Array(4 + payload.length);
    new DataView(out.buffer).setUint32(0, payload.length, false);  // big-endian
    out.set(payload, 4);
    ref.tell({ kind: 'send', payload: out });
    await awaitFrames(collector, 1, 'length-prefixed framing');
    // "exactly one" is half the claim — give a second frame a chance.
    await sleep(SETTLE_MS);
    expect(collector.received.length).toBe(1);
    const decoded = new TextDecoder().decode(collector.received[0] as Uint8Array);
    expect(decoded).toBe('hello');
    await sys.terminate();
  });
});

describe('TcpSocketActor — options validation', () => {
  test('missing host/port throws BrokerOptionsError', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('tcp-5', sysOptions);
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);
    let captured: Error | null = null;
    const tcpOptions = TcpSocketOptions.create()
      .withTarget(target);  // host, port missing
    sys.spawnAnonymous(() => {
      const actor = new TcpSocketActor(tcpOptions);
      const orig = actor.preStart.bind(actor);
      actor.preStart = async () => { try { await orig(); } catch (e) { captured = e as Error; } };
      return actor as unknown as Actor<unknown>;
    });
    await awaitCondition(() => captured !== null, {
      timeoutMs: 4_000, label: 'preStart rejected the incomplete options',
    });
    expect(captured).not.toBeNull();
    expect((captured as unknown as Error).message).toContain('host');
    expect((captured as unknown as Error).message).toContain('port');
    await sys.terminate();
  });
});
