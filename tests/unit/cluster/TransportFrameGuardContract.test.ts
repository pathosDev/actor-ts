/**
 * The `Transport` contract's inbound guard, asserted against **every**
 * implementation from one corpus (#945).
 *
 * `InMemoryTransport`'s own comment already stated the rule — the guarantee
 * "belongs to the `Transport` contract and not to one implementation of it" —
 * and two of the three implementations kept it.  The third,
 * `MessageChannelTransport`, is the one `WorkerNode` uses in production, and it
 * had neither the frame guard nor the try/catch: every property #563, #705 and
 * #711 established for the cluster wire was absent on the multi-core path, and
 * a `MessagePort`'s `onmessage` callback has no caller to unwind into, so one
 * posted frame was an uncaught top-level error that took the host thread and
 * every sibling worker with it.
 *
 * A per-implementation test would not have caught that, because each of the two
 * that were right had one.  What was missing is the comparison, so this file is
 * written as one table of arms over one corpus: adding a fourth `Transport`
 * means adding an arm, and an arm that skips the guard fails here rather than
 * in production.
 *
 * The three arms are driven through each transport's *own* inbound seam — a
 * decoded TCP chunk, the registry's microtask, a posted `MessagePort` message —
 * and not through a shared helper, because a shared helper is precisely the
 * thing that does not exist in `src/` and whose absence is the defect.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { NoopLogger } from '../../../src/Logger.js';
import { MAX_KNOWN_CHANNEL_PEERS } from '../../../src/cluster/Constants.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame, type WireMessage } from '../../../src/cluster/Protocol.js';
import {
  InMemoryTransport,
  TcpTransport,
  type WireHandler,
} from '../../../src/cluster/Transport.js';
import { MessageChannelTransport } from '../../../src/cluster/transports/MessageChannelTransport.js';
import { hostileEnvelopes, hostileWirePayloads } from '../../util/HostileFrames.js';
import { FakePort } from '../worker/__fixtures__/InMemoryWorkerThread.js';

const SYSTEM = 'frame-guard';

/** Synthetic, never bound: no arm opens a socket or a real channel. */
let nextPort = 30_000;
const freshAddress = (): NodeAddress => {
  nextPort += 1;
  return new NodeAddress(SYSTEM, '127.0.0.1', nextPort);
};

/** The private socket callbacks the `TcpTransport` arm reaches through. */
interface TcpTransportInternals {
  attachInbound(socket: unknown): void;
  onData(socket: unknown, chunk: Uint8Array): void;
}

function mockSocket(): { writes: Uint8Array[]; write(data: Uint8Array): void; end(): void } {
  return {
    writes: [],
    write(data: Uint8Array): void { this.writes.push(data); },
    end(): void { /* nothing holds this socket */ },
  };
}

/**
 * One transport's inbound edge, opened with a handler installed.
 *
 * `deliver` is synchronous because two of the three seams are: an escaping
 * throw is what this file is about, and only a synchronous call can be watched
 * for one.  `settle` is the seam's own asynchrony — a microtask for
 * `InMemoryTransport`, nothing for the other two.
 */
type InboundEdge = {
  readonly deliver: (payload: unknown) => void;
  readonly settle: () => Promise<void>;
  readonly close: () => Promise<void>;
};

/**
 * A `Transport` implementation plus how to push a frame at it the way its own
 * peer would.  `open` is a function-typed property, not a contract someone
 * implements, so this is a `type`.
 */
type TransportArm = {
  readonly name: string;
  readonly open: (handler: WireHandler) => Promise<InboundEdge>;
  /**
   * Whether the edge still delivers after a handler threw on it.
   *
   * The one place the three legitimately diverge, and the divergence is the
   * point rather than an inconsistency: `TcpTransport` has a socket, so a
   * handler it does not understand costs the peer its connection, deliberately
   * (#563).  The other two have nothing to close, so "mirrors dropping the
   * connection" can only mean dropping the frame — closing anything there
   * would mean tearing down the whole registry or the whole `MessagePort` over
   * one frame.  What is *not* negotiable, and is asserted for all three, is
   * that the throw never leaves the seam.
   */
  readonly keepsTheEdgeAfterAThrow: boolean;
};

const tcpArm: TransportArm = {
  name: 'TcpTransport',
  open: async (handler) => {
    const transport = new TcpTransport(freshAddress(), new NoopLogger());
    transport.setHandler(handler);
    const socket = mockSocket();
    const internals = transport as unknown as TcpTransportInternals;
    internals.attachInbound(socket);
    // The handshake matters: below it every frame is refused for being
    // pre-`hello`, so without it the corpus would pass against a transport
    // with no guard at all.
    internals.onData(socket, encodeFrame({ kind: 'hello', self: freshAddress().toJSON() }));
    return {
      deliver: (payload) => internals.onData(socket, encodeFrame(payload as WireMessage)),
      settle: async () => { /* `onData` dispatches inline */ },
      close: async () => { await transport.shutdown(); },
    };
  },
  keepsTheEdgeAfterAThrow: false,
};

const inMemoryArm: TransportArm = {
  name: 'InMemoryTransport',
  open: async (handler) => {
    const victim = new InMemoryTransport(freshAddress());
    victim.setHandler(handler);
    await victim.start();
    const attacker = new InMemoryTransport(freshAddress());
    await attacker.start();
    return {
      deliver: (payload) => attacker.send(victim.self, payload as WireMessage),
      // `send` defers through `queueMicrotask`, so a throw here surfaces as a
      // top-level error rather than out of `deliver` — which is why the
      // portable half of the contract is "the handler was not called".
      settle: () => Promise.resolve(),
      close: async () => { await attacker.shutdown(); await victim.shutdown(); },
    };
  },
  keepsTheEdgeAfterAThrow: true,
};

const messageChannelArm: TransportArm = {
  name: 'MessageChannelTransport',
  open: async (handler) => {
    const self = freshAddress();
    const peer = freshAddress();
    const port = new FakePort();
    const transport = new MessageChannelTransport(self, port);
    transport.setHandler(handler);
    await transport.start();
    return {
      deliver: (payload) => port.inject({ from: peer.toJSON(), to: self.toJSON(), payload }),
      settle: async () => { /* `onmessage` dispatches inline */ },
      close: async () => { await transport.shutdown(); },
    };
  },
  keepsTheEdgeAfterAThrow: true,
};

const arms: ReadonlyArray<TransportArm> = [tcpArm, inMemoryArm, messageChannelArm];

/** A frame every arm must deliver, so "not delivered" means something. */
const wellFormedFrame = (from: NodeAddress): WireMessage => ({
  kind: 'heartbeat', from: from.toJSON(), seq: 1, ts: 0,
});

let open: InboundEdge[] = [];

afterEach(async () => {
  // `InMemoryTransport.registry` is static and shared across the whole run, so
  // an arm left open shows up as a stray peer in unrelated suites.
  for (const edge of open) await edge.close();
  open = [];
});

async function openEdge(arm: TransportArm, handler: WireHandler): Promise<InboundEdge> {
  const edge = await arm.open(handler);
  open.push(edge);
  return edge;
}

for (const arm of arms) {
  describe(`${arm.name} — the inbound guard`, () => {
    test('delivers a well-formed frame, so a missing delivery below is evidence', async () => {
      const received: WireMessage[] = [];
      const edge = await openEdge(arm, (_from, message) => received.push(message));

      edge.deliver(wellFormedFrame(freshAddress()));
      await edge.settle();

      expect(received.length).toBe(1);
      expect(received[0]!.kind).toBe('heartbeat');
    });

    for (const [label, frame] of hostileWirePayloads) {
      test(`drops ${label} without reaching the handler`, async () => {
        const received: WireMessage[] = [];
        const edge = await openEdge(arm, (_from, message) => received.push(message));

        expect(() => edge.deliver(frame)).not.toThrow();
        await edge.settle();

        expect(received).toEqual([]);
      });
    }

    test('a hostile frame does not cost the next well-formed one', async () => {
      const received: WireMessage[] = [];
      const edge = await openEdge(arm, (_from, message) => received.push(message));

      for (const [, frame] of hostileWirePayloads) edge.deliver(frame);
      edge.deliver(wellFormedFrame(freshAddress()));
      await edge.settle();

      expect(received.length).toBe(1);
    });

    /**
     * The third tier.  A handler that throws is a problem the transport does
     * not understand, and the one thing it must not become is the seam's
     * problem: the two callback-driven transports have nowhere for the throw
     * to go at all, and `TcpTransport` would lose the socket callback it is
     * standing in.
     */
    test('a throwing handler does not escape the seam', async () => {
      const received: WireMessage[] = [];
      let thrown = 0;
      const edge = await openEdge(arm, (_from, message) => {
        if (thrown === 0) { thrown += 1; throw new Error('handler exploded'); }
        received.push(message);
      });

      expect(() => edge.deliver(wellFormedFrame(freshAddress()))).not.toThrow();
      await edge.settle();
      expect(thrown).toBe(1);

      // What happens *after* is `keepsTheEdgeAfterAThrow`'s business — see the
      // field.  Asserting it either way is what keeps this from being a test
      // that would pass against a transport that silently stopped delivering.
      edge.deliver(wellFormedFrame(freshAddress()));
      await edge.settle();
      expect(received.length).toBe(arm.keepsTheEdgeAfterAThrow ? 1 : 0);
    });
  });
}

/* ------------------------------------------------------------------------ */
/* MessageChannelTransport only — the envelope around the payload            */
/* ------------------------------------------------------------------------ */

describe('MessageChannelTransport — the posted envelope', () => {
  /**
   * The other two arms have no envelope: a TCP frame is its own payload and
   * the in-memory registry passes a `NodeAddress` object.  Here the payload
   * arrives wrapped, and `from` is dereferenced the instant it does — which
   * makes this transport the only one that owes an answer to the corpus the
   * two brokers already run (#701).
   *
   * Running it here is not redundant with the brokers.  A broker in front
   * drops these first, but this class is exported package surface and two
   * transports can be wired port-to-port with nothing between them — the shape
   * `worker-mesh.mdx` documents for manual wiring, and the shape this
   * transport's own integration suite uses.
   */
  for (const [label, envelope] of hostileEnvelopes) {
    test(`drops an envelope with ${label} without reaching the handler`, async () => {
      const port = new FakePort();
      const transport = new MessageChannelTransport(freshAddress(), port);
      const received: WireMessage[] = [];
      transport.setHandler((_from, message) => received.push(message));
      await transport.start();

      expect(() => port.inject(envelope)).not.toThrow();

      expect(received).toEqual([]);
      await transport.shutdown();
    });
  }

  test('an envelope whose `from` carries an over-long incarnation is dropped', async () => {
    // The one case that proves `isBrokeredMessage` and `NodeAddress.fromJSON`
    // agree rather than merely overlapping: `incarnation` is optional, so a
    // guard that forgot it would pass the envelope on to a `fromJSON` that
    // throws — back inside the callback this whole file exists to keep clean.
    const self = freshAddress();
    const peer = freshAddress();
    const port = new FakePort();
    const transport = new MessageChannelTransport(self, port);
    const received: WireMessage[] = [];
    transport.setHandler((_from, message) => received.push(message));
    await transport.start();

    expect(() => port.inject({
      from: { ...peer.toJSON(), incarnation: 'x'.repeat(1_000) },
      to: self.toJSON(),
      payload: wellFormedFrame(peer),
    })).not.toThrow();

    expect(received).toEqual([]);
    await transport.shutdown();
  });
});

/* ------------------------------------------------------------------------ */
/* MessageChannelTransport only — `knownPeers` is bounded                    */
/* ------------------------------------------------------------------------ */

describe('MessageChannelTransport — the known-peer set is bounded', () => {
  /**
   * `peers()` is built from a set that gained an entry per distinct `from` and
   * never lost one: a broker model owns no per-peer connection, so there is no
   * close event to prune on.  One `postMessage` per address was one permanent
   * entry.
   */
  async function floodDistinctPeers(count: number): Promise<MessageChannelTransport> {
    const self = freshAddress();
    const port = new FakePort();
    const transport = new MessageChannelTransport(self, port);
    transport.setHandler(() => {});
    await transport.start();
    for (let i = 0; i < count; i += 1) {
      const peer = new NodeAddress(SYSTEM, '10.0.0.1', 1_000 + i);
      port.inject({ from: peer.toJSON(), to: self.toJSON(), payload: wellFormedFrame(peer) });
    }
    return transport;
  }

  test(`stops growing at ${MAX_KNOWN_CHANNEL_PEERS} distinct senders`, async () => {
    const transport = await floodDistinctPeers(MAX_KNOWN_CHANNEL_PEERS + 200);
    expect(transport.peers().length).toBe(MAX_KNOWN_CHANNEL_PEERS);
    await transport.shutdown();
  });

  test('an established peer keeps its slot once the cap is full', async () => {
    // The half that decides between capping and evicting.  `peers()` has one
    // reader — the readiness check — and it reports the node NOT ready unless
    // an expected member is still listed, so evicting the oldest would let a
    // flood of strangers take a healthy node out of its load balancer.
    const self = freshAddress();
    const port = new FakePort();
    const transport = new MessageChannelTransport(self, port);
    transport.setHandler(() => {});
    await transport.start();

    const established = new NodeAddress(SYSTEM, '10.0.0.2', 4_242);
    port.inject({
      from: established.toJSON(), to: self.toJSON(), payload: wellFormedFrame(established),
    });

    for (let i = 0; i < MAX_KNOWN_CHANNEL_PEERS + 200; i += 1) {
      const stranger = new NodeAddress(SYSTEM, '10.0.0.3', 1_000 + i);
      port.inject({
        from: stranger.toJSON(), to: self.toJSON(), payload: wellFormedFrame(stranger),
      });
    }

    const listed = transport.peers().map((peer) => peer.toString());
    expect(listed).toContain(established.toString());
    expect(listed.length).toBe(MAX_KNOWN_CHANNEL_PEERS);
    await transport.shutdown();
  });

  test('a frame from a stranger is still delivered after the cap fills', async () => {
    // The cap bounds the bookkeeping, never the traffic: refusing frames once
    // the set filled would trade a memory leak for a denial of service.
    const self = freshAddress();
    const port = new FakePort();
    const transport = new MessageChannelTransport(self, port);
    const received: WireMessage[] = [];
    transport.setHandler((_from, message) => received.push(message));
    await transport.start();

    for (let i = 0; i < MAX_KNOWN_CHANNEL_PEERS; i += 1) {
      const peer = new NodeAddress(SYSTEM, '10.0.0.4', 1_000 + i);
      port.inject({ from: peer.toJSON(), to: self.toJSON(), payload: wellFormedFrame(peer) });
    }
    received.length = 0;

    const late = new NodeAddress(SYSTEM, '10.0.0.5', 9_999);
    port.inject({ from: late.toJSON(), to: self.toJSON(), payload: wellFormedFrame(late) });

    expect(received.length).toBe(1);
    expect(transport.peers().some((peer) => peer.equals(late))).toBe(false);
    await transport.shutdown();
  });
});
