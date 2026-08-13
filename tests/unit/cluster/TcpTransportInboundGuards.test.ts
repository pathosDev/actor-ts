/**
 * #588 — what an unauthenticated inbound socket may hold.
 *
 * The decoder runs before the `hello` gate, so everything here is reachable by
 * anyone who can open a TCP connection to the cluster port.  Two bounds close
 * the two halves of "connected but silent":
 *
 * - a **stall deadline** on a half-received frame, so a socket that sends three
 *   bytes of a length prefix and then nothing gives its buffer back.  Until now
 *   only the *outbound* dial had a deadline (`HANDSHAKE_TIMEOUT_MS`, #697), and
 *   that one stops mattering the moment the handshake lands.
 * - an **inbound connection cap**, so the per-connection cost cannot simply be
 *   multiplied by opening sockets in a loop.
 *
 * The tests drive `TcpTransport`'s private socket callbacks with mock sockets,
 * the same way the hijack and crossing-dial tests in
 * `tests/multi-node/cluster-security.test.ts` do — the guards live in those
 * callbacks, and a real listener would only add a port to collide on.
 */
import { describe, expect, test } from 'bun:test';
import { NoopLogger } from '../../../src/Logger.js';
import { INCOMPLETE_FRAME_IDLE_MS, MAX_INBOUND_CONNECTIONS } from '../../../src/cluster/Constants.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame } from '../../../src/cluster/Protocol.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';

type MockSocket = {
  ended: boolean;
  writes: Uint8Array[];
  write(data: Uint8Array): void;
  end(): void;
};

function mockSocket(): MockSocket {
  return {
    ended: false,
    writes: [],
    write(data: Uint8Array): void { this.writes.push(data); },
    end(): void { this.ended = true; },
  };
}

/** The private socket callbacks and bookkeeping these tests reach through. */
interface TransportInternals {
  attachInbound(socket: unknown): void;
  onData(socket: unknown, chunk: Uint8Array): void;
  onClose(socket: unknown): void;
  onIncompleteFrameTimeout(connection: object): void;
  readonly inboundConnections: number;
  readonly bySocket: WeakMap<object, { incompleteFrameTimer: unknown }>;
}

function internals(transport: TcpTransport): TransportInternals {
  return transport as unknown as TransportInternals;
}

function newTransport(port: number): TcpTransport {
  return new TcpTransport(new NodeAddress('inbound-guards', '127.0.0.1', port), new NoopLogger());
}

/** The first `bytes` of a well-formed hello frame — a deliberate partial. */
function partialHello(bytes: number): Uint8Array {
  const frame = encodeFrame({
    kind: 'hello',
    self: new NodeAddress('inbound-guards', '10.0.0.7', 2_552).toJSON(),
  });
  return frame.subarray(0, bytes);
}

describe('an inbound socket cannot hold a half-received frame forever', () => {
  test('exploit: a socket that stops mid-frame is dropped once the stall deadline passes', () => {
    const transport = newTransport(19_101);
    const socket = mockSocket();
    internals(transport).attachInbound(socket);

    // Three bytes: not even the 4-byte length prefix is complete, so the
    // decoder can say nothing about the frame except that it is unfinished.
    internals(transport).onData(socket, partialHello(3));
    const connection = internals(transport).bySocket.get(socket)!;
    expect(connection.incompleteFrameTimer).not.toBeNull();

    // What the timer fires, invoked directly — the alternative is 30 s of wall
    // clock in a unit test, or reaching into the runtime's timer internals.
    internals(transport).onIncompleteFrameTimeout(connection);
    expect(socket.ended).toBe(true);
  });

  test('a chunk that ends on a frame boundary arms nothing at all', () => {
    // The cost side of the guard: ordinary traffic is complete frames, and it
    // must not pay a clearTimeout/setTimeout pair per chunk.
    const transport = newTransport(19_102);
    const socket = mockSocket();
    internals(transport).attachInbound(socket);

    internals(transport).onData(socket, encodeFrame({
      kind: 'hello',
      self: new NodeAddress('inbound-guards', '10.0.0.8', 2_552).toJSON(),
    }));

    expect(internals(transport).bySocket.get(socket)?.incompleteFrameTimer).toBeNull();
    expect(socket.ended).toBe(false);
  });

  test('a peer that keeps making progress is never punished for being slow', () => {
    // The deadline is a stall bound, not a budget for the frame: it is re-armed
    // on every chunk, so a large frame arriving in dribs over a congested link
    // survives arbitrarily long as long as bytes keep coming.
    const transport = newTransport(19_103);
    const socket = mockSocket();
    internals(transport).attachInbound(socket);

    const frame = encodeFrame({
      kind: 'hello',
      self: new NodeAddress('inbound-guards', '10.0.0.9', 2_552).toJSON(),
    });
    for (let i = 0; i < frame.byteLength - 1; i += 1) {
      internals(transport).onData(socket, frame.subarray(i, i + 1));
      // Every one of those chunks left the frame incomplete, and every one of
      // them re-armed rather than let the previous deadline stand.
      expect(internals(transport).bySocket.get(socket)?.incompleteFrameTimer).not.toBeNull();
    }
    internals(transport).onData(socket, frame.subarray(frame.byteLength - 1));

    expect(socket.ended).toBe(false);
    expect(internals(transport).bySocket.get(socket)?.incompleteFrameTimer).toBeNull();
  });

  test('the deadline is generous enough to be a stall signal, not a rate limit', () => {
    expect(INCOMPLETE_FRAME_IDLE_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe('inbound connections are capped', () => {
  test('exploit: opening sockets in a loop stops being free at the cap', () => {
    const transport = newTransport(19_201);
    const accepted: MockSocket[] = [];
    for (let i = 0; i < MAX_INBOUND_CONNECTIONS; i += 1) {
      const socket = mockSocket();
      internals(transport).attachInbound(socket);
      accepted.push(socket);
    }
    expect(internals(transport).inboundConnections).toBe(MAX_INBOUND_CONNECTIONS);
    expect(accepted.every((socket) => !socket.ended)).toBe(true);

    const refused = mockSocket();
    internals(transport).attachInbound(refused);
    expect(refused.ended).toBe(true);
    // Refusing the newest rather than evicting an established peer: an eviction
    // policy would let the attacker push real members off the node.
    expect(internals(transport).inboundConnections).toBe(MAX_INBOUND_CONNECTIONS);
    expect(accepted.every((socket) => !socket.ended)).toBe(true);
  });

  test('a closed socket gives its slot back', () => {
    const transport = newTransport(19_202);
    const socket = mockSocket();
    internals(transport).attachInbound(socket);
    expect(internals(transport).inboundConnections).toBe(1);

    internals(transport).onClose(socket);
    expect(internals(transport).inboundConnections).toBe(0);
  });

  test('a slot is released exactly once, however the connection dies', () => {
    // `dropConnection` and `onClose` can both fire for one socket — the guard
    // rejects a frame and closes it, then the runtime reports the close.  A
    // double release would let the counter drift below zero and quietly
    // un-cap the transport.
    const transport = newTransport(19_203);
    const socket = mockSocket();
    internals(transport).attachInbound(socket);

    // An oversized length-prefix claim: the decoder throws and the transport
    // drops the connection from inside `onData`.
    const oversized = new Uint8Array(4);
    new DataView(oversized.buffer).setUint32(0, 0xFFFFFFFF, false);
    internals(transport).onData(socket, oversized);
    expect(socket.ended).toBe(true);
    expect(internals(transport).inboundConnections).toBe(0);

    internals(transport).onClose(socket);
    expect(internals(transport).inboundConnections).toBe(0);
  });

  test('a socket whose data beat its open callback is counted once, not twice', () => {
    // Bun can deliver `data` before `open` completes its microtask, so both
    // routes attach the same socket.  Counting it twice would halve the cap;
    // re-attaching would also swap in a fresh decoder mid-frame.
    const transport = newTransport(19_204);
    const socket = mockSocket();

    internals(transport).onData(socket, partialHello(3));
    internals(transport).attachInbound(socket);

    expect(internals(transport).inboundConnections).toBe(1);
    // The partial frame survived the second attach — the decoder was not
    // replaced, so the rest of the frame still completes.
    const frame = encodeFrame({
      kind: 'hello',
      self: new NodeAddress('inbound-guards', '10.0.0.7', 2_552).toJSON(),
    });
    internals(transport).onData(socket, frame.subarray(3));
    expect(socket.writes).toHaveLength(1);   // the hello-ack
  });

  test('the cap is far above any topology this framework targets', () => {
    // A fully-meshed cluster needs one inbound connection per peer, so a tight
    // cap would be a partition rather than a defence.
    expect(MAX_INBOUND_CONNECTIONS).toBeGreaterThanOrEqual(1_000);
  });
});
