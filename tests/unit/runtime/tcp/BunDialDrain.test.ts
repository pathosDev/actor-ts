/**
 * #931 on the dialling side of a native Bun socket: a `Bun.connect` dial whose
 * write answered `false` writes the rest and is told to resume once the peer
 * reads.
 *
 * `BunTcpBackend` routes Bun's `drain` to the same backlog flush on both sides,
 * but a dial gates it on the dial having opened — and only smoke case 60
 * reached that gate, so a dial that never flushed its backlog passed every
 * `bun test`.  `globalThis.Bun` cannot be replaced, so this dials for real:
 * a `node:net` listener pauses the accepted socket until the dialler has
 * pushed back, then reads everything.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { BunTcpBackend } from '../../../../src/runtime/tcp/BunTcpBackend.js';
import type { TcpSocketLike } from '../../../../src/runtime/tcp/TcpBackend.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const HOST = '127.0.0.1';
const CHUNK_BYTES = 64 * 1024;
/** Far past any loopback buffer: a socket still answering `true` here never pushes back. */
const MAX_CHUNKS = 256;

/** `count` bytes continuing a stream at `offset`, so a dropped or reordered byte shows. */
function chunk(offset: number, count: number): Uint8Array {
  return Uint8Array.from({ length: count }, (_, i) => (offset + i) % 251);
}

const servers: Server[] = [];
const dialled: TcpSocketLike[] = [];

afterEach(async () => {
  for (const socket of dialled.splice(0)) socket.destroy?.();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A listener whose accepted socket reads nothing until the test resumes it. */
async function pausedPeer(): Promise<{ port: number; accepted: Promise<Socket> }> {
  const server = createServer({ pauseOnConnect: true });
  servers.push(server);
  let accept: (socket: Socket) => void = () => {};
  const accepted = new Promise<Socket>((resolve) => { accept = resolve; });
  server.on('connection', (socket) => accept(socket));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { port, accepted };
}

describe('BunTcpBackend forwards drain to a native dial (#931)', () => {
  test('a dial whose write answered false drains, and every byte reaches the peer', async () => {
    const { port, accepted } = await pausedPeer();
    let drains = 0;
    // No `signal`: the dial goes through `Bun.connect`, not `node:net`.
    const socket = await new BunTcpBackend().connect({
      host: HOST,
      port,
      handlers: {
        onOpen: () => {},
        onData: () => {},
        onClose: () => {},
        onError: () => {},
        onDrain: () => { drains += 1; },
      },
    });
    dialled.push(socket);
    const peer = await accepted;

    let sent = 0;
    let pushedBack = false;
    for (let i = 0; i < MAX_CHUNKS && !pushedBack; i++) {
      pushedBack = socket.write(chunk(sent, CHUNK_BYTES)) === false;
      sent += CHUNK_BYTES;
    }
    expect(pushedBack).toBe(true);
    expect(drains).toBe(0);

    const received: Uint8Array[] = [];
    let receivedBytes = 0;
    peer.on('data', (data: Buffer) => {
      received.push(new Uint8Array(data));
      receivedBytes += data.byteLength;
    });
    peer.resume();

    await awaitCondition(() => drains > 0 && receivedBytes >= sent, {
      timeoutMs: 4_000,
      label: 'the dial drained and the peer read every byte written',
    });
    expect(receivedBytes).toBe(sent);
    const stream = Buffer.concat(received);
    expect(stream.equals(Buffer.from(chunk(0, sent)))).toBe(true);
    peer.destroy();
  });
});
