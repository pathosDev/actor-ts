/**
 * Fluent builder for {@link SseOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.sse` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import type { SseEvent } from './SseActor.js';

export interface SseOptionsType extends BrokerCommonOptionsType {
  /** SSE endpoint URL. */
  readonly url?: string;
  /** Custom request headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Subscriber for inbound events.  Required. */
  readonly target?: ActorRef<SseEvent>;
  /**
   * Declare the stream lost after this many milliseconds without a single
   * inbound byte, so the reconnect machinery runs (#753).  `0` or unset —
   * the default — never does.
   *
   * SSE is the sharpest case for this knob: the stream is read-only, so a
   * server that vanishes without closing the response produces no `done`, no
   * error and no bytes, and `consume` parks on `reader.read()` for as long as
   * the socket stays nominally open.  Nothing else in the actor can tell that
   * apart from a feed with nothing to report.
   *
   * Set it above whatever the server's own comment-keepalive interval is
   * (`: ping\n\n` every 15–30 s is the common convention) — those bytes count
   * as activity, so a well-behaved server keeps the deadline refreshed even
   * when it has no events.  Below that interval, the timeout severs healthy
   * streams in a loop.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Abandon a connect attempt that has not produced response headers after
   * this many milliseconds.  `0` or unset — the default — waits forever,
   * because `fetch` has no deadline of its own.
   */
  readonly connectTimeoutMs?: number;
}

export class SseOptionsBuilder extends BrokerOptionsBuilder<SseOptionsType> {
  /** Start a fresh builder.  Equivalent to `new SseOptionsBuilder()`. */
  static create(): SseOptionsBuilder {
    return new SseOptionsBuilder();
  }

  /** SSE endpoint URL. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Custom request headers. */
  withHeaders(headers: Readonly<Record<string, string>>): this {
    return this.set('headers', headers);
  }

  /** Subscriber for inbound events.  Required. */
  withTarget(target: ActorRef<SseEvent>): this {
    return this.set('target', target);
  }

  /** Declare the stream lost after `ms` without inbound bytes.  Default: disabled. */
  withIdleTimeoutMs(ms: number): this {
    return this.set('idleTimeoutMs', ms);
  }

  /** Abandon a connect attempt that has not produced headers after `ms`.  Default: disabled. */
  withConnectTimeoutMs(ms: number): this {
    return this.set('connectTimeoutMs', ms);
  }
}

/** Validates resolved {@link SseOptionsType} settings. */
export class SseOptionsValidator extends BrokerOptionsValidator<SseOptionsType> {
  constructor() {
    super('SseOptions');
  }
  protected rules(s: Partial<SseOptionsType>): void {
    this.commonRules(s);
    this.url('url', ['http', 'https']);
    // `0` is the documented "off" for both, so non-negative rather than positive.
    this.nonNegativeInt('idleTimeoutMs');
    this.nonNegativeInt('connectTimeoutMs');
  }
}

/**
 * Accepted input for any SSE-configurable constructor: the fluent
 * {@link SseOptionsBuilder} OR a plain {@link SseOptionsType} object.
 */
export type SseOptions = SseOptionsBuilder | Partial<SseOptionsType>;
/** Value alias so `SseOptions.create()` / `new SseOptions()` resolve to the builder. */
export const SseOptions = SseOptionsBuilder;
