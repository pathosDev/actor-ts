/**
 * Fluent builder for {@link TcpSocketOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.tcp` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import { findFramingViolation } from './TcpFraming.js';
import type { TcpFraming } from './TcpFraming.js';

export interface TcpSocketOptionsType extends BrokerCommonOptionsType {
  /** Remote host. */
  readonly host?: string;
  /** Remote port. */
  readonly port?: number;
  /** Frame extraction.  Default: `{ kind: 'bytes' }`. */
  readonly framing?: TcpFraming;
  /**
   * Subscriber that receives every inbound frame.  Required — the actor
   * has no useful behaviour without one.  Receives `Uint8Array` for
   * `bytes` / `length-prefixed`, `string` for `lines`.
   */
  readonly target?: ActorRef<unknown>;
  /**
   * Declare the connection lost after this many milliseconds without a single
   * inbound byte, so the reconnect machinery runs (#753).  `0` or unset —
   * the default — never does.
   *
   * Off by default because only the application knows how quiet its peer is
   * allowed to be: a protocol whose server speaks only when it has something
   * to say is indistinguishable, from here, from one that has vanished.  Set
   * it comfortably above the peer's own heartbeat interval; below it, the
   * timeout severs healthy connections in a loop.
   *
   * This is a **read** deadline, deliberately: it is reset by inbound bytes
   * and not by outbound ones, because a client writing into a black hole is
   * exactly the case that must still trip it.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Abandon a connect attempt that has not completed after this many
   * milliseconds.  `0` or unset — the default — waits forever.
   *
   * The socket's own `connect` event is the only thing that settles an
   * attempt, so a peer that finishes the TCP handshake and then stalls holds
   * the actor in `connecting` for as long as it likes; the reconnect policy
   * never sees a failure to react to.
   */
  readonly connectTimeoutMs?: number;
  /**
   * Idle time before the OS starts sending TCP keepalive probes.  Default
   * {@link DEFAULT_TCP_KEEP_ALIVE_MS}; `0` disables keepalive entirely.
   *
   * On by default — the one liveness knob here that is, because it is the
   * only one that cannot be wrong about a healthy peer.  A probe is answered
   * by the peer's kernel whether or not its application has anything to say,
   * so keepalive never severs a connection that is merely quiet; it only
   * reaches the `error` listener for one whose other end is genuinely gone.
   * How long that takes after the delay is the OS's business (Linux: nine
   * probes, 75 s apart), which is why it complements {@link idleTimeoutMs}
   * rather than replacing it.
   */
  readonly keepAliveMs?: number;
}

/**
 * Idle time before the first TCP keepalive probe — 45 s.
 *
 * Chosen against middleboxes rather than against the peer: the common
 * connection-tracking idle timeout on NAT gateways and cloud load balancers
 * is 60 s (AWS NLB, GCP), so probing at 45 s keeps the flow entry warm with a
 * margin, while anything much shorter spends packets on a problem that does
 * not exist yet.  It is the delay only — the probe count and interval belong
 * to the OS and are not configurable through `node:net`.
 */
export const DEFAULT_TCP_KEEP_ALIVE_MS = 45_000;

export class TcpSocketOptionsBuilder extends BrokerOptionsBuilder<TcpSocketOptionsType> {
  /** Start a fresh builder.  Equivalent to `new TcpSocketOptionsBuilder()`. */
  static create(): TcpSocketOptionsBuilder {
    return new TcpSocketOptionsBuilder();
  }

  /** Remote host. */
  withHost(host: string): this {
    return this.set('host', host);
  }

  /** Remote port. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** Frame extraction strategy.  Default `{ kind: 'bytes' }`. */
  withFraming(framing: TcpFraming): this {
    return this.set('framing', framing);
  }

  /** Subscriber that receives every inbound frame.  Required. */
  withTarget(target: ActorRef<unknown>): this {
    return this.set('target', target);
  }

  /** Declare the connection lost after `ms` without inbound bytes.  Default: disabled. */
  withIdleTimeoutMs(ms: number): this {
    return this.set('idleTimeoutMs', ms);
  }

  /** Abandon a connect attempt that has not completed after `ms`.  Default: disabled. */
  withConnectTimeoutMs(ms: number): this {
    return this.set('connectTimeoutMs', ms);
  }

  /** Idle time before the OS sends TCP keepalive probes.  Default 45 s; `0` disables. */
  withKeepAliveMs(ms: number): this {
    return this.set('keepAliveMs', ms);
  }
}

/** Validates resolved {@link TcpSocketOptionsType} settings. */
export class TcpSocketOptionsValidator extends BrokerOptionsValidator<TcpSocketOptionsType> {
  constructor() {
    super('TcpSocketOptions');
  }
  protected rules(s: Partial<TcpSocketOptionsType>): void {
    this.commonRules(s);
    this.nonEmptyString('host');
    this.port('port');
    // Non-negative, not positive: `0` is the documented way to turn each of
    // these off, and a validator that rejected it would leave a HOCON-set
    // value with no per-instance override.
    this.nonNegativeInt('idleTimeoutMs');
    this.nonNegativeInt('connectTimeoutMs');
    this.nonNegativeInt('keepAliveMs');
    // Shared with TcpServerOptions — see findFramingViolation for why each of
    // its rules guards something worse than a merely wrong value.
    const violation = findFramingViolation(s.framing);
    if (violation) this.fail(violation.field, violation.reason, violation.value);
  }
}

/**
 * Accepted input for any TCP-socket-configurable constructor: the fluent
 * {@link TcpSocketOptionsBuilder} OR a plain {@link TcpSocketOptionsType} object.
 */
export type TcpSocketOptions = TcpSocketOptionsBuilder | Partial<TcpSocketOptionsType>;
/** Value alias so `TcpSocketOptions.create()` / `new TcpSocketOptions()` resolve to the builder. */
export const TcpSocketOptions = TcpSocketOptionsBuilder;
