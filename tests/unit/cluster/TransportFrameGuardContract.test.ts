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
import type { Clock } from '../../../src/Clock.js';
import { NoopLogger, type Logger } from '../../../src/Logger.js';
import { DEFAULT_DROP_REPORT_INTERVAL_MS } from '../../../src/util/Constants.js';
import { transportReachesCluster } from '../../../src/cluster/ClusterHealthChecks.js';
import { MAX_KNOWN_CHANNEL_PEERS } from '../../../src/cluster/Constants.js';
import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame, type WireMessage } from '../../../src/cluster/Protocol.js';
import {
  InMemoryTransport,
  TcpTransport,
  type WireHandler,
} from '../../../src/cluster/Transport.js';
import { MessageChannelTransport } from '../../../src/cluster/transports/MessageChannelTransport.js';
import { hostileEnvelopes, hostileWirePayloads } from '../../util/HostileFrames.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';
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
   * one frame.  What is *not* negotiable is that the throw never leaves the
   * seam — required of all three, though **not asserted the same way for all
   * three**: see the in-memory arm's `settle`.
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
      // `send` defers through `queueMicrotask` (`Transport.ts`), so nothing
      // this arm does can throw out of `deliver`.  Two consequences, and the
      // second is the one worth being honest about.
      //
      // The **drop** half is unaffected: `expect(received).toEqual([])` after
      // `settle` is a real assertion, and the `not.toThrow()` wrapper around
      // `deliver` above is vacuous *for this arm only* — kept because it is the
      // whole assertion for the other two, where `deliver` is synchronous.
      //
      // The **containment** half rests on the runner rather than on an
      // `expect`.  An escaping throw is an unhandled error inside a microtask,
      // and bun attributes it to the running test — verified by deleting the
      // guard in `InMemoryTransport.send` and watching 'a throwing handler does
      // not escape the seam' fail with `handler exploded`.  That is a real
      // mechanism, but it is the runner's and not this file's, so a runner that
      // swallowed it would leave this arm silently unchecked.
      //
      // An uncaught-error trap here would make it an assertion, and on bun
      // 1.4.2 it cannot: measured, a throw escaping a `queueMicrotask` reaches
      // *none* of `process.on('uncaughtException')`,
      // `globalThis.addEventListener('error')` or `globalThis.onerror` — the
      // test runner intercepts it first and fails the test.  There is nothing
      // left to install the trap on, so this is stated rather than closed
      // (#1515).
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
    const transport = new MessageChannelTransport(self, port, new NoopLogger());
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
      const transport = new MessageChannelTransport(freshAddress(), port, new NoopLogger());
      const received: WireMessage[] = [];
      transport.setHandler((_from, message) => received.push(message));
      await transport.start();

      expect(() => port.inject(envelope)).not.toThrow();

      expect(received).toEqual([]);
      await transport.shutdown();
    });
  }

  test('an envelope whose `from` answers the guard and `fromJSON` differently is dropped', async () => {
    // The guard reads `from.port` and `NodeAddress.fromJSON` reads it again, so
    // an accessor that answers differently on the two reads passes the guard
    // and then throws out of `fromJSON` — back into the `onmessage` callback
    // this whole file exists to keep clean, and *outside* the try/catch, which
    // only ever wrapped the handler.
    //
    // A real `MessagePort` structured-clones the envelope, which strips
    // accessors, so this is not reachable across a thread boundary.  It is
    // reachable through an in-process `PortLike`, which is what the testkit's
    // broker, the mesh's own fixtures and any port-to-port wiring use — and
    // `MessageChannelTransport` is exported package surface that takes any
    // `PortLike` at all.  Found while binding #1515's port rule.
    const self = freshAddress();
    const peer = freshAddress();
    let reads = 0;
    const shiftyFrom = {
      systemName: peer.systemName,
      host: peer.host,
      get port(): number { reads += 1; return reads === 1 ? peer.port : 1e21; },
    };
    const port = new FakePort();
    const transport = new MessageChannelTransport(self, port, new NoopLogger());
    const received: WireMessage[] = [];
    transport.setHandler((_from, message) => received.push(message));
    await transport.start();

    expect(() => port.inject({
      from: shiftyFrom, to: self.toJSON(), payload: wellFormedFrame(peer),
    })).not.toThrow();

    expect(received).toEqual([]);
    expect(transport.peers()).toEqual([]);

    // And the edge still works afterwards — a contained refusal, not a dead port.
    const honest = freshAddress();
    port.inject({ from: honest.toJSON(), to: self.toJSON(), payload: wellFormedFrame(honest) });
    expect(received.length).toBe(1);

    await transport.shutdown();
  });

  test('an envelope whose `from` carries an over-long incarnation is dropped', async () => {
    // The one case that proves `isBrokeredMessage` and `NodeAddress.fromJSON`
    // agree rather than merely overlapping: `incarnation` is optional, so a
    // guard that forgot it would pass the envelope on to a `fromJSON` that
    // throws — back inside the callback this whole file exists to keep clean.
    const self = freshAddress();
    const peer = freshAddress();
    const port = new FakePort();
    const transport = new MessageChannelTransport(self, port, new NoopLogger());
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
    const transport = new MessageChannelTransport(self, port, new NoopLogger());
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
    const transport = new MessageChannelTransport(self, port, new NoopLogger());
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

  /**
   * What the cap counts, and — just as much — what that does *not* buy.
   *
   * `onFrame` validates the payload *before* it records the sender, so a peer
   * that never sends a frame the wire schema accepts never earns a slot.  With
   * the two steps the other way round the set would count anything that clears
   * the envelope guard, which is cheaper still.
   *
   * It is worth being exact about what the ordering closes, because the first
   * version of this comment was not.  It keeps *garbage* out of the map.  It
   * does **not** make the map hard to fill: a schema-valid heartbeat under an
   * invented `from` costs a stranger nothing, and a thousand of them fill the
   * cap — after which a genuine peer arriving late is never listed and the
   * readiness check reports this node unready against it for the life of the
   * process (asserted below).  The cap and the ordering are two mechanisms
   * answering two questions: the ordering decides what counts as a sender, the
   * cap decides how many are remembered, and neither makes the other
   * unnecessary or sufficient.
   */
  test('a sender whose payload is refused never earns a place in the set', async () => {
    const self = freshAddress();
    const port = new FakePort();
    const transport = new MessageChannelTransport(self, port, new NoopLogger());
    const received: WireMessage[] = [];
    transport.setHandler((_from, message) => received.push(message));
    await transport.start();

    // A well-formed envelope — it clears `isBrokeredMessage`, so the address is
    // readable and recording it would succeed — around a payload the wire
    // schema refuses.  #563's poisoned gossip status, i.e. a frame a peer can
    // post at will.
    const stranger = new NodeAddress(SYSTEM, '10.0.0.6', 7_777);
    port.inject({
      from: stranger.toJSON(),
      to: self.toJSON(),
      payload: {
        kind: 'gossip',
        from: stranger.toJSON(),
        sequence: 1,
        members: [{ address: freshAddress().toJSON(), status: 'pwned', version: 1 }],
      },
    });

    expect(received).toEqual([]);
    expect(transport.peers()).toEqual([]);

    // The other half: a transport that recorded nobody at all would satisfy the
    // assertion above and be broken, so the same sender is admitted the moment
    // it says something legal.
    port.inject({
      from: stranger.toJSON(), to: self.toJSON(), payload: wellFormedFrame(stranger),
    });
    expect(received.length).toBe(1);
    expect(transport.peers().map((peer) => peer.toString())).toEqual([stranger.toString()]);

    await transport.shutdown();
  });

  /**
   * The cap's mirror failure, named rather than merely observed.
   *
   * Refusing the newest is the right half of the trade — see
   * {@link MAX_KNOWN_CHANNEL_PEERS} — but it is a trade, and this is the side
   * it costs: a peer whose first valid frame arrives after the set is full is
   * **never listed**, nothing ever removes an entry, and `peers()` has one
   * reader that cares.  `transportReachesCluster` reports the node not ready
   * unless an expected member is still named there, so a set filled ahead of a
   * legitimate peer keeps that node out of its load balancer for the life of
   * the process.  The frames themselves keep arriving throughout, which is why
   * this is a readiness failure and not a delivery one.
   *
   * Asserting it here is what makes a later move to eviction or pruning
   * re-argue the trade instead of silently reversing it.
   */
  test('a frame from a stranger is still delivered after the cap fills, but the stranger is never ready', async () => {
    // The cap bounds the bookkeeping, never the traffic: refusing frames once
    // the set filled would trade a memory leak for a denial of service.
    const self = freshAddress();
    const port = new FakePort();
    const transport = new MessageChannelTransport(self, port, new NoopLogger());
    const received: WireMessage[] = [];
    transport.setHandler((_from, message) => received.push(message));
    await transport.start();

    // The control: an established peer, recorded before the flood, and the
    // reason the readiness assertion below means anything.
    const established = new NodeAddress(SYSTEM, '10.0.0.7', 8_888);
    port.inject({
      from: established.toJSON(), to: self.toJSON(), payload: wellFormedFrame(established),
    });

    for (let i = 0; i < MAX_KNOWN_CHANNEL_PEERS; i += 1) {
      const peer = new NodeAddress(SYSTEM, '10.0.0.4', 1_000 + i);
      port.inject({ from: peer.toJSON(), to: self.toJSON(), payload: wellFormedFrame(peer) });
    }
    received.length = 0;

    const late = new NodeAddress(SYSTEM, '10.0.0.5', 9_999);
    port.inject({ from: late.toJSON(), to: self.toJSON(), payload: wellFormedFrame(late) });

    expect(received.length).toBe(1);
    expect(transport.peers().some((peer) => peer.equals(late))).toBe(false);

    // …and 100 more frames do not change that: nothing retries a refused slot.
    for (let i = 0; i < 100; i += 1) {
      port.inject({ from: late.toJSON(), to: self.toJSON(), payload: wellFormedFrame(late) });
    }
    expect(received.length).toBe(101);
    expect(transport.peers().some((peer) => peer.equals(late))).toBe(false);

    // The consequence, in the one reader that has it: not ready against the
    // late peer, ready against the established one, on the same `peers()`.
    const listed = transport.peers();
    expect(transportReachesCluster(
      [new Member(self, 'up', 1), new Member(late, 'up', 1)], self, listed,
    )).toBe(false);
    expect(transportReachesCluster(
      [new Member(self, 'up', 1), new Member(established, 'up', 1)], self, listed,
    )).toBe(true);

    await transport.shutdown();
  });
});

/* ------------------------------------------------------------------------ */
/* MessageChannelTransport only — a drop is counted and reported (#1515)     */
/* ------------------------------------------------------------------------ */

/**
 * The half `TcpTransport` always had and this transport never did.
 *
 * `TcpTransport.onData` puts a `WARN` on the log for both of its tiers, naming
 * the peer and the offending field, and #945's own evidence quoted those calls
 * as the reference behaviour — while this class returned or swallowed at all
 * three of its refusal points with nothing observable anywhere.  A
 * version-skewed worker therefore had its frames black-holed on the multi-core
 * path with no signal at all, which is strictly worse than before the guard
 * existed, when the frame at least arrived.
 *
 * The shape is `WorkerBroker`'s, one hop away and since #1276: a per-reason
 * tally that never rate-limits, and a log line that does.
 */
describe('MessageChannelTransport — drops are counted and reported (#1515)', () => {
  /** A clock the test moves by hand, so the fold can be crossed without a thirty-second wait. */
  class ManualClock implements Clock {
    nowMs = 0;
    now(): number { return this.nowMs; }
  }

  const NO_DROPS = { 'malformed-envelope': 0, 'malformed-frame': 0, 'handler-threw': 0 };
  const warningsOf = (logger: RecordingLogger): string[] =>
    logger.records.filter((record) => record.level === 'warn').map((record) => record.message);

  /** A transport on a `FakePort`, with the log and the clock in the test's hands. */
  function openCounted(handler: WireHandler = () => {}, logger: Logger = new RecordingLogger()): {
    transport: MessageChannelTransport;
    port: FakePort;
    clock: ManualClock;
    self: NodeAddress;
    peer: NodeAddress;
  } {
    const self = freshAddress();
    const peer = freshAddress();
    const port = new FakePort();
    const clock = new ManualClock();
    const transport = new MessageChannelTransport(self, port, logger, clock);
    transport.setHandler(handler);
    void transport.start();
    return { transport, port, clock, self, peer };
  }

  test('a fresh transport has dropped nothing, and the snapshot is a copy', () => {
    const { transport } = openCounted();
    const snapshot = transport.dropped();
    expect(snapshot).toEqual(NO_DROPS);
    (snapshot as { 'malformed-envelope': number })['malformed-envelope'] = 99;
    expect(transport.dropped()).toEqual(NO_DROPS);
  });

  test('every hostile envelope is counted once, under `malformed-envelope`', () => {
    const { transport, port } = openCounted();
    for (const [, envelope] of hostileEnvelopes) port.inject(envelope);
    expect(transport.dropped()).toEqual({
      ...NO_DROPS, 'malformed-envelope': hostileEnvelopes.length,
    });
  });

  test('every hostile payload is counted once, under `malformed-frame`', () => {
    const { transport, port, self, peer } = openCounted();
    for (const [, payload] of hostileWirePayloads) {
      port.inject({ from: peer.toJSON(), to: self.toJSON(), payload });
    }
    expect(transport.dropped()).toEqual({
      ...NO_DROPS, 'malformed-frame': hostileWirePayloads.length,
    });
  });

  /**
   * The three reasons are three counters, not one.
   *
   * This is the assertion that separates the guards: a single `try` wrapped
   * around `fromJSON`, `rememberPeer` and the handler together contains every
   * throw just as well and satisfies every *containment* test in this file —
   * and then reports a refused envelope and a handler nobody understands as
   * the same event, which is the one thing an operator needs to tell apart.
   */
  test('a throwing handler is its own reason, not the envelope guard\'s', () => {
    const { transport, port, self, peer } = openCounted(() => { throw new Error('handler exploded'); });

    port.inject({ from: peer.toJSON(), to: self.toJSON(), payload: wellFormedFrame(peer) });
    port.inject('not-an-envelope');

    expect(transport.dropped()).toEqual({
      ...NO_DROPS, 'handler-threw': 1, 'malformed-envelope': 1,
    });
  });

  test('drops fold into one WARN per reason per interval, carrying the count', () => {
    const logger = new RecordingLogger();
    const { port, clock, self, peer } = openCounted(() => {}, logger);

    // Three refusals inside one interval: the first is reported at once, the
    // next two are counted only.
    for (let i = 0; i < 3; i += 1) port.inject('not-an-envelope');
    expect(warningsOf(logger)).toEqual([
      'message-channel transport dropped 1 frame(s) — the envelope is not a BrokeredMessage — '
      + 'its address fields failed the shape check, and nothing past them was read',
    ]);

    // Past the interval the next drop flushes the fold: the two suppressed
    // plus the one that triggered the line.
    clock.nowMs += DEFAULT_DROP_REPORT_INTERVAL_MS;
    port.inject('not-an-envelope');
    expect(warningsOf(logger)).toHaveLength(2);
    expect(warningsOf(logger)[1]).toMatch(/^message-channel transport dropped 3 frame\(s\) — /);

    // One short of the interval is still inside it.
    clock.nowMs += DEFAULT_DROP_REPORT_INTERVAL_MS - 1;
    port.inject('not-an-envelope');
    expect(warningsOf(logger)).toHaveLength(2);

    // A *different* reason has its own budget and reports straight away, even
    // though the first reason is still folded — the throttle is per reason.
    port.inject({ from: peer.toJSON(), to: self.toJSON(), payload: { kind: 'hello' } });
    const warnings = warningsOf(logger);
    expect(warnings).toHaveLength(3);
    expect(warnings[2]).toBe(
      `message-channel transport dropped 1 frame(s), most recently from ${peer} — `
      + 'the payload is not a frame this node accepts: `self` is not a valid node address',
    );
  });

  /**
   * The line carries the sender, and the sender is not always trustworthy.
   *
   * Through a broker `from` is rewritten to the arriving port (#774).  Wired
   * port-to-port it is whatever the peer wrote, and `isNodeAddressData` asks
   * only for non-empty strings — so a `host` with a newline in it is a
   * well-formed address that would forge as many log lines as it likes.  This
   * is #573 one layer down, on the line that reports a dropped frame.
   */
  test('a newline in the sender\'s host cannot forge a second log line', () => {
    const logger = new RecordingLogger();
    const { port, self } = openCounted(() => {}, logger);

    port.inject({
      from: { systemName: 'sys', host: 'evil\nWARN  forged line', port: 7 },
      to: self.toJSON(),
      payload: { kind: 'hello' },
    });

    const warnings = warningsOf(logger);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('\n');
    expect(warnings[0]).toContain('evil\\u000aWARN  forged line');
  });

  /**
   * The report runs inside the port's `onmessage`, where nothing catches, and
   * `Logger` is a documented extension point — so a sink that throws would
   * otherwise reopen the exact hole #945 closed, with the line that reports a
   * dropped frame.
   */
  test('a logger that throws does not escape the callback', () => {
    const throwingLogger = new RecordingLogger();
    throwingLogger.warn = (): never => { throw new Error('sink exploded'); };
    const { transport, port } = openCounted(() => {}, throwingLogger);

    expect(() => port.inject('not-an-envelope')).not.toThrow();
    // …and the drop is still counted, which is the half that does not depend
    // on the sink working at all.
    expect(transport.dropped()['malformed-envelope']).toBe(1);
  });
});
