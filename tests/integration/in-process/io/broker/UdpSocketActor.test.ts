import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createSocket, type Socket } from 'node:dgram';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Actor } from '../../../../../src/Actor.js';
import { UdpSocketActor, type UdpDatagram } from '../../../../../src/io/broker/UdpSocketActor.js';
import { UdpSocketOptions } from '../../../../../src/io/broker/UdpSocketOptions.js';
import { BrokerConnected } from '../../../../../src/io/broker/BrokerEvents.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/** See `TcpSocketActor.test.ts` — the count assertions need an upper bound too. */
const SETTLE_MS = 20;

class CollectActor extends Actor<UdpDatagram> {
  received: UdpDatagram[] = [];
  override onReceive(m: UdpDatagram): void { this.received.push(m); }
}

/**
 * UDP drops what it cannot deliver, so a `send` issued before the socket
 * has bound is lost silently and the assertion below reads an empty
 * collector.  `BrokerConnected` fires once the bind completes — wait for
 * that rather than for 30 ms of wall clock (#418).
 */
function boundWatcher(sys: ActorSystem): { bound: boolean } {
  const state = { bound: false };
  sys.eventStream.subscribe(
    sys.spawnAnonymous(() => new (class extends Actor<unknown> {
      override onReceive(_: unknown): void { state.bound = true; }
    })()),
    BrokerConnected,
  );
  return state;
}

function awaitBound(state: { bound: boolean }, what: string): Promise<void> {
  return awaitCondition(() => state.bound, {
    timeoutMs: 4_000, label: `${what}: the UDP socket finished binding`,
  });
}

function awaitDatagrams(collector: CollectActor, count: number, what: string): Promise<void> {
  return awaitCondition(() => collector.received.length >= count, {
    timeoutMs: 4_000, label: `${what}: ${count} datagram(s) echoed back`,
  });
}

interface UdpEcho {
  port: number;
  close(): Promise<void>;
}

/** UDP echo server: sends every received datagram back to its sender. */
async function startUdpEcho(): Promise<UdpEcho> {
  const sock: Socket = createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    sock.once('listening', () => resolve());
    sock.once('error', (e) => reject(e));
    sock.bind(0, '127.0.0.1');
  });
  sock.on('message', (message: Uint8Array, rinfo) => {
    sock.send(message, rinfo.port, rinfo.address);
  });
  const addr = sock.address();
  return {
    port: addr.port,
    close: () => new Promise<void>((resolve) => sock.close(() => resolve())),
  };
}

let echo: UdpEcho;
beforeEach(async () => { echo = await startUdpEcho(); });
afterEach(async () => { await echo.close(); });

describe('UdpSocketActor', () => {
  test('binds, sends datagram, receives echo', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('udp-1', sysOptions);
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);

    const udpOptions = UdpSocketOptions.create()
      .withTarget(target);
    const bound = boundWatcher(sys);
    const ref = sys.spawnAnonymous(() => new UdpSocketActor(udpOptions));
    await awaitBound(bound, 'single datagram');

    ref.tell({
      kind: 'send',
      datagram: { payload: 'ping', host: '127.0.0.1', port: echo.port },
    });
    await awaitDatagrams(collector, 1, 'single datagram');
    // "exactly one" is half the claim — give a duplicate a chance to appear.
    await sleep(SETTLE_MS);

    expect(collector.received.length).toBe(1);
    const got = collector.received[0]!;
    expect(new TextDecoder().decode(got.payload)).toBe('ping');
    expect(got.remoteHost).toBe('127.0.0.1');
    expect(got.remotePort).toBe(echo.port);
    await sys.terminate();
  });

  test('multiple datagrams to different destinations', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('udp-2', sysOptions);
    // Spin up a second echo that prefixes the response.
    const echo2 = await startUdpEcho();
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);
    const udpOptions = UdpSocketOptions.create()
      .withTarget(target);
    const bound = boundWatcher(sys);
    const ref = sys.spawnAnonymous(() => new UdpSocketActor(udpOptions));
    await awaitBound(bound, 'two destinations');

    ref.tell({ kind: 'send', datagram: { payload: 'a', host: '127.0.0.1', port: echo.port } });
    ref.tell({ kind: 'send', datagram: { payload: 'b', host: '127.0.0.1', port: echo2.port } });
    await awaitDatagrams(collector, 2, 'two destinations');
    await sleep(SETTLE_MS);

    expect(collector.received.length).toBe(2);
    const ports = collector.received.map((d) => d.remotePort).sort();
    expect(ports).toEqual([echo.port, echo2.port].sort());
    await echo2.close();
    await sys.terminate();
  });

  test('Uint8Array payload is sent verbatim', async () => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('udp-3', sysOptions);
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(() => collector);
    const udpOptions = UdpSocketOptions.create()
      .withTarget(target);
    const bound = boundWatcher(sys);
    const ref = sys.spawnAnonymous(() => new UdpSocketActor(udpOptions));
    await awaitBound(bound, 'verbatim bytes');
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    ref.tell({ kind: 'send', datagram: { payload: bytes, host: '127.0.0.1', port: echo.port } });
    await awaitDatagrams(collector, 1, 'verbatim bytes');
    expect(Array.from(collector.received[0]!.payload)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    await sys.terminate();
  });
});
