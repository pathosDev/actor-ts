/**
 * Fluent builder for {@link NatsActorSettings}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptions}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.nats` > built-in defaults).
 */
import { BrokerOptions } from './BrokerOptions.js';
import type { NatsActorSettings } from './NatsActor.js';

export class NatsOptions extends BrokerOptions<NatsActorSettings> {
  /** Start a fresh builder.  Equivalent to `new NatsOptions()`. */
  static create(): NatsOptions {
    return new NatsOptions();
  }

  /** NATS server URLs (`'nats://localhost:4222'` or array). */
  withServers(servers: ReadonlyArray<string> | string): this {
    return this.set('servers', servers);
  }

  /** Token credential. */
  withToken(token: string): this {
    return this.set('token', token);
  }

  /** Username credential. */
  withUser(user: string): this {
    return this.set('user', user);
  }

  /** Password credential. */
  withPassword(password: string): this {
    return this.set('password', password);
  }

  /** Subscriptions wired up at connect time. */
  withSubscriptions(subscriptions: NonNullable<NatsActorSettings['subscriptions']>): this {
    return this.set('subscriptions', subscriptions);
  }

  /** Client name reported to the server. */
  withName(name: string): this {
    return this.set('name', name);
  }
}
