import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createSocket, type Socket } from 'node:dgram';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Props } from '../../../../../src/Props.js';
import { Actor } from '../../../../../src/Actor.js';
import { UdpSocketActor, type UdpDatagram } from '../../../../../src/io/broker/UdpSocketActor.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

class CollectActor extends Actor<UdpDatagram> {
  received: UdpDatagram[] = [];
  override onReceive(m: UdpDatagram): void { this.received.push(m); }
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
  sock.on('message', (msg: Uint8Array, rinfo) => {
    sock.send(msg, rinfo.port, rinfo.address);
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
    const sys = ActorSystem.create('udp-1', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));

    const ref = sys.spawnAnonymous(Props.create(() => new UdpSocketActor({ target })));
    await sleep(30);

    ref.tell({
      kind: 'send',
      datagram: { payload: 'ping', host: '127.0.0.1', port: echo.port },
    });
    await sleep(40);

    expect(collector.received.length).toBe(1);
    const got = collector.received[0]!;
    expect(new TextDecoder().decode(got.payload)).toBe('ping');
    expect(got.remoteHost).toBe('127.0.0.1');
    expect(got.remotePort).toBe(echo.port);
    await sys.terminate();
  });

  test('multiple datagrams to different destinations', async () => {
    const sys = ActorSystem.create('udp-2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    // Spin up a second echo that prefixes the response.
    const echo2 = await startUdpEcho();
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));
    const ref = sys.spawnAnonymous(Props.create(() => new UdpSocketActor({ target })));
    await sleep(30);

    ref.tell({ kind: 'send', datagram: { payload: 'a', host: '127.0.0.1', port: echo.port } });
    ref.tell({ kind: 'send', datagram: { payload: 'b', host: '127.0.0.1', port: echo2.port } });
    await sleep(40);

    expect(collector.received.length).toBe(2);
    const ports = collector.received.map((d) => d.remotePort).sort();
    expect(ports).toEqual([echo.port, echo2.port].sort());
    await echo2.close();
    await sys.terminate();
  });

  test('Uint8Array payload is sent verbatim', async () => {
    const sys = ActorSystem.create('udp-3', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const collector = new CollectActor();
    const target = sys.spawnAnonymous(Props.create(() => collector));
    const ref = sys.spawnAnonymous(Props.create(() => new UdpSocketActor({ target })));
    await sleep(30);
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    ref.tell({ kind: 'send', datagram: { payload: bytes, host: '127.0.0.1', port: echo.port } });
    await sleep(40);
    expect(Array.from(collector.received[0]!.payload)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    await sys.terminate();
  });
});
