/**
 * The three seams that carry `actor-ts.serialization.read-constraints.*` from
 * a `Config` to something that actually refuses a payload (#880).
 *
 * The keys were wired when they shipped and held by nothing.  Measured on the
 * develop tip: reverting the extension factory to `new SerializationExtension()`,
 * `Cluster`'s `readConstraints:` to `{}`, and `TcpTransport`'s
 * `settings.readConstraints ?? {}` to `{}` — separately or all three at once —
 * left `bun test tests/unit/` green and `bunx tsc --noEmit` at exit 0.  Nothing
 * outside `ReadConstraints.test.ts` and three `DocumentedDefaults` pin rows so
 * much as named the block, and `NoDeadConfigKeys` would not have noticed either,
 * because `readReadConstraintsOptionsFromConfig` would still exist and still be
 * referenced from source.
 *
 * So each test below sets ONE non-default value in HOCON and drives it to an
 * observable refusal, with a control at the shipped default that accepts the
 * same bytes.  A ceiling that arrives is the only thing that can produce the
 * pair.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import type { ClusterOptionsType } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import { LogLevel, type Logger } from '../../../src/Logger.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { SerializationExtensionId } from '../../../src/serialization/SerializationExtension.js';

/** A depth no real payload comes near, and far under the shipped 256. */
const CONFIGURED_DEPTH = 8;

const CONFIGURED = `
  actor-ts.serialization.read-constraints.max-nesting-depth = ${CONFIGURED_DEPTH}
`;

/** Deeper than {@link CONFIGURED_DEPTH}, shallower than the shipped default. */
const nestedArrayJson = (levels: number): string => '['.repeat(levels) + ']'.repeat(levels);
const OVER_CONFIGURED = nestedArrayJson(40);

const HEADER_SIZE = 4;

/** A length-prefixed wire frame carrying `json` verbatim, as a peer would send it. */
function frameOf(json: string): Uint8Array {
  const payload = new TextEncoder().encode(json);
  const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, HEADER_SIZE);
  return frame;
}

/**
 * Collects messages AND the arguments beside them, because the transport's
 * refusal reports the reason as a second argument: `log.warn('frame-decoder
 * error …', err)`.  A logger that kept only the message would see the same
 * line for every decoder failure and could not tell a depth refusal from a
 * malformed tag.
 *
 * Which is why this is not `tests/util/RecordingLogger.ts`: that one records
 * `{ level, message }` and drops the rest, and widening its record shape would
 * touch the twenty-odd suites already reading it.
 *
 * `withSource` and `withFields` funnel back to the root sink — `Cluster` hands
 * its transport `system.log.withSource(…)`, so a derived logger that kept its
 * own array would collect the very records under test.
 */
class CapturingLogger implements Logger {
  readonly level = LogLevel.Debug;
  readonly lines: string[] = [];

  constructor(private readonly root: CapturingLogger | null = null) {}

  private get sink(): CapturingLogger { return this.root ?? this; }

  private record(message: string, args: unknown[]): void {
    const detail = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ');
    this.sink.lines.push(detail === '' ? message : `${message} ${detail}`);
  }

  debug(message: string, ...args: unknown[]): void { this.record(message, args); }
  info(message: string, ...args: unknown[]): void { this.record(message, args); }
  warn(message: string, ...args: unknown[]): void { this.record(message, args); }
  error(message: string, ...args: unknown[]): void { this.record(message, args); }
  withSource(_source: string): Logger { return new CapturingLogger(this.sink); }
  withFields(_fields: LogContextData): Logger { return new CapturingLogger(this.sink); }
}

/** The private socket callbacks these tests push a hostile frame through. */
interface TransportInternals {
  attachInbound(socket: unknown): void;
  onData(socket: unknown, chunk: Uint8Array): void;
}

type MockSocket = { ended: boolean; write(data: Uint8Array): void; end(): void };

const mockSocket = (): MockSocket => ({
  ended: false,
  write(_data: Uint8Array): void { /* nothing reads the handshake back */ },
  end(): void { this.ended = true; },
});

/**
 * Feed one frame in through the transport's own inbound seam and report what
 * it logged.  `onData` swallows a decoder failure by design — it closes the
 * connection rather than letting the throw reach the runtime's socket callback
 * — so the log line is the observable, and the socket's `end()` is the effect.
 */
function pushFrame(transport: TcpTransport, log: CapturingLogger, json: string): {
  readonly lines: readonly string[];
  readonly ended: boolean;
} {
  const socket = mockSocket();
  const internals = transport as unknown as TransportInternals;
  internals.attachInbound(socket);
  const before = log.lines.length;
  internals.onData(socket, frameOf(json));
  return { lines: log.lines.slice(before), ended: socket.ended };
}

/**
 * The private constructor these tests call.  A construct signature, so it is
 * an `interface` — and a deliberate reach past `private`, which is a
 * compile-time visibility rule and not a runtime one.  `Cluster.join` would
 * bind a real listener to observe a decoder ceiling; the constructor
 * allocates the transport and opens nothing.
 */
interface ClusterConstructor {
  new (system: ActorSystem, options: ClusterOptionsType): Cluster;
}

const SELF = new NodeAddress('read-constraints-binding', '127.0.0.1', 2_552);

const started: ActorSystem[] = [];
const transports: TcpTransport[] = [];

afterEach(async () => {
  // No transport here ever `start`s, but `attachInbound` arms a real handshake
  // deadline per accepted socket — `shutdown` is what disarms them.
  for (const transport of transports.splice(0, transports.length)) {
    try { await transport.shutdown(); } catch { /* teardown is best-effort */ }
  }
  for (const system of started.splice(0, started.length)) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

/** A system whose config is `hocon` layered over the shipped `reference.conf`. */
function newSystem(hocon: string): { system: ActorSystem; log: CapturingLogger } {
  const log = new CapturingLogger();
  const options = ActorSystemOptions.create().withLogger(log).withConfig(Config.parseString(hocon));
  const system = ActorSystem.create('read-constraints-binding', options);
  started.push(system);
  return { system, log };
}

describe('SerializationExtension inherits the configured ceilings', () => {
  const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

  test('a configured depth refuses bytes the shipped default accepts', () => {
    const configured = newSystem(CONFIGURED).system.extension(SerializationExtensionId);
    const shipped = newSystem('actor-ts.cluster.gossip-interval = 1s').system
      .extension(SerializationExtensionId);

    expect(() => configured.defaultSerializer.fromBinary(bytesOf(OVER_CONFIGURED), ''))
      .toThrow(new RegExp(`nesting deeper than ${CONFIGURED_DEPTH}`));
    // The control: without the key, the same bytes decode.  Without it the
    // assertion above would also pass on a serializer that simply refused
    // everything.
    expect(shipped.defaultSerializer.fromBinary(bytesOf(OVER_CONFIGURED), ''))
      .toBeInstanceOf(Array);
  });

  test('the CBOR serializer registered beside it inherits the same ceiling', () => {
    // Both serializers are constructed from the one `readConstraints` argument,
    // so a factory that dropped it would leave the registry's second entry
    // unbounded too — and nothing else in the suite constructs that one.
    const serialization = newSystem(CONFIGURED).system.extension(SerializationExtensionId);
    const cbor = serialization.requireById(2);
    const deep = new Uint8Array(40).fill(0x81); // 40 nested single-element arrays

    expect(() => cbor.fromBinary(deep, ''))
      .toThrow(new RegExp(`nesting deeper than ${CONFIGURED_DEPTH}`));
  });
});

describe('TcpTransport hands its ceilings to every FrameDecoder it builds', () => {
  const transportWith = (
    readConstraints: Record<string, number> | undefined,
  ): { transport: TcpTransport; log: CapturingLogger } => {
    const log = new CapturingLogger();
    const transport = new TcpTransport(SELF, log, { tls: null, readConstraints });
    transports.push(transport);
    return { transport, log };
  };

  test('an explicit depth reaches the inbound decoder', () => {
    const { transport, log } = transportWith({ maxNestingDepth: CONFIGURED_DEPTH });

    const refused = pushFrame(transport, log, OVER_CONFIGURED);

    expect(refused.lines.join('\n')).toContain(`nesting deeper than ${CONFIGURED_DEPTH}`);
    expect(refused.ended).toBe(true);
  });

  test('without one the shipped default governs, and the frame is merely malformed', () => {
    // The control, and the discriminator: 40 levels is inside the shipped 256,
    // so the decoder yields a frame and the *shape* check refuses it — a
    // different warning, and the connection survives.
    const { transport, log } = transportWith(undefined);

    const accepted = pushFrame(transport, log, OVER_CONFIGURED);

    expect(accepted.lines.join('\n')).not.toContain('nesting deeper than');
    expect(accepted.lines.join('\n')).toContain('malformed frame');
    expect(accepted.ended).toBe(false);
  });
});

describe('Cluster reads the block out of system config into its transport', () => {
  const clusterWith = (hocon: string): { cluster: Cluster; log: CapturingLogger } => {
    const { system, log } = newSystem(hocon);
    const options = { host: SELF.host, port: SELF.port } as ClusterOptionsType;
    const cluster = new (Cluster as unknown as ClusterConstructor)(system, options);
    transports.push(cluster.transport as TcpTransport);
    return { cluster, log };
  };

  test('a configured depth reaches the wire of the transport Cluster builds', () => {
    // The whole chain in one assertion: `system.config` → `Cluster` →
    // `TcpTransport` → `FrameDecoder` → a refusal an operator can see.
    const { cluster, log } = clusterWith(CONFIGURED);

    const refused = pushFrame(cluster.transport as TcpTransport, log, OVER_CONFIGURED);

    expect(refused.lines.join('\n')).toContain(`nesting deeper than ${CONFIGURED_DEPTH}`);
    expect(refused.ended).toBe(true);
  });

  test('a system that never mentions the block keeps the shipped default', () => {
    const { cluster, log } = clusterWith('actor-ts.cluster.gossip-interval = 1s');

    const accepted = pushFrame(cluster.transport as TcpTransport, log, OVER_CONFIGURED);

    expect(accepted.lines.join('\n')).not.toContain('nesting deeper than');
    expect(accepted.ended).toBe(false);
  });

  test('max-document-bytes reaches the wire too, and refuses on the length prefix', () => {
    // The second leaf of the block, and the one that reached this path through
    // nothing at all: a frame is handed to `JSON.parse` directly and never to a
    // serializer, so the key that both serializers honour was inert on the one
    // decode whose bytes a hostile peer chooses.
    const { cluster, log } = clusterWith(`
      actor-ts.serialization.read-constraints.max-document-bytes = 1K
    `);

    const refused = pushFrame(
      cluster.transport as TcpTransport,
      log,
      JSON.stringify({ kind: 'ping', pad: 'x'.repeat(4096) }),
    );

    expect(refused.lines.join('\n')).toContain('exceeds maxDocumentBytes 1024');
    expect(refused.ended).toBe(true);
  });
});
