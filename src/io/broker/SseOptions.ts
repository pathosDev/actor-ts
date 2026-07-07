/**
 * Fluent builder for {@link SseOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.sse` > built-in defaults).
 */
import { BrokerOptionsBuilder } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerSettings.js';
import type { ActorRef } from '../../ActorRef.js';
import type { SseEvent } from './SseActor.js';

export interface SseOptionsType extends BrokerCommonOptionsType {
  /** SSE endpoint URL. */
  readonly url?: string;
  /** Custom request headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Subscriber for inbound events.  Required. */
  readonly target?: ActorRef<SseEvent>;
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
}

/**
 * Accepted input for any SSE-configurable constructor: the fluent
 * {@link SseOptionsBuilder} OR a plain {@link SseOptionsType} object.
 */
export type SseOptions = SseOptionsBuilder | Partial<SseOptionsType>;
/** Value alias so `SseOptions.create()` / `new SseOptions()` resolve to the builder. */
export const SseOptions = SseOptionsBuilder;
