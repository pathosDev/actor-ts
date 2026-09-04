/**
 * #588 — what an unauthenticated inbound socket may hold.
 *
 * The decoder runs before the `hello` gate, so everything here is reachable by
 * anyone who can open a TCP connection to the cluster port.  Three bounds close
 * the three shapes of "connected but silent":
 *
 * - a **stall deadline** on a half-received frame, so a socket that sends three
 *   bytes of a length prefix and then nothing gives its buffer back.
 * - a **handshake deadline** on the accepted socket itself, so a socket that
 *   sends *nothing at all* — which never reaches the stall deadline, because
 *   there is no half-received frame to track — gives its slot back too.
 * - an **inbound connection cap**, so the per-connection cost cannot simply be
 *   multiplied by opening sockets in a loop.
 *
 * The tests drive `TcpTransport`'s private socket callbacks with mock sockets,
 * the same way the hijack and crossing-dial tests in
 * `tests/multi-node/cluster-security.test.ts` do — the guards live in those
 * callbacks, and a real listener would only add a port to collide on.
 */
import { describe, expect, test } from 'bun:test';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { Logger } from '../../../src/Logger.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import {
  HANDSHAKE_TIMEOUT_MS,
  INCOMPLETE_FRAME_IDLE_MS,
  MAX_INBOUND_CONNECTIONS,
} from '../../../src/cluster/Constants.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { DEFAULT_MAX_FRAME_BYTES, encodeFrame } from '../../../src/cluster/Protocol.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
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

/** The slice of a `Connection` these tests assert on. */
type TrackedConnection = {
  incompleteFrameTimer: unknown;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * Collects what the transport logged, so a guard whose only distinguishable
 * effect is the number in its WARN can still be asserted on (#846).
 */
class CapturingLogger implements Logger {
  readonly level = LogLevel.Warn;
  readonly warnings: string[] = [];
  debug(_message: string, ..._args: unknown[]): void {}
  info(_message: string, ..._args: unknown[]): void {}
  warn(message: string, ..._args: unknown[]): void { this.warnings.push(message); }
  error(_message: string, ..._args: unknown[]): void {}
  withSource(_source: string): Logger { return this; }
  withFields(_fields: Record<string, unknown>): Logger { return this; }
}

/** The private socket callbacks and bookkeeping these tests reach through. */
interface TransportInternals {
  attachInbound(socket: unknown): void;
  onData(socket: unknown, chunk: Uint8Array): void;
  onClose(socket: unknown): void;
  onIncompleteFrameTimeout(connection: object): void;
  onHandshakeTimeout(connection: object): void;
  readonly inboundConnections: number;
  readonly bySocket: WeakMap<object, TrackedConnection>;
  readonly byPeer: Map<string, { readonly pending: readonly WireMessage[] }>;
}

function internals(transport: TcpTransport): TransportInternals {
  return transport as unknown as TransportInternals;
}

/**
 * Fire a connection's handshake deadline the way the runtime would, and cancel
 * the real timer behind it so the callback cannot run a second time after the
 * test that provoked it has finished.
 */
function fireHandshakeDeadline(transport: TcpTransport, connection: TrackedConnection): void {
  expect(connection.handshakeTimer).not.toBeNull();
  clearTimeout(connection.handshakeTimer as ReturnType<typeof setTimeout>);
  internals(transport).onHandshakeTimeout(connection);
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

describe('an inbound socket that never speaks does not keep its slot', () => {
  test('exploit: a socket that sends not one byte is on a handshake deadline', () => {
    // The cheapest attack on the cap there is: connect, send nothing, repeat.
    // `trackIncompleteFrame` is reached only from `onData` and returns at once
    // when no bytes are pending, so the stall deadline covers none of this —
    // the accepted socket needs a deadline of its own.
    const transport = newTransport(19_301);
    const socket = mockSocket();
    internals(transport).attachInbound(socket);

    const connection = internals(transport).bySocket.get(socket)!;
    expect(connection.incompleteFrameTimer).toBeNull();
    expect(internals(transport).inboundConnections).toBe(1);

    fireHandshakeDeadline(transport, connection);
    expect(socket.ended).toBe(true);
    expect(internals(transport).inboundConnections).toBe(0);
  });

  test('exploit: silent sockets can no longer saturate the cap for good', () => {
    const transport = newTransport(19_302);
    const silent: MockSocket[] = [];
    for (let index = 0; index < MAX_INBOUND_CONNECTIONS; index += 1) {
      const socket = mockSocket();
      internals(transport).attachInbound(socket);
      silent.push(socket);
    }
    // Not one byte was sent on any of them, and the cap is full: a legitimate
    // peer dialling now is refused, which is a partition rather than a defence.
    const refused = mockSocket();
    internals(transport).attachInbound(refused);
    expect(refused.ended).toBe(true);

    for (const socket of silent) {
      fireHandshakeDeadline(transport, internals(transport).bySocket.get(socket)!);
    }
    expect(internals(transport).inboundConnections).toBe(0);

    const admitted = mockSocket();
    internals(transport).attachInbound(admitted);
    expect(admitted.ended).toBe(false);
    expect(internals(transport).inboundConnections).toBe(1);
  });

  test('a socket whose data beat its open callback is on a deadline too', () => {
    // Bun's `data`-before-`open` route builds the Connection in `onData`, and a
    // deadline armed only on the `onOpen` route would leave that one uncovered.
    const transport = newTransport(19_303);
    const socket = mockSocket();

    internals(transport).onData(socket, partialHello(3));
    expect(internals(transport).bySocket.get(socket)?.handshakeTimer).not.toBeNull();
  });

  test('a peer that completes its hello is off the deadline for good', () => {
    // The bound is on the *handshake*, not on the connection: an established
    // inbound peer that then falls quiet — which is every peer between two
    // gossip rounds — must never be dropped for it.
    const transport = newTransport(19_304);
    const socket = mockSocket();
    internals(transport).attachInbound(socket);

    internals(transport).onData(socket, encodeFrame({
      kind: 'hello',
      self: new NodeAddress('inbound-guards', '10.0.0.11', 2_552).toJSON(),
    }));

    const connection = internals(transport).bySocket.get(socket)!;
    expect(connection.handshakeTimer).toBeNull();
    expect(socket.writes).toHaveLength(1);   // the hello-ack
    expect(socket.ended).toBe(false);

    // And a deadline that had already been handed to the runtime when the hello
    // landed finds nothing left to do.
    internals(transport).onHandshakeTimeout(connection);
    expect(socket.ended).toBe(false);
    expect(internals(transport).inboundConnections).toBe(1);
  });

  test('a slow peer still trickling its hello keeps its connection', () => {
    // The deadline is armed once, at accept — so a hello arriving byte by byte
    // over a congested link is exactly the case that must survive it.  What
    // covers those bytes is the stall deadline, re-armed on every chunk.
    const transport = newTransport(19_305);
    const socket = mockSocket();
    internals(transport).attachInbound(socket);

    const frame = encodeFrame({
      kind: 'hello',
      self: new NodeAddress('inbound-guards', '10.0.0.12', 2_552).toJSON(),
    });
    for (let index = 0; index < frame.byteLength; index += 1) {
      internals(transport).onData(socket, frame.subarray(index, index + 1));
    }

    expect(socket.ended).toBe(false);
    expect(internals(transport).bySocket.get(socket)?.handshakeTimer).toBeNull();
  });

  test('shutdown leaves no un-handshaken inbound socket behind', async () => {
    // `shutdown` walks `byPeer`, which a connection still mid-handshake has not
    // entered — so this deadline is the only thing that ever closes that socket.
    const transport = newTransport(19_306);
    const socket = mockSocket();
    internals(transport).attachInbound(socket);

    await transport.shutdown();
    fireHandshakeDeadline(transport, internals(transport).bySocket.get(socket)!);
    expect(socket.ended).toBe(true);
    expect(internals(transport).inboundConnections).toBe(0);
  });

  test('the accepting side is no stricter than the dialling side already is', () => {
    // Both ends bound the same handshake, and the dialler starts its clock
    // before the TCP connect and the TLS handshake while this one starts after
    // the accept — so a peer that is still trying has always given up first.
    expect(HANDSHAKE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(INCOMPLETE_FRAME_IDLE_MS).toBeGreaterThan(HANDSHAKE_TIMEOUT_MS);
  });
});

/**
 * #846 — the same four bounds, now settable.
 *
 * The block above proves each guard fires; this one proves each guard fires on
 * the number the *deployment* named rather than on the module constant.  That
 * distinction is invisible to every test above — they all run an unconfigured
 * transport, where the two numbers are equal by construction — so a wiring that
 * accepted the option and went on reading the constant would pass all twenty of
 * them.
 *
 * Where a bound has no directly observable side effect at a distinct value
 * (a deadline's *duration* is not readable off a `setTimeout` handle), the
 * assertion is on the WARN the guard emits: each one interpolates the number it
 * enforced, so a stale read shows up as the shipped default in the message.
 */
describe('the association-lifecycle bounds are configurable (#846)', () => {
  test('the inbound cap is the configured one, not the shipped one', () => {
    const transport = new TcpTransport(
      new NodeAddress('inbound-guards', '127.0.0.1', 19_401),
      new NoopLogger(),
      { maxInboundConnections: 3 },
    );
    const accepted: MockSocket[] = [];
    for (let index = 0; index < 3; index += 1) {
      const socket = mockSocket();
      internals(transport).attachInbound(socket);
      accepted.push(socket);
    }
    expect(internals(transport).inboundConnections).toBe(3);
    expect(accepted.every((socket) => !socket.ended)).toBe(true);

    const refused = mockSocket();
    internals(transport).attachInbound(refused);
    expect(refused.ended).toBe(true);
    expect(internals(transport).inboundConnections).toBe(3);
  });

  test('the outbound queue holds the configured number of frames, dropping oldest', async () => {
    // 19_499 is deliberately not listened on: the dial this `send` starts fails
    // on a later tick, well after the three synchronous buffer writes below.
    const transport = new TcpTransport(
      new NodeAddress('inbound-guards', '127.0.0.1', 19_402),
      new NoopLogger(),
      { outboundQueueSize: 2 },
    );
    const peer = new NodeAddress('unreachable-peer', '127.0.0.1', 19_499);
    try {
      transport.send(peer, { kind: 'hello', self: peer.toJSON() });
      transport.send(peer, { kind: 'hello-ack', self: peer.toJSON() });
      transport.send(peer, { kind: 'heartbeat', from: peer.toJSON(), seq: 1, ts: 1 });

      const pending = internals(transport).byPeer.get(peer.toString())?.pending ?? [];
      // Two, not three, and the *first* is the one that went: the newest
      // membership and heartbeat state is the state worth keeping.
      expect(pending.map((message) => message.kind)).toEqual(['hello-ack', 'heartbeat']);
    } finally {
      await transport.shutdown();
    }
  });

  test('the handshake deadline that fires is the configured one', () => {
    const log = new CapturingLogger();
    const transport = new TcpTransport(
      new NodeAddress('inbound-guards', '127.0.0.1', 19_403),
      log,
      { handshakeTimeoutMs: 250, incompleteFrameIdleMs: 900 },
    );
    const socket = mockSocket();
    internals(transport).attachInbound(socket);

    fireHandshakeDeadline(transport, internals(transport).bySocket.get(socket)!);

    expect(socket.ended).toBe(true);
    // The message names the deadline it enforced, so this fails loudly against
    // a transport that took the option and kept reading HANDSHAKE_TIMEOUT_MS.
    expect(log.warnings.join('\n')).toContain('sent no hello within 250 ms');
    expect(log.warnings.join('\n')).not.toContain(`${HANDSHAKE_TIMEOUT_MS} ms`);
  });

  test('the stall deadline that fires is the configured one', () => {
    const log = new CapturingLogger();
    const transport = new TcpTransport(
      new NodeAddress('inbound-guards', '127.0.0.1', 19_404),
      log,
      { incompleteFrameIdleMs: 1_500 },
    );
    const socket = mockSocket();
    internals(transport).attachInbound(socket);
    internals(transport).onData(socket, partialHello(3));

    const connection = internals(transport).bySocket.get(socket)!;
    clearTimeout(connection.incompleteFrameTimer as ReturnType<typeof setTimeout>);
    internals(transport).onIncompleteFrameTimeout(connection);

    expect(socket.ended).toBe(true);
    expect(log.warnings.join('\n')).toContain('for 1500 ms');
    expect(log.warnings.join('\n')).not.toContain(`${INCOMPLETE_FRAME_IDLE_MS} ms`);
  });

  test('an unconfigured transport still enforces the shipped bounds', () => {
    // The control case.  Without it the four above would pass just as happily
    // if the constants had been dropped and every default become the option's
    // own — which is the shape in which "configurable" silently moves a bound.
    const transport = newTransport(19_405);
    const log = new CapturingLogger();
    const defaulted = new TcpTransport(
      new NodeAddress('inbound-guards', '127.0.0.1', 19_406),
      log,
    );
    const socket = mockSocket();
    internals(defaulted).attachInbound(socket);
    fireHandshakeDeadline(defaulted, internals(defaulted).bySocket.get(socket)!);

    expect(log.warnings.join('\n')).toContain(`sent no hello within ${HANDSHAKE_TIMEOUT_MS} ms`);
    expect(transport.maxFrameBytes).toBe(DEFAULT_MAX_FRAME_BYTES);
  });

  test('a stall deadline at or below the handshake deadline is refused at construction', () => {
    // The one cross-field rule, and it is not decoration: a socket that sends
    // nothing at all never reaches the stall deadline, so the handshake timer
    // is the only thing that reclaims it.  Inverting the two swaps their roles
    // for a peer that sends three bytes and stops.
    const address = new NodeAddress('inbound-guards', '127.0.0.1', 19_407);
    expect(() => new TcpTransport(address, new NoopLogger(), {
      handshakeTimeoutMs: 5_000,
      incompleteFrameIdleMs: 5_000,
    })).toThrow(OptionsError);
    expect(() => new TcpTransport(address, new NoopLogger(), {
      handshakeTimeoutMs: 5_000,
      incompleteFrameIdleMs: 1_000,
    })).toThrow(/must be greater than handshakeTimeoutMs/);
    // Each alone is fine: the unset half falls through to a default the set
    // half clears.
    expect(() => new TcpTransport(address, new NoopLogger(), { handshakeTimeoutMs: 1_000 }))
      .not.toThrow();
  });

  test('none of the four has an "off" spelling', () => {
    // `0` is a distinct way of breaking the node for each: no handshake window,
    // no room to buffer a send racing the handshake, no inbound connection
    // admitted, no connection allowed to end off a frame boundary.
    const address = new NodeAddress('inbound-guards', '127.0.0.1', 19_408);
    for (const options of [
      { handshakeTimeoutMs: 0 },
      { outboundQueueSize: 0 },
      { maxInboundConnections: 0 },
      { incompleteFrameIdleMs: 0 },
    ]) {
      expect(() => new TcpTransport(address, new NoopLogger(), options)).toThrow(OptionsError);
    }
  });
});
