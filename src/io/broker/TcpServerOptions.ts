/**
 * Fluent builder for {@link TcpServerOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.tcp-server` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import { detectRuntime } from '../../runtime/Detect.js';
import { assertListenerTlsIsCoherent } from '../../runtime/tcp/TcpBackend.js';
import type { TlsTransportOptionsType } from '../../runtime/tcp/TcpBackend.js';
import { findFramingViolation } from './TcpFraming.js';
import type { TcpFraming } from './TcpFraming.js';
import type { TcpServerMessage } from './TcpServerActor.js';

export interface TcpServerOptionsType extends BrokerCommonOptionsType {
  /** Local bind address.  Default: `'0.0.0.0'`. */
  readonly bindHost?: string;
  /** Local port.  Required; `0` lets the OS pick (read back via `boundPort`). */
  readonly bindPort?: number;
  /** Frame extraction, applied per accepted connection.  Default `{ kind: 'bytes' }`. */
  readonly framing?: TcpFraming;
  /**
   * Subscriber for every connection event and inbound frame.  Required.  No
   * HOCON leaf: an `ActorRef` names a live actor in this process, which a
   * config file cannot denote.
   */
  readonly target?: ActorRef<TcpServerMessage>;
  /**
   * Serve TLS instead of plaintext.  Carries the certificate **material**,
   * never a path to it — see {@link TlsTransportOptionsType}.  Deliberately
   * has no HOCON leaf: a config file is the wrong place for a private key.
   *
   * Supplying `ca` turns on client-certificate verification (mTLS) unless
   * `requestClientCert: false` says otherwise.
   */
  readonly tls?: TlsTransportOptionsType;
  /**
   * Admission cap on simultaneously accepted connections.  A connection
   * arriving at the cap is closed immediately instead of being registered.
   * Default: `Infinity` (unlimited).
   */
  readonly maxConnections?: number;
}

export class TcpServerOptionsBuilder extends BrokerOptionsBuilder<TcpServerOptionsType> {
  /** Start a fresh builder.  Equivalent to `new TcpServerOptionsBuilder()`. */
  static create(): TcpServerOptionsBuilder {
    return new TcpServerOptionsBuilder();
  }

  /** Local bind address.  Default `'0.0.0.0'`. */
  withBindHost(host: string): this {
    return this.set('bindHost', host);
  }

  /** Local port.  Required; `0` lets the OS pick. */
  withBindPort(port: number): this {
    return this.set('bindPort', port);
  }

  /** Frame extraction strategy, applied per connection.  Default `{ kind: 'bytes' }`. */
  withFraming(framing: TcpFraming): this {
    return this.set('framing', framing);
  }

  /** Subscriber for connection events and inbound frames.  Required. */
  withTarget(target: ActorRef<TcpServerMessage>): this {
    return this.set('target', target);
  }

  /** Serve TLS.  Pass the certificate material itself, not a file path. */
  withTls(tls: TlsTransportOptionsType): this {
    return this.set('tls', tls);
  }

  /** Cap on simultaneously accepted connections.  Default `Infinity`. */
  withMaxConnections(max: number): this {
    return this.set('maxConnections', max);
  }
}

/** Validates resolved {@link TcpServerOptionsType} settings. */
export class TcpServerOptionsValidator extends BrokerOptionsValidator<TcpServerOptionsType> {
  constructor() {
    super('TcpServerOptions');
  }

  protected rules(s: Partial<TcpServerOptionsType>): void {
    this.commonRules(s);
    this.nonEmptyString('bindHost');
    // bindPort allows 0 ("let the OS pick"), so port() (min 1) is too strict.
    if (
      s.bindPort !== undefined &&
      (!Number.isInteger(s.bindPort) || s.bindPort < 0 || s.bindPort > 65535)
    ) {
      this.fail('bindPort', 'must be an integer in [0, 65535]', s.bindPort);
    }
    // Infinity is the unlimited default, so nonNegativeInt would reject it.
    if (
      s.maxConnections !== undefined && s.maxConnections !== Number.POSITIVE_INFINITY &&
      (typeof s.maxConnections !== 'number' || !Number.isInteger(s.maxConnections) || s.maxConnections < 1)
    ) {
      this.fail('maxConnections', 'must be a positive integer or Infinity', s.maxConnections);
    }
    const violation = findFramingViolation(s.framing);
    if (violation) this.fail(violation.field, violation.reason, violation.value);
    if (s.tls !== undefined) this.tlsRules(s.tls);
  }

  /**
   * Re-raise the listener TLS coherence rule (#144) as an options failure.
   *
   * The adapters assert the same thing at bind time, and that check stays —
   * it is what makes the rule unskippable.  But a `TcpServerActor` binds from
   * `connectImplementation`, and to {@link BrokerActor} a throw from there is
   * a *connection* failure, answered with the reconnect policy: a
   * half-configured certificate would back off and retry forever instead of
   * failing the actor's start.  A configuration rule belongs in the
   * configuration gate, which runs once in `preStart` and throws out of it.
   */
  private tlsRules(tls: TlsTransportOptionsType): void {
    try {
      assertListenerTlsIsCoherent(tls, RUNTIME_LABELS[detectRuntime()]);
    } catch (e) {
      this.fail('tls', (e as Error).message);
    }
  }
}

/** `detectRuntime()`'s answer in the spelling the TLS assertions use. */
const RUNTIME_LABELS = {
  bun: 'Bun',
  node: 'Node.js',
  deno: 'Deno',
} as const satisfies Record<string, 'Node.js' | 'Bun' | 'Deno'>;

/**
 * Accepted input for any TCP-server-configurable constructor: the fluent
 * {@link TcpServerOptionsBuilder} OR a plain {@link TcpServerOptionsType} object.
 */
export type TcpServerOptions = TcpServerOptionsBuilder | Partial<TcpServerOptionsType>;
/** Value alias so `TcpServerOptions.create()` / `new TcpServerOptions()` resolve to the builder. */
export const TcpServerOptions = TcpServerOptionsBuilder;
