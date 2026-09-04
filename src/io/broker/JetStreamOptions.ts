/**
 * Fluent builder for {@link JetStreamOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.jetstream` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import { findBrokerTlsProblem } from './BrokerTls.js';
import type { TlsTransportOptionsType } from '../../runtime/tcp/TcpBackend.js';
import type { ActorRef } from '../../ActorRef.js';
import type {
  JetStreamConsumerConfig,
  JetStreamMessage,
  JetStreamStreamConfig,
} from './JetStreamActor.js';

export interface JetStreamOptionsType extends BrokerCommonOptionsType {
  /** NATS server URLs. */
  readonly servers?: ReadonlyArray<string> | string;
  /** Optional credentials. */
  readonly token?: string;
  readonly user?: string;
  readonly password?: string;
  /** Optional client name. */
  readonly name?: string;
  /**
   * TLS material forwarded to nats.js as its `tls` option — a private CA to
   * trust, or a client certificate for mTLS.  Carries the material itself,
   * never a path to it.
   *
   * Setting it also asks nats.js to negotiate TLS, so it works with a plain
   * `nats://` server URL.  Deliberately has no HOCON leaf — a config file is
   * the wrong place for a private key.
   */
  readonly tls?: TlsTransportOptionsType;
  /**
   * Stream lifecycle config — set when this actor owns the stream.
   *
   * Readable from HOCON as `stream { … }`, whose leaves are the kebab-case of
   * these fields (`max-messages`, `max-bytes`, `max-age`).  The block is read
   * whole, not merged leaf-wise onto a code-side `withStream(…)`: an explicit
   * value replaces it entirely, which is the ordinary options precedence
   * applied at the field this object *is*.
   */
  readonly stream?: JetStreamStreamConfig;
  /**
   * Consumer config — required to start a subscription.  Readable from HOCON
   * as `consumer { … }` on the same terms as {@link stream}, including the
   * two `deliver-policy` object arms.
   */
  readonly consumer?: JetStreamConsumerConfig;
  /**
   * Actor receiving every consumed message.  No HOCON leaf: an `ActorRef`
   * names a live actor in this process, which a config file cannot denote.
   */
  readonly target?: ActorRef<JetStreamMessage>;
  /**
   * Max time the manual-ack pump waits for a `ack`/`nak`/`term`
   * before giving up on a message and rejecting internally
   * (kafkajs-style failure).  Default = `consumer.ackWaitMs ?? 30s`.
   */
  readonly acknowledgmentTimeout?: number;
}

export class JetStreamOptionsBuilder extends BrokerOptionsBuilder<JetStreamOptionsType> {
  /** Start a fresh builder.  Equivalent to `new JetStreamOptionsBuilder()`. */
  static create(): JetStreamOptionsBuilder {
    return new JetStreamOptionsBuilder();
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

  /** TLS material for the NATS dial.  Pass the material, not a file path. */
  withTls(tls: TlsTransportOptionsType): this {
    return this.set('tls', tls);
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
  withAcknowledgmentTimeout(ms: number): this {
    return this.set('acknowledgmentTimeout', ms);
  }
}

/**
 * A `stream` / `consumer` leaf that is present but outside its domain — the
 * shape `FramingViolation` in `TcpFraming.ts` has, kept module-local because
 * nothing outside this file reports one.
 */
type JetStreamGroupViolation = {
  readonly field: string;
  readonly reason: string;
  readonly value: unknown;
};

/**
 * The first `stream` / `consumer` leaf that is present but outside its domain.
 *
 * A free function for the reason `findFramingViolation` is one: both
 * groups' leaves sit a level below the top-level fields the check helpers are
 * typed against, so the helpers cannot address them. Spelling the rules out
 * once here covers the builder, a plain object and HOCON alike.
 *
 * The two required leaves are the point of it. {@link JetStreamStreamConfig}
 * types `name` and `subjects` as required and {@link JetStreamConsumerConfig}
 * types `durable` the same way, so from code the compiler is the guard — but
 * HOCON has no compiler, and the readers turn an absent required leaf into the
 * empty value precisely so this reports it by name. Without that, an unnamed
 * stream reaches `jsm.streams.add` and fails as a server-side error about a
 * request nobody wrote.
 */
function findJetStreamGroupProblem(
  s: Partial<JetStreamOptionsType>,
): JetStreamGroupViolation | undefined {
  const stream = s.stream;
  if (stream !== undefined) {
    if (typeof stream.name !== 'string' || stream.name.length === 0) {
      return { field: 'stream.name', reason: 'must not be empty', value: stream.name };
    }
    if (!Array.isArray(stream.subjects) || stream.subjects.length === 0) {
      return { field: 'stream.subjects', reason: 'must not be empty', value: stream.subjects };
    }
    if (stream.retention !== undefined
        && !['limits', 'interest', 'workqueue'].includes(stream.retention)) {
      return {
        field: 'stream.retention',
        reason: "must be 'limits', 'interest' or 'workqueue'",
        value: stream.retention,
      };
    }
    if (stream.storage !== undefined && !['memory', 'file'].includes(stream.storage)) {
      return { field: 'stream.storage', reason: "must be 'memory' or 'file'", value: stream.storage };
    }
  }

  const consumer = s.consumer;
  if (consumer !== undefined) {
    if (typeof consumer.durable !== 'string' || consumer.durable.length === 0) {
      return { field: 'consumer.durable', reason: 'must not be empty', value: consumer.durable };
    }
    if (consumer.mode !== undefined && !['push', 'pull'].includes(consumer.mode)) {
      return { field: 'consumer.mode', reason: "must be 'push' or 'pull'", value: consumer.mode };
    }
    if (consumer.ackPolicy !== undefined
        && !['explicit', 'none', 'all'].includes(consumer.ackPolicy)) {
      return {
        field: 'consumer.ackPolicy',
        reason: "must be 'explicit', 'none' or 'all'",
        value: consumer.ackPolicy,
      };
    }
    // Only the string arms are checked: the object arms carry a `kind` the
    // HOCON reader already refuses to build from an unknown spelling, and
    // from code they are the union's own members.
    const deliverPolicy = consumer.deliverPolicy;
    if (typeof deliverPolicy === 'string' && !['all', 'last', 'new'].includes(deliverPolicy)) {
      return {
        field: 'consumer.deliverPolicy',
        reason: "must be 'all', 'last' or 'new' (or the { kind } object form)",
        value: deliverPolicy,
      };
    }
  }
  return undefined;
}

/** Validates resolved {@link JetStreamOptionsType} settings. */
export class JetStreamOptionsValidator extends BrokerOptionsValidator<JetStreamOptionsType> {
  constructor() {
    super('JetStreamOptions');
  }
  protected rules(s: Partial<JetStreamOptionsType>): void {
    this.commonRules(s);
    this.nonEmptyStringOrArray('servers', s.servers);
    this.positiveNumber('acknowledgmentTimeout');
    this.nestedPositive('stream.maxMessages', s.stream?.maxMessages);
    this.nestedPositive('stream.maxBytes', s.stream?.maxBytes);
    this.nestedPositive('stream.maxAge', s.stream?.maxAge);
    this.nestedPositive('consumer.ackWaitMs', s.consumer?.ackWaitMs);
    this.nestedPositive('consumer.maxAcknowledgmentPending', s.consumer?.maxAcknowledgmentPending);
    const groupProblem = findJetStreamGroupProblem(s);
    if (groupProblem !== undefined) {
      this.fail(groupProblem.field, groupProblem.reason, groupProblem.value);
    }
    const tlsProblem = findBrokerTlsProblem(s.tls);
    if (tlsProblem !== null) this.fail('tls', tlsProblem);
  }
}

/**
 * Accepted input for any JetStream-configurable constructor: the fluent
 * {@link JetStreamOptionsBuilder} OR a plain {@link JetStreamOptionsType} object.
 */
export type JetStreamOptions = JetStreamOptionsBuilder | Partial<JetStreamOptionsType>;
/** Value alias so `JetStreamOptions.create()` / `new JetStreamOptions()` resolve to the builder. */
export const JetStreamOptions = JetStreamOptionsBuilder;
