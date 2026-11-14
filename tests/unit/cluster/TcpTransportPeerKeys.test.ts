/**
 * The `byPeer` keys a connection holds, and the one identity it may hold.
 *
 * #1476 — a connection that goes gives back every key it holds, not just the
 * one it was asked to give back.  A dial is registered under the address it
 * was opened to and under the identity its peer announced in the `hello-ack`
 * — two different keys whenever a seed is written as a name the peer does not
 * advertise itself as — and a release that remembered only one of them left
 * the other mapped to a closed connection: a `send` to it went into that
 * connection instead of a new dial, and the real peer's `hello` under it was
 * turned away as a claim on an address another connection still held.
 *
 * #1814 — a connection keeps one peer identity for its lifetime.  A second
 * handshake frame naming a different identity used to be taken: the
 * connection was registered under the new address as well, every later frame
 * was handed to the cluster as coming from it, and `peers()` listed only the
 * newest.  It is refused now, and the connection dropped; a repeated frame
 * naming the same identity changes nothing.
 *
 * Driven through the transport's private seams with recording sockets, the
 * shape `TcpTransportOutboundDial.test.ts` uses: what is under test is the
 * bookkeeping, and no runtime socket event is involved.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame, FrameDecoder } from '../../../src/cluster/Protocol.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import type { TcpSocketHandlers, TcpSocketLike } from '../../../src/runtime/tcp/TcpBackend.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/** A socket that records what was written to it and how it was closed. */
type RecordingSocket = TcpSocketLike & {
  readonly writes: Uint8Array[];
  ended: boolean;
  destroyed: boolean;
};

function recordingSocket(): RecordingSocket {
  return {
    writes: [],
    ended: false,
    destroyed: false,
    write(data: Uint8Array): boolean { this.writes.push(data); return true; },
    end(): void { this.ended = true; },
    destroy(): void { this.destroyed = true; },
  };
}

/** The private seams the cases drive the transport through. */
interface TransportInternals {
  backend: unknown;
  readonly byPeer: ReadonlyMap<string, unknown>;
  attachInbound(socket: unknown): void;
  onData(socket: unknown, chunk: Uint8Array): void;
  onClose(socket: unknown): void;
}

function internals(transport: TcpTransport): TransportInternals {
  return transport as unknown as TransportInternals;
}

/** One dial the fake backend was asked for, opened at once. */
type Dial = {
  readonly target: string;
  readonly socket: RecordingSocket;
  readonly handlers: TcpSocketHandlers;
};

/**
 * Install a backend whose every dial opens at once, and return the dials it
 * was asked for — the evidence that a `send` reached for a new connection
 * rather than writing into one it already had.
 */
function openingDialer(transport: TcpTransport): Dial[] {
  const dials: Dial[] = [];
  internals(transport).backend = {
    listen: () => Promise.resolve({ port: 0, close: () => {} }),
    connect: (options: { host: string; port: number; handlers: TcpSocketHandlers }) => {
      const socket = recordingSocket();
      dials.push({ target: `${options.host}:${options.port}`, socket, handlers: options.handlers });
      options.handlers.onOpen(socket);
      return Promise.resolve(socket);
    },
  };
  return dials;
}

const self = new NodeAddress('sim', '10.0.0.100', 5_000, 'test-run');
/** The identity a connection announces. */
const first = new NodeAddress('sim', '10.0.0.1', 5_000, 'test-run');
/** A different identity, announced afterwards on the same connection. */
const second = new NodeAddress('sim', '10.0.0.2', 5_000, 'test-run');
/** A dial target that names neither identity, as a seed written as a DNS name does not. */
const dialled = new NodeAddress('sim', 'seed.internal', 5_000, 'test-run');

const transports: TcpTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.shutdown();
});

function startTransport(): { transport: TcpTransport; dials: Dial[]; log: RecordingLogger } {
  const log = new RecordingLogger();
  const transport = new TcpTransport(self, log);
  transports.push(transport);
  return { transport, dials: openingDialer(transport), log };
}

function handshake(kind: 'hello' | 'hello-ack', address: NodeAddress): Uint8Array {
  return encodeFrame({ kind, wireVersion: 2, minWireVersion: 2, self: address.toJSON() });
}

/** An accepted socket that has announced `identity`. */
function inboundAnnouncing(transport: TcpTransport, identity: NodeAddress): RecordingSocket {
  const socket = recordingSocket();
  internals(transport).attachInbound(socket);
  internals(transport).onData(socket, handshake('hello', identity));
  return socket;
}

/** A dial to {@link dialled}, acknowledged by a peer announcing `identity`. */
async function dialAcknowledgedAs(transport: TcpTransport, dials: Dial[], identity: NodeAddress): Promise<Dial> {
  transport.send(dialled, heartbeat(1));
  // The transport installs the socket once `connect` resolves, as it would
  // have before any byte arrives on a real one.
  await Promise.resolve();
  const dial = dials.at(-1)!;
  dial.handlers.onData(dial.socket, handshake('hello-ack', identity));
  return dial;
}

const keysOf = (transport: TcpTransport): string[] => [...internals(transport).byPeer.keys()].sort();

/** Every frame written to `socket`, decoded in order. */
function framesWritten(socket: RecordingSocket): WireMessage[] {
  const decoder = new FrameDecoder();
  return socket.writes.flatMap((write) => decoder.push(write));
}

function heartbeat(seq: number): WireMessage {
  return { kind: 'heartbeat', from: self.toJSON(), seq, ts: seq };
}

const warnings = (log: RecordingLogger): string[] =>
  log.records.filter((record) => record.level === 'warn').map((record) => record.message);

describe('an inbound connection keeps the one identity it announced (#1814)', () => {
  test('a second hello naming a different identity drops the connection', async () => {
    const { transport, log } = startTransport();
    const socket = inboundAnnouncing(transport, first);

    internals(transport).onData(socket, handshake('hello', second));

    expect(socket.destroyed).toBe(true);
    expect(keysOf(transport)).toEqual([]);
    expect(transport.peers()).toEqual([]);
    expect(warnings(log).filter((line) => line.startsWith('hello refused: the connection already belongs to')))
      .toHaveLength(1);
  });

  test('nothing after the refused hello reaches the handler as either identity', async () => {
    const { transport } = startTransport();
    const delivered: string[] = [];
    transport.setHandler((from) => { delivered.push(from.toString()); });
    const socket = inboundAnnouncing(transport, first);

    internals(transport).onData(socket, handshake('hello', second));
    internals(transport).onData(socket, encodeFrame(heartbeat(2)));

    expect(delivered).toEqual([]);
  });

  test('a repeated hello naming the same identity changes nothing', async () => {
    const { transport, log } = startTransport();
    const delivered: string[] = [];
    transport.setHandler((from) => { delivered.push(from.toString()); });
    const socket = inboundAnnouncing(transport, first);

    internals(transport).onData(socket, handshake('hello', first));
    internals(transport).onData(socket, encodeFrame(heartbeat(2)));

    expect(socket.destroyed).toBe(false);
    // Answered once: the repeat is ignored, not handshaken a second time.
    expect(framesWritten(socket).map((frame) => frame.kind)).toEqual(['hello-ack']);
    expect(keysOf(transport)).toEqual([first.toString()]);
    expect(transport.peers().map(String)).toEqual([first.toString()]);
    expect(delivered).toEqual([first.toString()]);
    expect(warnings(log)).toEqual([]);
  });
});

describe('a dial keeps the one identity its peer acknowledged with (#1814)', () => {
  test('a second hello-ack naming a different identity drops the dial', async () => {
    const { transport, dials, log } = startTransport();
    const dial = await dialAcknowledgedAs(transport, dials, first);
    expect(keysOf(transport)).toEqual([dialled.toString(), first.toString()].sort());

    dial.handlers.onData(dial.socket, handshake('hello-ack', second));

    expect(dial.socket.destroyed).toBe(true);
    expect(keysOf(transport)).toEqual([]);
    expect(transport.peers()).toEqual([]);
    expect(warnings(log).filter((line) => line.startsWith('hello-ack refused: the connection already belongs to')))
      .toHaveLength(1);
  });

  test('a hello naming a different identity on an acknowledged dial drops it too', async () => {
    const { transport, dials } = startTransport();
    const dial = await dialAcknowledgedAs(transport, dials, first);

    dial.handlers.onData(dial.socket, handshake('hello', second));

    expect(dial.socket.destroyed).toBe(true);
    expect(keysOf(transport)).toEqual([]);
  });

  test('a repeated hello-ack naming the same identity changes nothing', async () => {
    const { transport, dials, log } = startTransport();
    const dial = await dialAcknowledgedAs(transport, dials, first);
    const writesBefore = dial.socket.writes.length;

    dial.handlers.onData(dial.socket, handshake('hello-ack', first));

    expect(dial.socket.destroyed).toBe(false);
    expect(keysOf(transport)).toEqual([dialled.toString(), first.toString()].sort());
    expect(dial.socket.writes.length).toBe(writesBefore);
    expect(warnings(log)).toEqual([]);
  });
});

describe('a connection gives back every key it holds (#1476)', () => {
  test('disconnect(dialled address) gives back the announced identity too', async () => {
    const { transport, dials } = startTransport();
    await dialAcknowledgedAs(transport, dials, first);

    transport.disconnect(dialled);

    expect(keysOf(transport)).toEqual([]);
    expect(transport.peers()).toEqual([]);
  });

  test('disconnect(announced identity) gives back the dialled address too', async () => {
    const { transport, dials } = startTransport();
    await dialAcknowledgedAs(transport, dials, first);

    transport.disconnect(first);

    expect(keysOf(transport)).toEqual([]);
  });

  test('a send to the dialled address after disconnect(identity) dials it again', async () => {
    const { transport, dials } = startTransport();
    await dialAcknowledgedAs(transport, dials, first);
    transport.disconnect(first);

    transport.send(dialled, heartbeat(2));

    // A key left behind maps the address to the closed connection, and the
    // frame went into that instead of a new dial.
    expect(dials.map((dial) => dial.target)).toEqual([
      `${dialled.host}:${dialled.port}`,
      `${dialled.host}:${dialled.port}`,
    ]);
  });

  test('the real peer at the announced identity is taken after its dial closed on its own', async () => {
    // No `disconnect` at all: the peer went away, and the runtime said so.
    const { transport, dials } = startTransport();
    const dial = await dialAcknowledgedAs(transport, dials, first);
    dial.handlers.onClose(dial.socket);
    expect(keysOf(transport)).toEqual([]);

    const real = inboundAnnouncing(transport, first);

    // Answered and kept: a key left behind made this a claim on an address
    // another connection held, and the socket was aborted instead.
    expect(real.destroyed).toBe(false);
    expect(framesWritten(real).map((frame) => frame.kind)).toEqual(['hello-ack']);
    expect(transport.peers().map(String)).toEqual([first.toString()]);
  });

  test('a refused second identity gives back the first identity as well', async () => {
    const { transport } = startTransport();
    const socket = inboundAnnouncing(transport, first);
    internals(transport).onData(socket, handshake('hello', second));

    const real = inboundAnnouncing(transport, first);

    expect(real.destroyed).toBe(false);
    expect(transport.peers().map(String)).toEqual([first.toString()]);
  });
});
