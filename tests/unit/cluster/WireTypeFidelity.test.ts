/**
 * #450 — what actually survives an outbound `TcpTransport.send`.
 *
 * Nothing in `bun test` used to look at this.  `MultiNodeSpec` delivers by
 * reference (`MultiNodeTransport`), `ParallelMultiNodeSpec` structured-clones,
 * all five cluster benchmarks and the cluster smoke case use
 * `InMemoryTransport`, and the two suites that do build a `TcpTransport` —
 * `tests/multi-node/ClusterSecurity.test.ts` and
 * `tests/unit/cluster/TcpTransportInboundGuards.test.ts` — only ever drive
 * *inbound* mock sockets.  So the one path that serialises anything, `send()`
 * → `encodeFrame` → `socket.write`, was covered by nothing at all, and a
 * `Map` arriving at a peer as `{}` was invisible to every gate.
 *
 * These tests drive two real `TcpTransport`s through their public `send` and
 * `setHandler`, with mock sockets carrying the bytes between them.  The mock
 * is the socket only: the frames are the real ones, produced by the real
 * outbound encoder and consumed by the real inbound decoder, validator and
 * dispatch.  A real listener would add a port to collide on and would not
 * cover one line more — the smoke case
 * `27-cluster-wire-rich-types.mjs` is what binds this over an actual socket,
 * on all three runtimes.
 */
import { describe, expect, test } from 'bun:test';
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame, type EnvelopeMessage, type WireMessage } from '../../../src/cluster/Protocol.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import { CborSerializer } from '../../../src/serialization/CborSerializer.js';
import { SerializationExtension } from '../../../src/serialization/SerializationExtension.js';
import { BidirectionalMap } from '../../../src/util/BidirectionalMap.js';
import { BidirectionalMultiMap } from '../../../src/util/BidirectionalMultiMap.js';

interface MockSocket {
  writes: Uint8Array[];
  /** `dropConnection` is the only thing that ends a socket mid-test — see the legacy-frame cases. */
  ended: boolean;
  write(data: Uint8Array): void;
  end(): void;
}

function mockSocket(): MockSocket {
  return {
    writes: [],
    ended: false,
    write(data: Uint8Array): void { this.writes.push(data); },
    end(): void { this.ended = true; },
  };
}

/**
 * A frame exactly as a pre-#450 node wrote it: `JSON.stringify` with no tree
 * walk, behind the same 4-byte big-endian length prefix.
 *
 * This is the *sender* half of the rolling-upgrade hazard, and it cannot be
 * produced by `encodeFrame` — which is the point.  Anything that goes through
 * today's encoder gets the `__literal__` escape wrapped around a body that
 * happens to look like a tag; a legacy peer had no escape to apply.
 */
function legacyFrame(message: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

/** The private socket callbacks these tests feed inbound bytes through. */
interface TransportInternals {
  attachInbound(socket: unknown): void;
  onData(socket: unknown, chunk: Uint8Array): void;
}

/** A logger that keeps what it was told, for the drop-path assertions. */
class RecordingLogger implements Logger {
  readonly level = LogLevel.Error;
  readonly errors: string[] = [];
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(message: string): void { this.errors.push(message); }
  withSource(): Logger { return this; }
  withFields(_fields: LogContextData): Logger { return this; }
}

const addressA = new NodeAddress('fidelity', '127.0.0.1', 21_001);
const addressB = new NodeAddress('fidelity', '127.0.0.1', 21_002);

/**
 * Two transports that have completed a handshake with each other over mock
 * sockets, plus everything `sendAndReceive` needs to move one frame across.
 */
interface Link {
  readonly sender: TcpTransport;
  readonly receiver: TcpTransport;
  readonly senderSocket: MockSocket;
  readonly receiverSocket: MockSocket;
  readonly received: WireMessage[];
  readonly senderLog: RecordingLogger;
  close(): Promise<void>;
}

function connect(): Link {
  const senderLog = new RecordingLogger();
  const sender = new TcpTransport(addressA, senderLog);
  const receiver = new TcpTransport(addressB, new NoopLogger());

  // Each side accepts an inbound socket and is told who is on it by a real
  // `hello` frame, which is what puts the peer into `byPeer` and lets `send`
  // take the write-now branch rather than buffering behind the handshake.
  const senderSocket = mockSocket();
  const receiverSocket = mockSocket();
  (sender as unknown as TransportInternals).attachInbound(senderSocket);
  (sender as unknown as TransportInternals).onData(
    senderSocket, encodeFrame({ kind: 'hello', self: addressB.toJSON() }),
  );
  (receiver as unknown as TransportInternals).attachInbound(receiverSocket);
  (receiver as unknown as TransportInternals).onData(
    receiverSocket, encodeFrame({ kind: 'hello', self: addressA.toJSON() }),
  );

  const received: WireMessage[] = [];
  receiver.setHandler((_from, message) => { received.push(message); });

  return {
    sender, receiver, senderSocket, receiverSocket, received, senderLog,
    async close(): Promise<void> {
      await sender.shutdown();
      await receiver.shutdown();
    },
  };
}

/** Send one envelope body across the link and hand back what arrived. */
function sendBody(link: Link, body: unknown): unknown {
  const before = link.senderSocket.writes.length;
  const envelope: EnvelopeMessage = { kind: 'envelope', to: '/user/target', from: null, body };
  link.sender.send(addressB, envelope);
  const written = link.senderSocket.writes.slice(before);
  expect(written).toHaveLength(1);
  for (const frame of written) (link.receiver as unknown as TransportInternals).onData(link.receiverSocket, frame);
  expect(link.received).toHaveLength(1);
  const arrived = link.received[0] as EnvelopeMessage;
  link.received.length = 0;
  return arrived.body;
}

async function withLink(run: (link: Link) => void): Promise<void> {
  const link = connect();
  try {
    run(link);
  } finally {
    await link.close();
  }
}

describe('a rich payload survives the outbound TcpTransport encode', () => {
  test('Map, Set and the framework collections arrive as themselves, not as {}', async () => {
    await withLink((link) => {
      const arrived = sendBody(link, {
        byName: new Map<string, number>([['a', 1], ['b', 2]]),
        seen: new Set<string>(['x', 'y']),
        oneToOne: new BidirectionalMap<string, number>([['left', 7]]),
        manyToMany: new BidirectionalMultiMap<string, number>([['left', 7], ['left', 8]]),
      }) as Record<string, unknown>;

      expect(arrived.byName).toBeInstanceOf(Map);
      expect([...(arrived.byName as Map<string, number>)]).toEqual([['a', 1], ['b', 2]]);
      expect(arrived.seen).toBeInstanceOf(Set);
      expect([...(arrived.seen as Set<string>)]).toEqual(['x', 'y']);
      expect(arrived.oneToOne).toBeInstanceOf(BidirectionalMap);
      expect((arrived.oneToOne as BidirectionalMap<string, number>).get('left')).toBe(7);
      expect(arrived.manyToMany).toBeInstanceOf(BidirectionalMultiMap);
      expect([...(arrived.manyToMany as BidirectionalMultiMap<string, number>).get('left')]).toEqual([7, 8]);
    });
  });

  test('a Date arrives as a Date, not as a string whose getTime() throws', async () => {
    await withLink((link) => {
      const when = new Date('2026-08-15T10:20:30.400Z');
      const arrived = sendBody(link, { when }) as Record<string, unknown>;
      expect(arrived.when).toBeInstanceOf(Date);
      expect((arrived.when as Date).getTime()).toBe(when.getTime());
    });
  });

  test('binary arrives as binary, not as an index-keyed object', async () => {
    await withLink((link) => {
      const arrived = sendBody(link, {
        bytes: new Uint8Array([0, 1, 254, 255]),
        counters: new Int32Array([-1, 0, 1]),
      }) as Record<string, unknown>;
      expect(arrived.bytes).toBeInstanceOf(Uint8Array);
      expect([...(arrived.bytes as Uint8Array)]).toEqual([0, 1, 254, 255]);
      expect(arrived.counters).toBeInstanceOf(Int32Array);
      expect([...(arrived.counters as Int32Array)]).toEqual([-1, 0, 1]);
    });
  });

  test('a bigint crosses instead of throwing out of the sender', async () => {
    await withLink((link) => {
      const arrived = sendBody(link, { balance: 9_007_199_254_740_993n }) as Record<string, unknown>;
      expect(arrived.balance).toBe(9_007_199_254_740_993n);
    });
  });

  test('non-finite numbers and -0 keep their identity instead of collapsing to null / 0', async () => {
    await withLink((link) => {
      const arrived = sendBody(link, {
        nan: Number.NaN, up: Infinity, down: -Infinity, negativeZero: -0,
      }) as Record<string, unknown>;
      expect(Number.isNaN(arrived.nan as number)).toBe(true);
      expect(arrived.up).toBe(Infinity);
      expect(arrived.down).toBe(-Infinity);
      expect(Object.is(arrived.negativeZero, -0)).toBe(true);
    });
  });

  test('RegExp, URL and Error keep their data instead of arriving as {}', async () => {
    await withLink((link) => {
      const arrived = sendBody(link, {
        pattern: /^ab+c$/giu,
        endpoint: new URL('https://example.test/a?b=1'),
        failure: new Error('boom'),
      }) as Record<string, unknown>;
      expect(arrived.pattern).toBeInstanceOf(RegExp);
      expect((arrived.pattern as RegExp).source).toBe('^ab+c$');
      expect((arrived.pattern as RegExp).flags).toBe('giu');
      expect(arrived.endpoint).toBeInstanceOf(URL);
      expect((arrived.endpoint as URL).href).toBe('https://example.test/a?b=1');
      expect(arrived.failure).toBeInstanceOf(Error);
      expect((arrived.failure as Error).message).toBe('boom');
    });
  });

  test('undefined in a value position stays undefined instead of becoming null', async () => {
    await withLink((link) => {
      const arrived = sendBody(link, { slots: [1, undefined, 3] }) as Record<string, unknown>;
      expect(arrived.slots).toEqual([1, undefined, 3]);
      // An `undefined` object *property* still drops, exactly as JSON.stringify
      // did — existing payloads with unset optional fields are unchanged.
      const optional = sendBody(link, { present: 1, absent: undefined }) as Record<string, unknown>;
      expect('absent' in optional).toBe(false);
    });
  });

  test('a plain payload is unaffected — the common case still travels as plain JSON', async () => {
    await withLink((link) => {
      const body = { kind: 'ping', n: 7, nested: { list: [1, 'two', true, null] } };
      expect(sendBody(link, body)).toEqual(body);
    });
  });
});

describe('the wire codec cannot be talked into misreading data', () => {
  test('user data shaped like a tag comes back as user data', async () => {
    await withLink((link) => {
      // A body that *is* a single reserved key.  Without the escape wrapper
      // this decodes as a `Map` — data changing type in flight.
      const arrived = sendBody(link, { __map__: 'not really a map' });
      expect(arrived).toEqual({ __map__: 'not really a map' });
      expect(arrived).not.toBeInstanceOf(Map);
    });
  });

  test('a __proto__ key round-trips as plain data', async () => {
    await withLink((link) => {
      const arrived = sendBody(link, JSON.parse('{"__proto__": {"polluted": true}}')) as Record<string, unknown>;
      expect(Object.getPrototypeOf(arrived)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  test('a frame from an older node — untagged JSON — decodes unchanged', async () => {
    await withLink((link) => {
      // Exactly the bytes `JSON.stringify(envelope)` produced before this
      // change: the rolling-upgrade direction that has to keep working.
      const frame = legacyFrame({
        kind: 'envelope', to: '/user/target', from: null,
        body: { when: '2026-08-15T10:20:30.400Z', list: [1, 2], nested: { ok: true } },
      });

      (link.receiver as unknown as TransportInternals).onData(link.receiverSocket, frame);
      expect(link.received).toHaveLength(1);
      expect((link.received[0] as EnvelopeMessage).body).toEqual({
        when: '2026-08-15T10:20:30.400Z', list: [1, 2], nested: { ok: true },
      });
    });
  });
});

/**
 * The hazardous half of that rolling upgrade, which the benign case above says
 * nothing about (#450).
 *
 * `encodeFrame`'s JSDoc, the `[Unreleased]` CHANGELOG entry and
 * `docs/…/serialization/overview.mdx` all describe what a legacy body shaped
 * like a reserved tag costs — in three different wordings, asserted nowhere.
 * These two tests are what makes those paragraphs falsifiable, and they are the
 * reason the mixed-version window is documented as a hazard rather than a
 * supported state: the throwing tags cost the link, and the two silent tags
 * cost the data without anyone noticing.
 *
 * Both pin *current, documented* behaviour, not desired behaviour.  When #823
 * gives the protocol a version handshake and #450's framing lands on top, these
 * are the tests that have to move, deliberately and with the docs.
 */
describe('a legacy body shaped like a reserved tag', () => {
  test('costs the connection, and every frame batched into the same chunk', async () => {
    await withLink((link) => {
      // Two legacy frames in one chunk, which is what a real socket read
      // delivers when a peer wrote them back to back.
      const healthy = legacyFrame({
        kind: 'envelope', to: '/user/target', from: null, body: { n: 1 },
      });
      // A legacy `Map`-shaped body, nested — `decodeJsonTree` reads a tag at any
      // depth, so burying it does not help.
      const poison = legacyFrame({
        kind: 'envelope', to: '/user/target', from: null,
        body: { outer: { inner: { __map__: 'not really a map' } } },
      });
      const chunk = new Uint8Array(healthy.byteLength + poison.byteLength);
      chunk.set(healthy, 0);
      chunk.set(poison, healthy.byteLength);

      expect(link.receiver.peers()).toHaveLength(1);

      (link.receiver as unknown as TransportInternals).onData(link.receiverSocket, chunk);

      // The healthy frame decoded first and is lost anyway: `push` throws
      // instead of returning the array it had already filled, so `onData` never
      // reaches the dispatch loop at all.  This is the part that makes one bad
      // frame more expensive than it looks — it is *not* the per-frame skip
      // `validateWireFrame` gives a malformed-but-decodable frame (#705, #711).
      expect(link.received).toEqual([]);
      // And the link is gone: `dropConnection` ended the socket and handed back
      // the peer slot, so the sender's next `tell` has nowhere to go.
      expect(link.receiverSocket.ended).toBe(true);
      expect(link.receiver.peers()).toEqual([]);
    });
  });

  test('or corrupts the value silently, when the tag is one that cannot throw', async () => {
    await withLink((link) => {
      const frame = legacyFrame({
        kind: 'envelope', to: '/user/target', from: null,
        body: { token: { __bytes__: 'not base64!!!' }, when: { __date__: 'whenever' } },
      });

      (link.receiver as unknown as TransportInternals).onData(link.receiverSocket, frame);

      // No throw, no dropped connection, no log line — the frame is accepted
      // and both values have changed type in flight.  `fromBase64` is
      // `Buffer.from(s, 'base64')`, which discards non-alphabet characters
      // instead of rejecting them, so thirteen characters become six bytes; and
      // `new Date('whenever')` is an Invalid Date, not an error.
      expect(link.received).toHaveLength(1);
      const body = (link.received[0] as EnvelopeMessage).body as Record<string, unknown>;
      expect(body.token).toBeInstanceOf(Uint8Array);
      expect([...(body.token as Uint8Array)]).toEqual([158, 139, 91, 106, 199, 186]);
      expect(body.when).toBeInstanceOf(Date);
      expect(Number.isNaN((body.when as Date).getTime())).toBe(true);
      // Which is worse than the dropped link above, because nothing reports it.
      expect(link.receiverSocket.ended).toBe(false);
      expect(link.receiver.peers()).toHaveLength(1);
    });
  });
});

/**
 * What the documentation now asserts about the registry, made falsifiable.
 *
 * The wire half of #450 is fixed and the *titular* half is not: a
 * `SerializationExtension` class binding still reaches `ext.encode` and nothing
 * else.  That was mis-documented in both directions at once — the frontmatter of
 * `serialization/overview.mdx` and `serialization/custom.mdx` claimed the
 * extension chose the wire format, `http/marshalling.mdx` called it "the right
 * hook" for it, and `serialization/cbor.mdx` described rolling CBOR out
 * cluster-wide — so the corrected prose needs something behind it.  Prose is not
 * gated by anything; this is.
 *
 * Like the legacy-frame cases above, it pins today's behaviour on purpose.  When
 * bindings do reach the wire, this test goes red, and that is the reminder to
 * move those pages with the code.
 */
describe('a SerializationExtension binding does not reach the wire', () => {
  test('a class bound to CBOR still crosses as the tagged JSON tree', async () => {
    class Order {
      constructor(readonly id: string, readonly placedAt: Date) {}
    }
    const cbor = new CborSerializer();
    const registry = new SerializationExtension();
    registry.bind(Order, cbor.id);
    // The binding is live in the registry it was made in — so what follows is
    // about reach, not about a binding that failed to register.
    expect(registry.findFor(new Order('order-1', new Date(0))).id).toBe(cbor.id);

    await withLink((link) => {
      const placedAt = new Date('2026-08-16T09:00:00.000Z');
      const arrived = sendBody(link, new Order('order-1', placedAt));
      // Not CBOR bytes — the frame is the same tagged tree every other case
      // here goes through, so the `Date` survives and the class does not.
      expect(arrived).not.toBeInstanceOf(Uint8Array);
      expect(arrived).not.toBeInstanceOf(Order);
      expect(arrived).toEqual({ id: 'order-1', placedAt });
    });
  });
});

describe('an unserialisable payload does not escape into the sender', () => {
  test('exploit: a body the codec refuses is dropped and logged, not thrown at tell()', async () => {
    await withLink((link) => {
      const envelope: EnvelopeMessage = {
        kind: 'envelope', to: '/user/target', from: null,
        body: { onDone: (): void => {} },
      };
      // `send` is reached from `RemoteActorRef.tell`, which is fire-and-forget:
      // a throw here lands in the *sending* actor's onReceive.
      expect(() => link.sender.send(addressB, envelope)).not.toThrow();
      expect(link.senderSocket.writes).toHaveLength(1);  // the hello-ack only
      expect(link.senderLog.errors).toHaveLength(1);
      expect(link.senderLog.errors[0]).toContain("dropping a 'envelope' frame");
    });
  });
});
