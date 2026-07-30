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
import type { TcpFraming } from './TcpSocketActor.js';

export type TcpSocketOptionsType = BrokerCommonOptionsType & {
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
};

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
    this.framingRules(s.framing);
  }

  /**
   * `framing` carries the two inbound size caps, and both are DoS limits: a
   * frame past the cap drops the connection instead of buffering without
   * bound.  They sit one level down, so the check helpers — which are typed
   * against the top-level fields of `TcpSocketOptionsType` — cannot reach
   * them, and this is spelled out with `fail` instead.
   *
   * The failure mode is worse than a merely wrong number.  Both caps are
   * applied as `length > cap`, and any comparison against `NaN` is `false` —
   * so a non-numeric value read from HOCON does not clamp anything, it
   * **removes the cap entirely** and restores the unbounded buffering the
   * limit exists to prevent.  A zero or negative cap fails the other way,
   * dropping every connection immediately.
   */
  private framingRules(framing: TcpFraming | undefined): void {
    if (framing === undefined) return;
    const check = (field: string, value: number | undefined): void => {
      if (value === undefined) return; // unset falls through to the default
      if (!Number.isSafeInteger(value) || value <= 0) {
        this.fail(field, 'must be a positive integer number of bytes', value);
      }
    };
    if (framing.kind === 'lines') check('framing.maxLineLen', framing.maxLineLen);
    if (framing.kind === 'length-prefixed') check('framing.maxFrameLen', framing.maxFrameLen);
  }
}

/**
 * Accepted input for any TCP-socket-configurable constructor: the fluent
 * {@link TcpSocketOptionsBuilder} OR a plain {@link TcpSocketOptionsType} object.
 */
export type TcpSocketOptions = TcpSocketOptionsBuilder | Partial<TcpSocketOptionsType>;
/** Value alias so `TcpSocketOptions.create()` / `new TcpSocketOptions()` resolve to the builder. */
export const TcpSocketOptions = TcpSocketOptionsBuilder;
