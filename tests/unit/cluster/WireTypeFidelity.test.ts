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
import { BidirectionalMap } from '../../../src/util/BidirectionalMap.js';
import { BidirectionalMultiMap } from '../../../src/util/BidirectionalMultiMap.js';

type MockSocket = {
  writes: Uint8Array[];
  write(data: Uint8Array): void;
  end(): void;
};

function mockSocket(): MockSocket {
  return {
    writes: [],
    write(data: Uint8Array): void { this.writes.push(data); },
    end(): void {},
  };
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
type Link = {
  readonly sender: TcpTransport;
  readonly receiver: TcpTransport;
  readonly senderSocket: MockSocket;
  readonly receiverSocket: MockSocket;
  readonly received: WireMessage[];
  readonly senderLog: RecordingLogger;
  close(): Promise<void>;
};

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
      const legacy = JSON.stringify({
        kind: 'envelope', to: '/user/target', from: null,
        body: { when: '2026-08-15T10:20:30.400Z', list: [1, 2], nested: { ok: true } },
      });
      const payload = new TextEncoder().encode(legacy);
      const frame = new Uint8Array(4 + payload.byteLength);
      new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
      frame.set(payload, 4);

      (link.receiver as unknown as TransportInternals).onData(link.receiverSocket, frame);
      expect(link.received).toHaveLength(1);
      expect((link.received[0] as EnvelopeMessage).body).toEqual({
        when: '2026-08-15T10:20:30.400Z', list: [1, 2], nested: { ok: true },
      });
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
