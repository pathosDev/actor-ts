/**
 * Fluent builder for {@link NatsOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.nats` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import type { NatsMessage } from './NatsActor.js';

export interface NatsOptionsType extends BrokerCommonOptionsType {
  /** NATS server URLs (`'nats://localhost:4222'`). */
  readonly servers?: ReadonlyArray<string> | string;
  /** Optional credentials (token / user-password). */
  readonly token?: string;
  readonly user?: string;
  readonly password?: string;
  /** Subscriptions wired up at connect time.  Subjects support `*` and `>` wildcards (NATS-side). */
  readonly subscriptions?: ReadonlyArray<{ readonly subject: string; readonly target: ActorRef<NatsMessage> }>;
  /** Optional client name reported to the server. */
  readonly name?: string;
}

export class NatsOptionsBuilder extends BrokerOptionsBuilder<NatsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new NatsOptionsBuilder()`. */
  static create(): NatsOptionsBuilder {
    return new NatsOptionsBuilder();
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
  withSubscriptions(subscriptions: NonNullable<NatsOptionsType['subscriptions']>): this {
    return this.set('subscriptions', subscriptions);
  }

  /** Client name reported to the server. */
  withName(name: string): this {
    return this.set('name', name);
  }
}

/** Validates resolved {@link NatsOptionsType} settings. */
export class NatsOptionsValidator extends BrokerOptionsValidator<NatsOptionsType> {
  constructor() {
    super('NatsOptions');
  }
  protected rules(s: Partial<NatsOptionsType>): void {
    this.commonRules(s);
    this.nonEmptyStringOrArray('servers', s.servers);
  }
}

/**
 * Accepted input for any NATS-configurable constructor: the fluent
 * {@link NatsOptionsBuilder} OR a plain {@link NatsOptionsType} object.
 */
export type NatsOptions = NatsOptionsBuilder | Partial<NatsOptionsType>;
/** Value alias so `NatsOptions.create()` / `new NatsOptions()` resolve to the builder. */
export const NatsOptions = NatsOptionsBuilder;
