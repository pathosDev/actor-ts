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

/**
 * Safety cap on the pending event buffer (chars).  A well-behaved server ends
 * an event with a blank line frequently — in any of the three framings the
 * grammar allows, `\n\n`, `\r\n\r\n` or `\r\r`, all of which reach the
 * delimiter search as `\n\n` (#1510) — and this bounds the damage from one
 * that never does (security audit BRK-2).  1 MiB is far above any real single
 * SSE event.
 *
 * Measured against the characters as they *arrive*, while what the buffer
 * keeps is the normalised form, which is never longer.  So normalising cannot
 * loosen the cap: a CRLF-framed feed reaches it no later than the same bytes
 * framed with LF would.
 */
export const DEFAULT_SSE_MAX_BUFFER_CHARS = 1_048_576;

export interface SseOptionsType extends BrokerCommonOptionsType {
  /** SSE endpoint URL. */
  readonly url?: string;
  /** Custom request headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Subscriber for inbound events.  Required.  No HOCON leaf: an `ActorRef`
   * names a live actor in this process, which a config file cannot denote.
   */
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
  /**
   * Declare the stream lost once an event grows past this many characters
   * without a delimiter (#371).  Default {@link DEFAULT_SSE_MAX_BUFFER_CHARS}
   * (1 MiB worth).  Raise it for a feed whose single events are legitimately
   * larger; lower it to bound what one misbehaving endpoint can make this
   * actor hold.
   *
   * The unit is UTF-16 code units, the length of the decoded text — not
   * bytes, which is why the name says chars: a byte-named cap compared
   * against code units is the defect #752 fixed in the TCP actor.
   */
  readonly maxBufferChars?: number;
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

  /** Declare the stream lost once an event passes `chars` without a delimiter.  Default: 1 048 576. */
  withMaxBufferChars(chars: number): this {
    return this.set('maxBufferChars', chars);
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
    // No "off" here: a cap of 0 would refuse the first byte.
    this.positiveInt('maxBufferChars');
  }
}

/**
 * Accepted input for any SSE-configurable constructor: the fluent
 * {@link SseOptionsBuilder} OR a plain {@link SseOptionsType} object.
 */
export type SseOptions = SseOptionsBuilder | Partial<SseOptionsType>;
/** Value alias so `SseOptions.create()` / `new SseOptions()` resolve to the builder. */
export const SseOptions = SseOptionsBuilder;
