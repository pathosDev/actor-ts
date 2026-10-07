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
 * NATS's spelling of "no limit" on a count- or byte-valued cap — `max_msgs`,
 * `max_bytes`, `max_ack_pending`.
 *
 * A bound the {@link JetStreamOptionsValidator} admits rather than a default:
 * these fields are unset by default and pass through verbatim, so the value
 * exists here only because the validator has to recognise it. Named for the
 * vendor, because "unlimited" is a protocol constant and not a house one.
 */
const NATS_UNLIMITED_COUNT = -1;

/**
 * NATS's spelling of "no limit" on `max_age`.
 *
 * Not {@link NATS_UNLIMITED_COUNT}: the field is a **nanosecond span**, where
 * the absent bound is zero and a negative value has no meaning at all. The
 * asymmetry is the server's, and the two constants are kept apart so a reader
 * cannot assume it away.
 */
const NATS_UNLIMITED_AGE_NANOSECONDS = 0;

/** The `kind` of a parameterised `deliverPolicy` arm. */
type DeliverPolicyObjectKind = Exclude<JetStreamConsumerConfig['deliverPolicy'], string | undefined>['kind'];

/**
 * The `kind` of every parameterised `deliverPolicy` arm, keyed by the union so
 * the compiler holds the two together: a kind the union gains without an entry
 * here is a missing property, and an entry the union lacks is an excess one.
 * The validator accepts these kinds and no other, because the translation into
 * nats.js has no answer for any other kind but a refusal.
 */
const DELIVER_POLICY_OBJECT_KINDS: Readonly<Record<DeliverPolicyObjectKind, true>> = {
  'by-start-sequence': true,
  'by-start-time': true,
};

/**
 * The object arms' `kind` values before every value a HOCON key takes became
 * kebab-case (#1443), each mapped to the kind that replaced it.  A `Map`, so
 * a kind spelled like an `Object.prototype` member is never mistaken for an
 * entry and still reaches the unknown-kind error; typed by the union, so a
 * replacement that is not a kind does not compile.
 *
 * Shared by both doors a policy comes in through, so the two name the same
 * replacement: the HOCON reader in `JetStreamActor.ts` refuses a retired value
 * with a `ConfigError`, and {@link JetStreamOptionsValidator} refuses one built
 * in code with an `OptionsError`.  It lives here rather than beside the reader
 * because this file never imports the actor.
 */
export const RETIRED_DELIVER_POLICY_KINDS: ReadonlyMap<string, DeliverPolicyObjectKind> = new Map([
  ['byStartSeq', 'by-start-sequence'],
  ['byStartTime', 'by-start-time'],
]);

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
    const deliverPolicyProblem = findDeliverPolicyProblem(consumer.deliverPolicy);
    if (deliverPolicyProblem !== undefined) return deliverPolicyProblem;
  }
  return undefined;
}

/**
 * The problem with `consumer.deliverPolicy`, or `undefined` when it is unset
 * or one of the union's arms.
 *
 * Checked whole, the object arms as strictly as the strings: the compiler
 * vouches for a `kind` only at a typed call site, and a cast or a
 * plain-JavaScript caller hands over anything at all.  A retired kind names
 * its replacement, as the HOCON reader's refusal does; any other names the
 * kinds there are.  `Object.hasOwn` rather than `in`, so `constructor` is the
 * unknown kind it looks like rather than an inherited member.
 */
function findDeliverPolicyProblem(deliverPolicy: unknown): JetStreamGroupViolation | undefined {
  if (deliverPolicy === undefined) return undefined;
  if (typeof deliverPolicy === 'string') {
    if (['all', 'last', 'new'].includes(deliverPolicy)) return undefined;
    return {
      field: 'consumer.deliverPolicy',
      reason: "must be 'all', 'last' or 'new' (or the { kind } object form)",
      value: deliverPolicy,
    };
  }
  if (typeof deliverPolicy !== 'object' || deliverPolicy === null || Array.isArray(deliverPolicy)) {
    return {
      field: 'consumer.deliverPolicy',
      reason: "must be 'all', 'last', 'new' or a { kind } object",
      value: deliverPolicy,
    };
  }
  const kind: unknown = (deliverPolicy as { readonly kind?: unknown }).kind;
  if (typeof kind === 'string' && Object.hasOwn(DELIVER_POLICY_OBJECT_KINDS, kind)) return undefined;
  const replacement = typeof kind === 'string' ? RETIRED_DELIVER_POLICY_KINDS.get(kind) : undefined;
  if (replacement !== undefined) {
    return {
      field: 'consumer.deliverPolicy.kind',
      reason: `has been renamed to '${replacement}'`,
      value: kind,
    };
  }
  const accepted = Object.keys(DELIVER_POLICY_OBJECT_KINDS).map((name) => `'${name}'`).join(' or ');
  return { field: 'consumer.deliverPolicy.kind', reason: `must be ${accepted}`, value: kind };
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
    // The four caps below reach `jsm.streams.add` / `jsm.consumers.add`
    // verbatim, so their domain is NATS's and not ours: the server spells "no
    // limit" as `-1` on `max_msgs`, `max_bytes` and `max_ack_pending`, and as
    // `0` on `max_age` — which is a nanosecond span, where a negative value
    // would mean nothing.  Asymmetric on purpose; see NATS's stream and
    // consumer configuration reference.
    this.nestedPositiveOrSentinel('stream.maxMessages', s.stream?.maxMessages, NATS_UNLIMITED_COUNT);
    this.nestedPositiveOrSentinel('stream.maxBytes', s.stream?.maxBytes, NATS_UNLIMITED_COUNT);
    this.nestedPositiveOrSentinel('stream.maxAge', s.stream?.maxAge, NATS_UNLIMITED_AGE_NANOSECONDS);
    // `ackWaitMs` keeps the plain positive bound, and that is not an
    // oversight: NATS reads a zero `ack_wait` as "use the server default",
    // which is what leaving this unset already says (the actor substitutes
    // 30 s), and there is no unlimited spelling for it at all.
    this.nestedPositive('consumer.ackWaitMs', s.consumer?.ackWaitMs);
    this.nestedPositiveOrSentinel(
      'consumer.maxAcknowledgmentPending', s.consumer?.maxAcknowledgmentPending, NATS_UNLIMITED_COUNT,
    );
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
