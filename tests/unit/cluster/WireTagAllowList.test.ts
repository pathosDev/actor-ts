/**
 * #1303 — the cluster wire decodes a peer's frame through a tag allow-list.
 *
 * A frame is bytes a peer wrote, and since #450 the whole frame is a tagged
 * JSON tree, so before this a peer chose the runtime class of any value in a
 * body: a `RegExp` it authored, an `undefined` no parse can produce, an
 * `Error` subclass.  The decode now constructs only the data tags by default
 * (`actor-ts.serialization.wire.admitted-tags`), and a frame that uses any
 * other tag is refused — skipped, counted and logged — rather than delivered
 * with its value quietly turned into a plain object.  The connection survives:
 * the frame is whole and well-formed, it only asked for something this node
 * will not build.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { LogLevel, type Logger } from '../../../src/Logger.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame, FrameDecoder, type EnvelopeMessage, type WireMessage } from '../../../src/cluster/Protocol.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import { TcpTransportOptions } from '../../../src/cluster/TcpTransportOptions.js';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { JSON_TREE_TAG_NAMES, type JsonTreeTagName } from '../../../src/serialization/Constants.js';
import { encodeJsonTree } from '../../../src/serialization/JsonTree.js';
import {
  DEFAULT_WIRE_ADMITTED_TAGS,
  readWireDecodeOptionsFromConfig,
  WireDecodeOptions,
} from '../../../src/serialization/WireDecodeOptions.js';
import { BidirectionalMap } from '../../../src/util/BidirectionalMap.js';
import { BidirectionalMultiMap } from '../../../src/util/BidirectionalMultiMap.js';
import { expectExactOptions } from '../../util/ExactOptions.js';
import { CLUSTER_WIRE_VERSION, MIN_CLUSTER_WIRE_VERSION } from '../../../src/cluster/WireVersion.js';

interface MockSocket {
  ended: boolean;
  write(data: Uint8Array): void;
  end(): void;
}

function mockSocket(): MockSocket {
  return {
    ended: false,
    write(): void {},
    end(): void { this.ended = true; },
  };
}

class RecordingLogger implements Logger {
  readonly level = LogLevel.Warn;
  readonly warnings: string[] = [];
  constructor(private readonly root: RecordingLogger | null = null) {}
  debug(): void {}
  info(): void {}
  warn(message: string): void { (this.root ?? this).warnings.push(message); }
  error(): void {}
  withSource(): Logger { return new RecordingLogger(this.root ?? this); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.root ?? this); }
}

interface TransportInternals {
  attachInbound(socket: unknown): void;
  onData(socket: unknown, chunk: Uint8Array): void;
}

/** A frame as a peer writes it by hand — length prefix plus whatever JSON it likes. */
function handBuiltFrame(message: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

/** One value per tag name; each is encoded by the real encoder, so the tag is well-formed. */
const SAMPLES: Readonly<Record<JsonTreeTagName, unknown>> = {
  'date': new Date(0),
  'bytes': new Uint8Array([1]),
  'map': new Map([['a', 1]]),
  'set': new Set([1]),
  'bidirectional-map': new BidirectionalMap([['a', 1]]),
  'bidirectional-multi-map': new BidirectionalMultiMap([['a', 1]]),
  'bigint': 1n,
  'number': Number.NaN,
  'undefined': [undefined],
  // Deliberately catastrophic (js/redos): the test proves this pattern is refused
  // before it is ever compiled, so it has to be one that would backtrack.
  'regexp': /(a+)+$/g,
  'url': new URL('file:///etc/passwd'),
  'error': new TypeError('x'),
  'typed-array': new Float64Array([1]),
};

function envelopeCarrying(name: JsonTreeTagName): unknown {
  return {
    kind: 'envelope', to: '/user/target', from: null,
    body: { value: encodeJsonTree(SAMPLES[name], { undefinedValues: 'omit' }) },
  };
}

const self = new NodeAddress('allow-list', '127.0.0.1', 22_001, 'run');
const peer = new NodeAddress('allow-list', '127.0.0.1', 22_002, 'run');

function receiver(options?: TcpTransportOptions): {
  transport: TcpTransport;
  socket: MockSocket;
  log: RecordingLogger;
  received: WireMessage[];
  feed(frame: Uint8Array): void;
} {
  const log = new RecordingLogger();
  const transport = new TcpTransport(self, log, options);
  const socket = mockSocket();
  const internals = transport as unknown as TransportInternals;
  internals.attachInbound(socket);
  internals.onData(socket, encodeFrame({ kind: 'hello', wireVersion: CLUSTER_WIRE_VERSION, minWireVersion: MIN_CLUSTER_WIRE_VERSION, self: peer.toJSON() }));
  const received: WireMessage[] = [];
  transport.setHandler((_from, message) => { received.push(message); });
  return { transport, socket, log, received, feed: (frame) => internals.onData(socket, frame) };
}

describe('the default allow-list — data tags only', () => {
  test('is exactly the data tags: RegExp, undefined, URL and Error are out', () => {
    expect([...DEFAULT_WIRE_ADMITTED_TAGS].sort()).toEqual([
      'bidirectional-map', 'bidirectional-multi-map', 'bigint', 'bytes', 'date',
      'map', 'number', 'set', 'typed-array',
    ]);
  });

  test('a hostile frame per tag: admitted tags build their class, every other one never reaches the handler', async () => {
    const link = receiver();
    try {
      for (const name of JSON_TREE_TAG_NAMES) {
        link.received.length = 0;
        link.log.warnings.length = 0;
        link.feed(handBuiltFrame(envelopeCarrying(name)));
        if ((DEFAULT_WIRE_ADMITTED_TAGS as readonly string[]).includes(name)) {
          expect(link.received).toHaveLength(1);
          const body = (link.received[0] as EnvelopeMessage).body as { value: unknown };
          expect(body.value).toEqual(SAMPLES[name]);
        } else {
          expect(link.received).toEqual([]);
          expect(link.log.warnings).toHaveLength(1);
          expect(link.log.warnings[0]).toContain(`'${name}'`);
        }
      }
      // Refusing a frame is per frame: the link that carried four refusals is still up.
      expect(link.socket.ended).toBe(false);
      expect(link.transport.peers()).toHaveLength(1);
    } finally {
      await link.transport.shutdown();
    }
  });

  test('a refused frame costs only itself, not the frames batched beside it', async () => {
    const link = receiver();
    try {
      const healthy = handBuiltFrame({ kind: 'envelope', to: '/user/target', from: null, body: { n: 1 } });
      const hostile = handBuiltFrame(envelopeCarrying('regexp'));
      const chunk = new Uint8Array(2 * healthy.byteLength + hostile.byteLength);
      chunk.set(healthy, 0);
      chunk.set(hostile, healthy.byteLength);
      chunk.set(healthy, healthy.byteLength + hostile.byteLength);
      link.feed(chunk);
      expect(link.received.map((message) => (message as EnvelopeMessage).body)).toEqual([{ n: 1 }, { n: 1 }]);
      expect(link.socket.ended).toBe(false);
    } finally {
      await link.transport.shutdown();
    }
  });

  test('a node sending a RegExp to itself has the frame refused the same way', async () => {
    const log = new RecordingLogger();
    const transport = new TcpTransport(self, log);
    const received: WireMessage[] = [];
    transport.setHandler((_from, message) => { received.push(message); });
    try {
      transport.send(self, { kind: 'envelope', to: '/user/target', from: null, body: /x/ });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await Promise.resolve();
      expect(received).toEqual([]);
      expect(log.warnings.some((warning) => warning.includes("'regexp'"))).toBe(true);
    } finally {
      await transport.shutdown();
    }
  });
});

describe('the allow-list is configurable', () => {
  test('a transport given regexp builds the RegExp again', async () => {
    const wireDecode = WireDecodeOptions.create().withAdmittedTags([...DEFAULT_WIRE_ADMITTED_TAGS, 'regexp']);
    const transportOptions = TcpTransportOptions.create().withWireDecode(wireDecode);
    const link = receiver(transportOptions);
    try {
      link.feed(handBuiltFrame(envelopeCarrying('regexp')));
      expect(link.received).toHaveLength(1);
      expect(((link.received[0] as EnvelopeMessage).body as { value: unknown }).value).toBeInstanceOf(RegExp);
    } finally {
      await link.transport.shutdown();
    }
  });

  test('FrameDecoder counts what it refused and names the last push\'s refusals', () => {
    const decoder = new FrameDecoder(undefined, {}, { admittedTags: ['date'] });
    const out = decoder.push(handBuiltFrame(envelopeCarrying('map')));
    expect(out).toEqual([]);
    expect(decoder.refusedFrames).toBe(1);
    expect(decoder.lastRefusals().map((refusal) => refusal.tag)).toEqual(['map']);
    decoder.push(handBuiltFrame(envelopeCarrying('date')));
    expect(decoder.lastRefusals()).toEqual([]);
    expect(decoder.refusedFrames).toBe(1);
  });

  test('the shipped reference value is the built-in default', () => {
    expectExactOptions(readWireDecodeOptionsFromConfig(Config.parseString(REFERENCE_CONF)), {
      admittedTags: [...DEFAULT_WIRE_ADMITTED_TAGS],
    });
  });

  test('HOCON admitted-tags reaches the reader, and an absent key is absent', () => {
    const config = Config.parseString('actor-ts.serialization.wire.admitted-tags = [date, regexp]');
    expectExactOptions(readWireDecodeOptionsFromConfig(config), { admittedTags: ['date', 'regexp'] });
    expectExactOptions(readWireDecodeOptionsFromConfig(Config.parseString('')), {});
  });

  test('an unknown name is refused when the decoder is built, not at the first frame', () => {
    expect(() => new FrameDecoder(undefined, {}, { admittedTags: ['regex' as JsonTreeTagName] }))
      .toThrow(/regex/);
  });
});

/** `Cluster`'s constructor is not public; these tests build one the way `ReadConstraintsBinding` does. */
interface ClusterConstructor {
  new (system: ActorSystem, options: ClusterOptionsType): Cluster;
}

const systems: ActorSystem[] = [];
const transports: TcpTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0, transports.length)) await transport.shutdown();
  for (const system of systems.splice(0, systems.length)) await system.terminate();
});

describe('Cluster reads actor-ts.serialization.wire into the transport it builds', () => {
  function refusalsUnder(hocon: string): string[] {
    const log = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create().withLogger(log).withConfig(Config.parseString(hocon));
    const system = ActorSystem.create('allow-list-binding', systemOptions);
    systems.push(system);
    const clusterOptions = { host: self.host, port: self.port } as ClusterOptionsType;
    const cluster = new (Cluster as unknown as ClusterConstructor)(system, clusterOptions);
    const transport = cluster.transport as TcpTransport;
    transports.push(transport);
    const socket = mockSocket();
    const internals = transport as unknown as TransportInternals;
    internals.attachInbound(socket);
    const before = log.warnings.length;
    internals.onData(socket, handBuiltFrame(envelopeCarrying('regexp')));
    return log.warnings.slice(before).filter((warning) => warning.includes('refusing a frame'));
  }

  test('the shipped list refuses a RegExp frame', () => {
    expect(refusalsUnder('actor-ts.cluster.gossip-interval = 1s')).toHaveLength(1);
  });

  test('a list that admits regexp does not', () => {
    expect(refusalsUnder(`actor-ts.serialization.wire.admitted-tags = [${[...DEFAULT_WIRE_ADMITTED_TAGS, 'regexp'].join(', ')}]`))
      .toEqual([]);
  });
});
