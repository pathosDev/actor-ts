/**
 * #1434 — the options bag `TcpTransport` takes, held on its own.
 *
 * The bag replaced seven positional parameters (#846) and every construction
 * site moved to it, but nothing ever called the builder, and of the
 * validator's rules only the four lifecycle bounds and their ordering had a
 * case.  The three that guard the fields the bag was introduced for — the
 * frame cap, the bind host and the bind port — could each be deleted with every
 * suite still green, and so could any one `withX` writing the wrong field.
 */
import { describe, expect, test } from 'bun:test';
import { NoopLogger } from '../../../src/Logger.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import {
  TcpTransportOptions,
  TcpTransportOptionsBuilder,
  TcpTransportOptionsValidator,
} from '../../../src/cluster/TcpTransportOptions.js';
import type { TcpTransportOptionsType } from '../../../src/cluster/TcpTransportOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

const self = new NodeAddress('transport-options', '127.0.0.1', 19_601);

/** TLS material, compared by identity: the transport must keep what it was handed. */
const tlsMaterial = { cert: 'client-certificate', key: 'client-key', ca: 'cluster-ca' };

/** One `withX` and the one field it must write — nothing more, nothing else. */
type BuilderCase = {
  readonly method: string;
  readonly apply: (builder: TcpTransportOptionsBuilder) => TcpTransportOptionsBuilder;
  readonly expected: Partial<TcpTransportOptionsType>;
};

const builderCases: readonly BuilderCase[] = [
  { method: 'withTls', apply: (b) => b.withTls(tlsMaterial), expected: { tls: tlsMaterial } },
  // `null` is a choice, not an absence: `Cluster` passes it to say plaintext was decided (#591).
  { method: 'withTls(null)', apply: (b) => b.withTls(null), expected: { tls: null } },
  {
    method: 'withMaxFrameBytes',
    apply: (b) => b.withMaxFrameBytes(64 * 1024 * 1024),
    expected: { maxFrameBytes: 64 * 1024 * 1024 },
  },
  { method: 'withBindHost', apply: (b) => b.withBindHost('0.0.0.0'), expected: { bindHost: '0.0.0.0' } },
  { method: 'withBindPort', apply: (b) => b.withBindPort(2_552), expected: { bindPort: 2_552 } },
  {
    method: 'withReadConstraints',
    apply: (b) => b.withReadConstraints({ maxNestingDepth: 32 }),
    expected: { readConstraints: { maxNestingDepth: 32 } },
  },
  {
    method: 'withHandshakeTimeoutMs',
    apply: (b) => b.withHandshakeTimeoutMs(1_500),
    expected: { handshakeTimeoutMs: 1_500 },
  },
  {
    method: 'withOutboundQueueSize',
    apply: (b) => b.withOutboundQueueSize(64),
    expected: { outboundQueueSize: 64 },
  },
  {
    method: 'withMaxInboundConnections',
    apply: (b) => b.withMaxInboundConnections(128),
    expected: { maxInboundConnections: 128 },
  },
  {
    method: 'withIncompleteFrameIdleMs',
    apply: (b) => b.withIncompleteFrameIdleMs(45_000),
    expected: { incompleteFrameIdleMs: 45_000 },
  },
];

/** Every field the bag can set, as the constructor resolved it. */
type ResolvedTransport = {
  readonly tls: unknown;
  readonly maxFrameBytes: number;
  readonly bindHost: string;
  readonly bindPort: number;
  readonly readConstraints: unknown;
  readonly handshakeTimeoutMs: number;
  readonly outboundQueueSize: number;
  readonly maxInboundConnections: number;
  readonly incompleteFrameIdleMs: number;
};

function resolved(transport: TcpTransport): ResolvedTransport {
  const internals = transport as unknown as ResolvedTransport;
  return {
    tls: internals.tls,
    maxFrameBytes: internals.maxFrameBytes,
    bindHost: internals.bindHost,
    bindPort: internals.bindPort,
    readConstraints: internals.readConstraints,
    handshakeTimeoutMs: internals.handshakeTimeoutMs,
    outboundQueueSize: internals.outboundQueueSize,
    maxInboundConnections: internals.maxInboundConnections,
    incompleteFrameIdleMs: internals.incompleteFrameIdleMs,
  };
}

describe('TcpTransportOptionsBuilder (#1434)', () => {
  test('the value alias is the builder', () => {
    expect(TcpTransportOptions).toBe(TcpTransportOptionsBuilder);
    expect(TcpTransportOptions.create()).toBeInstanceOf(TcpTransportOptionsBuilder);
  });

  for (const builderCase of builderCases) {
    test(`${builderCase.method} writes its own field and nothing else`, () => {
      const builder = TcpTransportOptions.create();

      const returned = builderCase.apply(builder);

      expect(returned).toBe(builder);
      // A builder *is* its settings: spreading it yields exactly the fields
      // that were set, which is what every consumer reads.
      expect({ ...builder }).toEqual(builderCase.expected);
      expect(builder.build()).toEqual(builderCase.expected);
    });
  }

  test('the transport reads a builder exactly as it reads the plain object it spells', () => {
    const transportOptions = TcpTransportOptions.create()
      .withTls(tlsMaterial)
      .withMaxFrameBytes(8 * 1024 * 1024)
      .withBindHost('0.0.0.0')
      .withBindPort(0)
      .withReadConstraints({ maxNestingDepth: 32 })
      .withHandshakeTimeoutMs(1_500)
      .withOutboundQueueSize(64)
      .withMaxInboundConnections(128)
      .withIncompleteFrameIdleMs(45_000);
    // Every field set, so the object doubles as the resolved shape it must
    // produce: nothing here is left for a default to fill in.
    const plainObject = {
      tls: tlsMaterial,
      maxFrameBytes: 8 * 1024 * 1024,
      bindHost: '0.0.0.0',
      bindPort: 0,
      readConstraints: { maxNestingDepth: 32 },
      handshakeTimeoutMs: 1_500,
      outboundQueueSize: 64,
      maxInboundConnections: 128,
      incompleteFrameIdleMs: 45_000,
    } satisfies TcpTransportOptionsType;

    const fromBuilder = resolved(new TcpTransport(self, new NoopLogger(), transportOptions));
    const fromObject = resolved(new TcpTransport(self, new NoopLogger(), plainObject));

    expect(fromBuilder).toEqual(fromObject);
    expect(fromBuilder).toEqual(plainObject);
    expect(fromBuilder.tls).toBe(tlsMaterial);
  });
});

describe('TcpTransportOptionsValidator — the fields the bag was introduced for (#1434)', () => {
  const check = (settings: Partial<TcpTransportOptionsType>): void =>
    new TcpTransportOptionsValidator().validate(settings);

  test('maxFrameBytes is a positive integer', () => {
    for (const refused of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => check({ maxFrameBytes: refused }))
        .toThrow(/^TcpTransportOptions: maxFrameBytes must be an integer >= 1/);
    }
    expect(() => check({ maxFrameBytes: 1 })).not.toThrow();
  });

  test('bindHost is a non-empty string', () => {
    expect(() => check({ bindHost: '' }))
      .toThrow(/^TcpTransportOptions: bindHost must be a non-empty string/);
    expect(() => check({ bindHost: '0.0.0.0' })).not.toThrow();
  });

  test('bindPort is a non-negative integer, so 0 still asks for an ephemeral port', () => {
    for (const refused of [-1, 1.5, Number.NaN]) {
      expect(() => check({ bindPort: refused }))
        .toThrow(/^TcpTransportOptions: bindPort must be an integer >= 0/);
    }
    // `0` is how the suites here bind without colliding; the advertised port,
    // the one that has to be a real TCP port, is `self.port`.
    expect(() => check({ bindPort: 0 })).not.toThrow();
    expect(() => check({ bindPort: 65_535 })).not.toThrow();
  });

  test('an unset field always passes', () => {
    expect(() => check({})).not.toThrow();
  });

  test('the constructor runs it on a builder as well as on a plain object', () => {
    const transportOptions = TcpTransportOptions.create().withMaxFrameBytes(0);

    expect(() => new TcpTransport(self, new NoopLogger(), transportOptions)).toThrow(OptionsError);
    expect(() => new TcpTransport(self, new NoopLogger(), { bindHost: '' })).toThrow(OptionsError);
  });
});
