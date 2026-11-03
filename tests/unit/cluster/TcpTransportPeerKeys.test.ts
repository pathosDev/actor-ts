/**
 * #1476 — a connection that goes gives back every `byPeer` key it holds, not
 * just the two it can name.
 *
 * A connection is registered under the address a dial was opened to and under
 * each identity a handshake frame announced on it.  The release walked `peer`
 * and `targetKey` only — the identity announced last and the dialled address —
 * so a connection that announced more than one identity left the earlier ones
 * mapped to a connection that was closed.  A `send` to such an address then
 * went into the closed connection instead of a new dial, and the real peer's
 * `hello` under it was turned away, because another connection still seemed
 * to hold the address.
 *
 * Every case announces three identities on one connection, so a release that
 * remembers any fixed pair of keys — the one asked for, the first, the last —
 * still leaves one behind.  Driven through the transport's private seams with
 * recording sockets, the shape `TcpTransportOutboundDial.test.ts` uses: what is
 * under test is the bookkeeping, and no runtime socket event is involved.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { NoopLogger } from '../../../src/Logger.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame, FrameDecoder } from '../../../src/cluster/Protocol.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import type { TcpSocketHandlers, TcpSocketLike } from '../../../src/runtime/tcp/TcpBackend.js';

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
    write(data: Uint8Array): void { this.writes.push(data); },
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

const self = new NodeAddress('sim', '10.0.0.100', 5_000);
/** The three identities one connection announces, in this order. */
const first = new NodeAddress('sim', '10.0.0.1', 5_000);
const second = new NodeAddress('sim', '10.0.0.2', 5_000);
const third = new NodeAddress('sim', '10.0.0.3', 5_000);
const IDENTITIES = [first, second, third] as const;

const transports: TcpTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.shutdown();
});

function startTransport(): { transport: TcpTransport; dials: Dial[] } {
  const transport = new TcpTransport(self, new NoopLogger());
  transports.push(transport);
  return { transport, dials: openingDialer(transport) };
}

function handshake(kind: 'hello' | 'hello-ack', address: NodeAddress): Uint8Array {
  return encodeFrame({ kind, self: address.toJSON() });
}

/** An accepted socket that announces every identity in `IDENTITIES`, one `hello` each. */
function inboundAnnouncingAll(transport: TcpTransport): RecordingSocket {
  const socket = recordingSocket();
  internals(transport).attachInbound(socket);
  for (const identity of IDENTITIES) internals(transport).onData(socket, handshake('hello', identity));
  return socket;
}

const keysOf = (transport: TcpTransport): string[] => [...internals(transport).byPeer.keys()].sort();

const identityKeys = (): string[] => IDENTITIES.map(String).sort();

/** Every frame written to `socket`, decoded in order. */
function framesWritten(socket: RecordingSocket): WireMessage[] {
  const decoder = new FrameDecoder();
  return socket.writes.flatMap((write) => decoder.push(write));
}

function heartbeat(seq: number): WireMessage {
  return { kind: 'heartbeat', from: self.toJSON(), seq, ts: seq };
}

describe('an inbound connection gives back every identity it announced (#1476)', () => {
  test('the three identities are three keys on one peer while it lives', () => {
    // The precondition the cases below rest on: a second `hello` on an
    // established connection is taken, and adds a key rather than moving one.
    const { transport } = startTransport();
    inboundAnnouncingAll(transport);

    expect(keysOf(transport)).toEqual(identityKeys());
    expect(transport.peers().map(String)).toEqual([third.toString()]);
  });

  test('disconnect(first identity) leaves none of them behind', () => {
    const { transport } = startTransport();
    inboundAnnouncingAll(transport);

    transport.disconnect(first);

    expect(keysOf(transport)).toEqual([]);
    expect(transport.peers()).toEqual([]);
  });

  test('disconnect(an identity announced in between) leaves none of them behind', () => {
    const { transport } = startTransport();
    inboundAnnouncingAll(transport);

    transport.disconnect(second);

    expect(keysOf(transport)).toEqual([]);
  });

  test('a send to the first identity after disconnect() dials it again', () => {
    const { transport, dials } = startTransport();
    inboundAnnouncingAll(transport);
    transport.disconnect(third);

    transport.send(first, heartbeat(1));

    // A key left behind maps the address to the closed connection, and the
    // frame went into that instead of a new dial.
    expect(dials.map((dial) => dial.target)).toEqual([`${first.host}:${first.port}`]);
  });

  test('the real peer at the first identity is taken after disconnect()', () => {
    const { transport } = startTransport();
    inboundAnnouncingAll(transport);
    transport.disconnect(third);

    const real = recordingSocket();
    internals(transport).attachInbound(real);
    internals(transport).onData(real, handshake('hello', first));

    // Answered and kept: a key left behind made this a claim on an address
    // another connection held, and the socket was aborted instead.
    expect(real.destroyed).toBe(false);
    expect(framesWritten(real).map((frame) => frame.kind)).toEqual(['hello-ack']);
    expect(transport.peers().map(String)).toEqual([first.toString()]);
  });

  test('a connection whose socket closes on its own leaves none of them behind', () => {
    // No `disconnect` at all: the peer went away, and the runtime said so.
    const { transport } = startTransport();
    const socket = inboundAnnouncingAll(transport);

    internals(transport).onClose(socket);

    expect(keysOf(transport)).toEqual([]);
    const real = recordingSocket();
    internals(transport).attachInbound(real);
    internals(transport).onData(real, handshake('hello', second));
    expect(real.destroyed).toBe(false);
    expect(transport.peers().map(String)).toEqual([second.toString()]);
  });
});

describe('a dial gives back its address and every identity its peer announced (#1476)', () => {
  test('disconnect(dialled address) leaves none of the four keys behind', () => {
    // The dialled address names none of the identities, as a seed written as a
    // DNS name does not name the address its peer advertises.
    const dialled = new NodeAddress('sim', 'seed.internal', 5_000);
    const { transport, dials } = startTransport();
    transport.send(dialled, heartbeat(1));
    const [dial] = dials;
    expect(dial).toBeDefined();
    for (const identity of IDENTITIES) dial!.handlers.onData(dial!.socket, handshake('hello-ack', identity));
    expect(keysOf(transport)).toEqual([dialled.toString(), ...identityKeys()].sort());

    transport.disconnect(dialled);

    expect(keysOf(transport)).toEqual([]);
    expect(transport.peers()).toEqual([]);
  });
});
