/**
 * #931 — `TcpTransport` honours the socket's back-pressure signal.
 *
 * `send` used to discard what `socket.write()` answered.  On a native Bun
 * socket that cut the frame stream wherever the kernel stopped taking bytes;
 * on Node and Deno it queued without bound behind a peer that had stopped
 * reading.  The transport now stops writing once the socket answers `false`,
 * holds at most `outboundQueueSize` whole frames — dropping the oldest, with
 * one WARN when an episode starts dropping and one when it ends — and writes
 * them, in order, on the socket's `onDrain`.
 *
 * Driven through the transport's private seams with a socket whose answer
 * the test decides, so the cases pin the transport's half of the contract;
 * `TcpTransportBackpressureSockets.test.ts` runs the same traffic over real
 * loopback sockets.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame, FrameDecoder } from '../../../src/cluster/Protocol.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import type { TcpSocketHandlers, TcpSocketLike } from '../../../src/runtime/tcp/TcpBackend.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/** A socket that records every write and answers what `accepting` says. */
type ThrottledSocket = TcpSocketLike & {
  readonly writes: Uint8Array[];
  accepting: boolean;
  ended: boolean;
  destroyed: boolean;
};

function throttledSocket(): ThrottledSocket {
  return {
    writes: [],
    accepting: true,
    ended: false,
    destroyed: false,
    write(data: Uint8Array): boolean { this.writes.push(data); return this.accepting; },
    end(): void { this.ended = true; },
    destroy(): void { this.destroyed = true; },
  };
}

interface TransportInternals {
  backend: unknown;
  attachInbound(socket: unknown): void;
  onData(socket: unknown, chunk: Uint8Array): void;
  onDrain(socket: unknown): void;
}

const internals = (transport: TcpTransport): TransportInternals => transport as unknown as TransportInternals;

const self = new NodeAddress('sim', '10.0.0.100', 5_000, 'test-run');
const peer = new NodeAddress('sim', '10.0.0.1', 5_000, 'test-run');

const transports: TcpTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.shutdown();
});

/** A transport holding an established inbound connection from {@link peer}. */
function connected(outboundQueueSize = 1_000): { transport: TcpTransport; socket: ThrottledSocket; log: RecordingLogger } {
  const log = new RecordingLogger();
  const transport = new TcpTransport(self, log, { outboundQueueSize });
  transports.push(transport);
  const socket = throttledSocket();
  internals(transport).attachInbound(socket);
  internals(transport).onData(socket, encodeFrame({ kind: 'hello', wireVersion: 2, minWireVersion: 2, self: peer.toJSON() }));
  socket.writes.length = 0;  // the hello-ack
  return { transport, socket, log };
}

function heartbeat(seq: number): WireMessage {
  return { kind: 'heartbeat', from: self.toJSON(), seq, ts: seq };
}

/** The sequence numbers of every heartbeat written to `socket`, decoded in order. */
function sequencesWritten(socket: ThrottledSocket): number[] {
  const decoder = new FrameDecoder();
  return socket.writes.flatMap((write) => decoder.push(write)).map((frame) => (frame as { seq: number }).seq);
}

const warnings = (log: RecordingLogger): string[] =>
  log.records.filter((record) => record.level === 'warn').map((record) => record.message);

describe('TcpTransport stops writing when the socket pushes back (#931)', () => {
  test('frames after a write that answered false are held, not written', () => {
    const { transport, socket } = connected();
    socket.accepting = false;

    transport.send(peer, heartbeat(1));
    transport.send(peer, heartbeat(2));
    transport.send(peer, heartbeat(3));

    // The first write is the one that learned of the back-pressure.
    expect(sequencesWritten(socket)).toEqual([1]);
  });

  test('onDrain writes the held frames whole and in order', () => {
    const { transport, socket } = connected();
    socket.accepting = false;
    for (let seq = 1; seq <= 5; seq++) transport.send(peer, heartbeat(seq));

    socket.accepting = true;
    internals(transport).onDrain(socket);
    transport.send(peer, heartbeat(6));

    expect(sequencesWritten(socket)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('a flush stops again at the next write that answers false', () => {
    const { transport, socket } = connected();
    socket.accepting = false;
    for (let seq = 1; seq <= 5; seq++) transport.send(peer, heartbeat(seq));

    // Still pushing back: the drain writes one frame and learns it again.
    internals(transport).onDrain(socket);
    expect(sequencesWritten(socket)).toEqual([1, 2]);

    socket.accepting = true;
    internals(transport).onDrain(socket);
    expect(sequencesWritten(socket)).toEqual([1, 2, 3, 4, 5]);
  });

  test('a frame sent during a flush queues behind what is held', () => {
    const { transport, socket } = connected();
    socket.accepting = false;
    transport.send(peer, heartbeat(1));
    transport.send(peer, heartbeat(2));

    // A drain that pushes back mid-flush, then a send before the next drain.
    internals(transport).onDrain(socket);
    transport.send(peer, heartbeat(3));
    socket.accepting = true;
    internals(transport).onDrain(socket);

    expect(sequencesWritten(socket)).toEqual([1, 2, 3]);
  });
});

describe('the held frames are bounded by outboundQueueSize (#931)', () => {
  test('over the bound the oldest held frame is dropped', () => {
    const { transport, socket } = connected(3);
    socket.accepting = false;
    for (let seq = 1; seq <= 10; seq++) transport.send(peer, heartbeat(seq));

    socket.accepting = true;
    internals(transport).onDrain(socket);

    // 1 went to the socket; of 2..10 the newest three were kept.
    expect(sequencesWritten(socket)).toEqual([1, 8, 9, 10]);
  });

  test('one WARN when an episode starts dropping, one naming the count when it drains', () => {
    const { transport, socket, log } = connected(3);
    socket.accepting = false;
    for (let seq = 1; seq <= 10; seq++) transport.send(peer, heartbeat(seq));

    const started = warnings(log).filter((line) => line.startsWith('send buffer for'));
    expect(started).toEqual([
      `send buffer for ${peer.toString()} hit 3 frames while the peer is not taking them; dropping oldest until it drains`,
    ]);

    socket.accepting = true;
    internals(transport).onDrain(socket);

    expect(warnings(log).filter((line) => line.startsWith('send buffer for'))).toEqual([
      ...started,
      `send buffer for ${peer.toString()} drained; 6 frame(s) were dropped while the peer was not taking them`,
    ]);
  });

  test('a later episode warns again, and one that drops nothing says nothing', () => {
    const { transport, socket, log } = connected(3);
    socket.accepting = false;
    for (let seq = 1; seq <= 5; seq++) transport.send(peer, heartbeat(seq));
    socket.accepting = true;
    internals(transport).onDrain(socket);
    const afterFirst = warnings(log).length;

    // Within the bound: held and flushed, nothing dropped, nothing logged.
    socket.accepting = false;
    transport.send(peer, heartbeat(6));
    transport.send(peer, heartbeat(7));
    socket.accepting = true;
    internals(transport).onDrain(socket);
    expect(warnings(log)).toHaveLength(afterFirst);

    socket.accepting = false;
    for (let seq = 8; seq <= 12; seq++) transport.send(peer, heartbeat(seq));
    expect(warnings(log)).toHaveLength(afterFirst + 1);
  });

  test('a connection dropped while frames are held gives them up', () => {
    const { transport, socket } = connected();
    socket.accepting = false;
    for (let seq = 1; seq <= 3; seq++) transport.send(peer, heartbeat(seq));

    // A malformed length prefix: the connection is dropped for a fault.
    internals(transport).onData(socket, new Uint8Array([0x7f, 0xff, 0xff, 0xff]));
    socket.accepting = true;
    internals(transport).onDrain(socket);

    expect(socket.destroyed).toBe(true);
    expect(sequencesWritten(socket)).toEqual([1]);
  });

  test('an orderly disconnect writes what is held before the FIN', () => {
    const { transport, socket } = connected();
    socket.accepting = false;
    for (let seq = 1; seq <= 3; seq++) transport.send(peer, heartbeat(seq));

    transport.disconnect(peer);

    expect(sequencesWritten(socket)).toEqual([1, 2, 3]);
    expect(socket.ended).toBe(true);
  });
});

describe('a dial honours back-pressure from its first write (#931)', () => {
  test('a hello that met back-pressure holds the frames flushed on the hello-ack', async () => {
    const log = new RecordingLogger();
    const transport = new TcpTransport(self, log);
    transports.push(transport);
    const socket = throttledSocket();
    socket.accepting = false;
    let handlers: TcpSocketHandlers | undefined;
    internals(transport).backend = {
      listen: () => Promise.resolve({ port: 0, close: () => {} }),
      connect: (options: { handlers: TcpSocketHandlers }) => {
        handlers = options.handlers;
        options.handlers.onOpen(socket);
        return Promise.resolve(socket);
      },
    };
    transport.send(peer, heartbeat(1));
    transport.send(peer, heartbeat(2));
    await Promise.resolve();
    handlers!.onData(socket, encodeFrame({ kind: 'hello-ack', wireVersion: 2, self: peer.toJSON() }));

    // Only the hello went out; both frames wait for the drain.
    expect(socket.writes).toHaveLength(1);
    socket.accepting = true;
    handlers!.onDrain!(socket);

    const decoder = new FrameDecoder();
    const kinds = socket.writes.flatMap((write) => decoder.push(write)).map((frame) => frame.kind);
    expect(kinds).toEqual(['hello', 'heartbeat', 'heartbeat']);
  });
});
