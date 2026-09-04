import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { TlsTransportOptionsType } from '../runtime/tcp/index.js';
import type { ReadConstraintsOptions } from '../serialization/ReadConstraintsOptions.js';

/**
 * Everything `TcpTransport` accepts beyond its identity and its logger.
 *
 * The type exists because the constructor had grown to seven positional
 * parameters and #846 adds four more — a call site would have been five
 * `undefined`s and a number, with nothing on the line saying which bound it
 * set.  `self` and `log` stay positional: they are the two arguments every
 * construction site has an opinion about, and neither has a default to fall
 * through to.
 *
 * Four of these fields — {@link handshakeTimeoutMs}, {@link outboundQueueSize},
 * {@link maxInboundConnections} and {@link incompleteFrameIdleMs} — are the
 * transport's association-lifecycle bounds, enforced since #588 and #697 and
 * until now hard-coded.  They default from `cluster/Constants.ts` rather than
 * from here, because `ClusterOptionsType` carries the same four for the
 * transport `Cluster` builds itself: a default shared by two options types is
 * exactly the case `src/<subsystem>/Constants.ts` exists for, and co-locating
 * it here would put the number in both files.
 */
export type TcpTransportOptionsType = {
  /**
   * TLS material for both the listener and the dialer.  `null` and `undefined`
   * both mean plaintext; `null` is kept assignable because `Cluster` passes it
   * explicitly to say the choice was made rather than forgotten (#591).
   */
  readonly tls?: TlsTransportOptionsType | null;
  /**
   * Per-frame size cap (security).  Frames whose length-prefix exceeds this
   * are rejected before any payload bytes are buffered — the 4-GiB-claim DoS
   * vector documented on `FrameDecoder`.  Default: `DEFAULT_MAX_FRAME_BYTES`
   * (16 MiB).  Raise it only for genuinely larger envelopes; the cap is
   * per-frame, not aggregate.
   */
  readonly maxFrameBytes?: number;
  /**
   * Interface to bind, when it differs from the one the transport's `self`
   * advertises — a container binds `0.0.0.0` and tells its peers a single
   * dialable address (#944).  Defaults to `self.host`.
   */
  readonly bindHost?: string;
  /**
   * Port to bind, when it differs from the one `self` advertises — a container
   * listens on its own port and tells its peers the published one (#845).
   * Defaults to `self.port`.
   */
  readonly bindPort?: number;
  /**
   * Decode ceilings handed to every `FrameDecoder` this transport builds — one
   * per connection, inbound and outbound alike (#880).
   */
  readonly readConstraints?: ReadConstraintsOptions;
  /**
   * How long a connection may sit without its half of the handshake before it
   * is torn down, in milliseconds (#846).  Default: 5 s
   * (`HANDSHAKE_TIMEOUT_MS`).
   *
   * **One value for both directions, deliberately.**  The dialling side's
   * clock starts before the TCP connect and the TLS handshake; the accepting
   * side's starts after the accept.  Equal numbers therefore mean the peer
   * that is still trying has always given up first, and the acceptor can never
   * be the deadline that punishes a slow-but-legitimate dial.  Two keys would
   * put that invariant in an operator's hands, where setting the accept side
   * lower than the dial side makes a healthy peer unreachable and nothing says
   * why — so this is one key and stays one.
   *
   * Raise it for a network whose round trip plus TLS handshake genuinely
   * exceeds the default; lower it to reclaim inbound slots faster on a port
   * exposed to strangers.
   */
  readonly handshakeTimeoutMs?: number;
  /**
   * How many frames are held for a peer that cannot take them right now,
   * before the oldest are dropped (#846).  Default: 1000
   * (`MAX_PENDING_FRAMES`).
   *
   * Today that is the pre-handshake buffer: a `send` racing the handshake is
   * held rather than lost, and an unbounded hold turns a silently-stuck peer
   * into a memory leak.  The name is the **category**, not that one buffer —
   * #931 adds the post-handshake backpressure queue, which is the same
   * quantity ("frames this node is holding because the peer is not taking
   * them"), with the same drop-oldest policy and the same one-shot WARN, and
   * it lands under this key rather than a second one.  A key cannot be renamed
   * without a breaking config change, which is why it is named for where it
   * is going.
   *
   * Oldest first, because the newest membership and heartbeat state is the
   * state worth keeping.
   */
  readonly outboundQueueSize?: number;
  /**
   * How many inbound connections this transport accepts before it refuses
   * sockets outright (#846).  Default: 1024 (`MAX_INBOUND_CONNECTIONS`).
   *
   * The useful tightening of the pair that bounds inbound decode memory — that
   * bound is this count times {@link incompleteFrameIdleMs}'s buffer, and this
   * is the half worth moving.  Set it from the real peer count where that is
   * known: a fully-meshed cluster needs one inbound connection per peer plus
   * whatever `ClusterClient`s dial in, and a cap far above real usage bounds
   * very little.  Refusing a legitimate peer is a partition, so leave headroom.
   */
  readonly maxInboundConnections?: number;
  /**
   * How long a connection may hold a half-received frame without another byte
   * arriving, in milliseconds (#846).  Default: 30 s
   * (`INCOMPLETE_FRAME_IDLE_MS`).
   *
   * A **stall** bound, not a budget for the frame: it is re-armed on every
   * chunk, so a peer shipping a large frame over a slow link is never punished
   * for being slow — only for going silent.  Keep it comfortably above
   * {@link handshakeTimeoutMs}: a socket that sends nothing at all never
   * reaches this deadline, and the handshake timer is what covers that one.
   */
  readonly incompleteFrameIdleMs?: number;
};

/**
 * Fluent builder for {@link TcpTransportOptionsType}.
 *
 *     const transportOptions = TcpTransportOptions.create()
 *       .withMaxFrameBytes(64 * 1024 * 1024)
 *       .withMaxInboundConnections(128);
 *     const transport = new TcpTransport(self, log, transportOptions);
 */
export class TcpTransportOptionsBuilder extends OptionsBuilder<TcpTransportOptionsType> {
  /** Start a fresh builder.  Equivalent to `new TcpTransportOptionsBuilder()`. */
  static create(): TcpTransportOptionsBuilder {
    return new TcpTransportOptionsBuilder();
  }

  /** TLS material for the listener and the dialer.  `null` is plaintext. */
  withTls(tls: TlsTransportOptionsType | null): this {
    return this.set('tls', tls);
  }

  /** Per-frame wire cap in bytes.  Default: 16 MiB. */
  withMaxFrameBytes(maxFrameBytes: number): this {
    return this.set('maxFrameBytes', maxFrameBytes);
  }

  /** Interface to bind, when it differs from the advertised one. */
  withBindHost(bindHost: string): this {
    return this.set('bindHost', bindHost);
  }

  /** Port to bind, when it differs from the advertised one. */
  withBindPort(bindPort: number): this {
    return this.set('bindPort', bindPort);
  }

  /** Decode ceilings for every frame decoder this transport builds. */
  withReadConstraints(readConstraints: ReadConstraintsOptions): this {
    return this.set('readConstraints', readConstraints);
  }

  /** Handshake deadline, both directions, in ms.  Default: 5000. */
  withHandshakeTimeoutMs(handshakeTimeoutMs: number): this {
    return this.set('handshakeTimeoutMs', handshakeTimeoutMs);
  }

  /** Frames held for a peer that cannot take them.  Default: 1000. */
  withOutboundQueueSize(outboundQueueSize: number): this {
    return this.set('outboundQueueSize', outboundQueueSize);
  }

  /** Inbound connections accepted before sockets are refused.  Default: 1024. */
  withMaxInboundConnections(maxInboundConnections: number): this {
    return this.set('maxInboundConnections', maxInboundConnections);
  }

  /** Stall deadline on a half-received frame, in ms.  Default: 30000. */
  withIncompleteFrameIdleMs(incompleteFrameIdleMs: number): this {
    return this.set('incompleteFrameIdleMs', incompleteFrameIdleMs);
  }
}

/** Validates resolved {@link TcpTransportOptionsType} settings. */
export class TcpTransportOptionsValidator extends OptionsValidator<TcpTransportOptionsType> {
  constructor() {
    super('TcpTransportOptions');
  }

  protected rules(s: Partial<TcpTransportOptionsType>): void {
    this.positiveInt('maxFrameBytes');
    this.nonEmptyString('bindHost');
    // Non-negative, not `port()`: `0` asks the operating system for an
    // ephemeral port, which is how the suites here bind without colliding, and
    // the advertised port — the one that has to be a real TCP port — is
    // `self.port`, checked where the address is built.
    this.nonNegativeInt('bindPort');
    this.positiveNumber('handshakeTimeoutMs');
    // Positive, with no "0 disables" reading: a zero-length hold would drop
    // every frame written before the handshake lands, which is the loss the
    // buffer exists to prevent, and an unbounded one is the leak it exists to
    // bound.  Neither end of the range is a value anyone wants spelled `0`.
    this.positiveInt('outboundQueueSize');
    // Likewise positive: `0` would refuse every inbound socket, which is a
    // node that cannot be joined rather than a node with no cap.
    this.positiveInt('maxInboundConnections');
    this.positiveNumber('incompleteFrameIdleMs');
    // The one cross-field rule, and the reason it is a rule rather than a
    // sentence in the docs: a socket that sends *nothing at all* never reaches
    // the stall deadline — it has no half-received frame to track — so the
    // handshake timer is the only thing that reclaims it.  With the stall
    // deadline set below the handshake deadline the two swap roles for a peer
    // that sends three bytes and stops, and the connection is torn down on a
    // clock that was never meant to bound the handshake.  Checked only when
    // both are set; either alone falls back to a default the other clears.
    const { handshakeTimeoutMs, incompleteFrameIdleMs } = s;
    if (handshakeTimeoutMs !== undefined && incompleteFrameIdleMs !== undefined
      && incompleteFrameIdleMs <= handshakeTimeoutMs) {
      this.fail(
        'incompleteFrameIdleMs',
        `must be greater than handshakeTimeoutMs (${handshakeTimeoutMs} ms): the stall deadline `
        + 'bounds a peer that went silent mid-frame, the handshake deadline bounds one that never '
        + 'spoke, and the second is the shorter of the two by construction',
        incompleteFrameIdleMs,
      );
    }
  }
}

/**
 * What every `TcpTransport` construction site accepts: the builder or a plain
 * object, interchangeably.
 */
export type TcpTransportOptions = TcpTransportOptionsBuilder | TcpTransportOptionsType;

/** Value alias, so `TcpTransportOptions.create()` resolves to the builder. */
export const TcpTransportOptions = TcpTransportOptionsBuilder;
