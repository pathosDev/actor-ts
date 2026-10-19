import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { TlsTransportOptionsType } from '../runtime/tcp/index.js';
import type { ReadConstraintsOptions } from '../serialization/ReadConstraintsOptions.js';
import { HANDSHAKE_TIMEOUT_MS, INCOMPLETE_FRAME_IDLE_MS } from './Constants.js';

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
 * it here would put the number in both files.  {@link connectTimeoutMs}, the
 * dial's own deadline (#1475), sits on both types too but has no constant at
 * all: unset, it is the handshake deadline.
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
   * How long a dial may take to open, in milliseconds (#1475): the TCP connect
   * and, on a TLS dial, the TLS handshake — up to the moment the runtime
   * reports the socket open.  Unset, it is {@link handshakeTimeoutMs}, the one
   * deadline a dial had before this field.
   *
   * Its own deadline because "could not connect" and "connected, never
   * answered" are different failures: a peer that is not there is known once
   * the connect has had its chance, while one that accepted and is slow to
   * answer keeps the whole handshake deadline.  A dial that has not opened by
   * then is aborted and reported as one that could not connect; one that has
   * is the handshake deadline's to end.
   *
   * It may not exceed {@link handshakeTimeoutMs}, which bounds the same dial
   * from the same moment, so a later connect deadline could never fire —
   * {@link findConnectDeadlineOrderingViolation} refuses the pair, with an
   * unset half resolved first.  There is no `DEFAULT_*` constant on purpose:
   * "unset" is the default, and a number of its own would refuse every
   * {@link handshakeTimeoutMs} set below it.
   */
  readonly connectTimeoutMs?: number;
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
   * for being slow — only for going silent.  It has to stay above
   * {@link handshakeTimeoutMs} — a socket that sends nothing at all never
   * reaches this deadline, and the handshake timer is what covers that one —
   * and {@link findStallDeadlineOrderingViolation} refuses the pair otherwise,
   * with either half's default standing in for a value that was not supplied.
   */
  readonly incompleteFrameIdleMs?: number;
};

/**
 * A cross-field rejection, in the shape `OptionsValidator.fail` takes.
 *
 * Returned rather than thrown because the rule below belongs to two validators
 * and the error each of them raises is not the same error: `fail` prefixes the
 * options family it was called on, so a `ClusterOptions` operator reading the
 * message is told which options type refused their value.
 */
export type StallDeadlineOrderingViolation = {
  readonly field: 'handshakeTimeoutMs' | 'incompleteFrameIdleMs';
  readonly reason: string;
  readonly value: number;
};

/**
 * The one cross-field rule of the association-lifecycle bounds (#846), checked
 * against the pair the transport will **run** with rather than the pair the
 * caller happened to supply.
 *
 * The rule exists because the two deadlines cover disjoint failures and the
 * handshake one is the shorter of the pair by construction: a socket that sends
 * *nothing at all* never reaches the stall deadline — it has no half-received
 * frame to track — so the handshake timer is the only thing that reclaims it.
 * With the stall deadline at or below the handshake deadline the two swap roles
 * for a peer that sends three bytes and stops, and the connection is torn down
 * on a clock that was never meant to bound the handshake.
 *
 * Resolving before comparing is the whole point, and the shipped version of
 * this rule did not: it fired only when both halves were supplied, which made
 * it silent for exactly the input an operator is most likely to write — one of
 * the two keys.  An unsupplied half is not absent at run time.  It falls
 * through to the constant `TcpTransport`'s constructor applies one line after
 * the validator has been and gone, so a lone `incomplete-frame-idle = 1s`
 * resolved to (5000, 1000): the inversion this rule exists to prevent, accepted
 * because half of it was a default.  Being a no-op on an unset field is right
 * for a per-field helper — required-ness lives elsewhere — and wrong for a rule
 * whose subject is the pair.
 *
 * The failure names the half the caller actually wrote, because that is the
 * line they can edit: naming a defaulted `incompleteFrameIdleMs` at an operator
 * who only ever set `handshake-timeout` sends them looking for a key that is
 * not in their config.
 *
 * "Defaulted" is read off the **value**, not off whether the field is present,
 * because over HOCON both halves are always present: `reference.conf` ships
 * both leaves, so a lone `handshake-timeout = 45s` reaches this function as
 * `(45000, 30000)` and a presence test named `incompleteFrameIdleMs` — exactly
 * the key that is not in the operator's config.  A value equal to its built-in
 * default is the reference layer's (`ClusterConfigDefaults.test.ts` pins the
 * shipped leaves to the same constants), or an operator who spelled the default
 * out, and either way the other half is the one to name.  When both halves
 * differ from their defaults the caller wrote both, and the stall deadline is
 * named, as it always was.
 */
export function findStallDeadlineOrderingViolation(
  settings: Pick<
    Partial<TcpTransportOptionsType>,
    'handshakeTimeoutMs' | 'incompleteFrameIdleMs'
  >,
): StallDeadlineOrderingViolation | undefined {
  const handshakeTimeoutMs = settings.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const incompleteFrameIdleMs = settings.incompleteFrameIdleMs ?? INCOMPLETE_FRAME_IDLE_MS;
  if (incompleteFrameIdleMs > handshakeTimeoutMs) return undefined;
  const why = 'the stall deadline bounds a peer that went silent mid-frame, the handshake '
    + 'deadline bounds one that never spoke, and the second is the shorter of the two by '
    + 'construction';
  if (incompleteFrameIdleMs === INCOMPLETE_FRAME_IDLE_MS) {
    return {
      field: 'handshakeTimeoutMs',
      reason: `must be less than incompleteFrameIdleMs (${incompleteFrameIdleMs} ms, the `
        + `built-in default): ${why}`,
      value: handshakeTimeoutMs,
    };
  }
  const defaulted = handshakeTimeoutMs === HANDSHAKE_TIMEOUT_MS ? ', the built-in default' : '';
  return {
    field: 'incompleteFrameIdleMs',
    reason: `must be greater than handshakeTimeoutMs (${handshakeTimeoutMs} ms${defaulted}): ${why}`,
    value: incompleteFrameIdleMs,
  };
}

/**
 * A refused connect/handshake pair, in the shape `OptionsValidator.fail`
 * takes — returned rather than thrown for the reason
 * {@link StallDeadlineOrderingViolation} is: two validators raise it, each
 * under its own options family's name.
 */
export type ConnectDeadlineOrderingViolation = {
  readonly field: 'connectTimeoutMs';
  readonly reason: string;
  readonly value: number;
};

/**
 * The connect deadline's one rule (#1475): it may not exceed the handshake
 * deadline, checked against the pair the transport will run with.
 *
 * Both deadlines start when the dial does, and the handshake one bounds the
 * whole of it — connect, TLS handshake, `hello-ack` — so a connect deadline
 * above it could never fire: the handshake deadline would end the dial first,
 * and a key that reads as set would be doing nothing.  Equal is allowed, and
 * is what unset means.
 *
 * Resolved before comparing, as {@link findStallDeadlineOrderingViolation}
 * resolves its pair.  An unset connect deadline is the handshake deadline, so
 * it never trips the rule — which is what lets a lone `handshakeTimeoutMs`
 * below the built-in 5 s through, the input a connect default of its own would
 * have refused — and an unset handshake deadline is its built-in default, which
 * a lone connect deadline above it does trip.  The connect half is the one
 * named, because a set connect deadline is always one somebody wrote: it ships
 * no default.  The handshake value is called the built-in default when it is
 * one, for the reason the stall rule gives: over HOCON it always arrives, from
 * `reference.conf` when the operator did not write it.
 */
export function findConnectDeadlineOrderingViolation(
  settings: Pick<Partial<TcpTransportOptionsType>, 'connectTimeoutMs' | 'handshakeTimeoutMs'>,
): ConnectDeadlineOrderingViolation | undefined {
  const handshakeTimeoutMs = settings.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const connectTimeoutMs = settings.connectTimeoutMs ?? handshakeTimeoutMs;
  if (connectTimeoutMs <= handshakeTimeoutMs) return undefined;
  const defaulted = handshakeTimeoutMs === HANDSHAKE_TIMEOUT_MS ? ', the built-in default' : '';
  return {
    field: 'connectTimeoutMs',
    reason: `must not exceed handshakeTimeoutMs (${handshakeTimeoutMs} ms${defaulted}): the handshake `
      + 'deadline bounds the same dial from the same moment, so a later connect deadline could never fire',
    value: connectTimeoutMs,
  };
}

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

  /** How long a dial may take to open, in ms.  Default: the handshake deadline. */
  withConnectTimeoutMs(connectTimeoutMs: number): this {
    return this.set('connectTimeoutMs', connectTimeoutMs);
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
    // Positive: a zero connect deadline gives every dial up before it can open.
    this.positiveNumber('connectTimeoutMs');
    // Positive, with no "0 disables" reading: a zero-length hold would drop
    // every frame written before the handshake lands, which is the loss the
    // buffer exists to prevent, and an unbounded one is the leak it exists to
    // bound.  Neither end of the range is a value anyone wants spelled `0`.
    this.positiveInt('outboundQueueSize');
    // Likewise positive: `0` would refuse every inbound socket, which is a
    // node that cannot be joined rather than a node with no cap.
    this.positiveInt('maxInboundConnections');
    this.positiveNumber('incompleteFrameIdleMs');
    // The two cross-field rules, and why each is a rule rather than a sentence
    // in the docs is beside it — {@link findStallDeadlineOrderingViolation}
    // and {@link findConnectDeadlineOrderingViolation} — along with why both
    // resolve their pair against the defaults before comparing it.  Run last,
    // so a value that is out of its own domain is reported as that rather than
    // as one end of a bad pair.
    const violation = findStallDeadlineOrderingViolation(s);
    if (violation !== undefined) this.fail(violation.field, violation.reason, violation.value);
    const connectViolation = findConnectDeadlineOrderingViolation(s);
    if (connectViolation !== undefined) {
      this.fail(connectViolation.field, connectViolation.reason, connectViolation.value);
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
