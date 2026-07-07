/**
 * Fluent builder for {@link JetStreamActorSettings}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptions}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.jetstream` > built-in defaults).
 */
import { BrokerOptions } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import type {
  JetStreamActorSettings,
  JetStreamConsumerConfig,
  JetStreamMessage,
  JetStreamStreamConfig,
} from './JetStreamActor.js';

export class JetStreamOptions extends BrokerOptions<JetStreamActorSettings> {
  /** Start a fresh builder.  Equivalent to `new JetStreamOptions()`. */
  static create(): JetStreamOptions {
    return new JetStreamOptions();
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

  /** Client name reported to the server. */
  withName(name: string): this {
    return this.set('name', name);
  }

  /** Stream lifecycle config — set when this actor owns the stream. */
  withStream(stream: JetStreamStreamConfig): this {
    return this.set('stream', stream);
  }

  /** Consumer config — required to start a subscription. */
  withConsumer(consumer: JetStreamConsumerConfig): this {
    return this.set('consumer', consumer);
  }

  /** Actor receiving every consumed message. */
  withTarget(target: ActorRef<JetStreamMessage>): this {
    return this.set('target', target);
  }

  /** Max time the manual-ack pump waits for ack/nak/term before giving up. */
  withAckTimeout(ms: number): this {
    return this.set('ackTimeout', ms);
  }
}
