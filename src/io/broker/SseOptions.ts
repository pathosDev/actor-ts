/**
 * Fluent builder for {@link SseActorSettings}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptions}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.sse` > built-in defaults).
 */
import { BrokerOptions } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import type { SseActorSettings, SseEvent } from './SseActor.js';

export class SseOptions extends BrokerOptions<SseActorSettings> {
  /** Start a fresh builder.  Equivalent to `new SseOptions()`. */
  static create(): SseOptions {
    return new SseOptions();
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
