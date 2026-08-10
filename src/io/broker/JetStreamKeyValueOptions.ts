/**
 * Options for {@link JetStreamKeyValueActor} — the JetStream Key-Value
 * bucket sub-API (#74).  Protocol-specific methods only; the common broker
 * fields (`withReconnect` / `withCircuitBreaker` / `withOutboundBuffer`)
 * come from {@link BrokerOptionsBuilder}.
 *
 * The connection half (`servers`, credentials, `name`) deliberately mirrors
 * {@link JetStreamOptionsType} field for field: a KV bucket is reached over
 * the same NATS connection, and an operator who moved the server list into
 * HOCON for the stream actor should not have to learn a second spelling for
 * the bucket actor.  The bucket half (`bucket`, `history`, `timeToLive`, …)
 * is what the two do not share.
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';

export interface JetStreamKeyValueOptionsType extends BrokerCommonOptionsType {
  /** NATS server URLs. */
  readonly servers?: ReadonlyArray<string> | string;
  /** Optional credentials. */
  readonly token?: string;
  readonly user?: string;
  readonly password?: string;
  /** Optional client name. */
  readonly name?: string;
  /** Bucket this actor operates on — required. */
  readonly bucket?: string;
  /**
   * Revisions kept per key.  `1` (the JetStream default) keeps only the
   * current value; a higher history is what makes compare-and-swap and
   * `watch` replay useful.  Only applied when the actor creates the bucket.
   */
  readonly history?: number;
  /**
   * Per-key time-to-live in **milliseconds**.  Unset = keep forever.  Only
   * applied when the actor creates the bucket.
   */
  readonly timeToLive?: number;
  /** Bucket storage backing.  Only applied when the actor creates the bucket. */
  readonly storage?: 'memory' | 'file';
  /** Replica count.  Only applied when the actor creates the bucket. */
  readonly replicas?: number;
  /** Server-side cap on a single value, in bytes.  Only applied on create. */
  readonly maxValueBytes?: number;
  /**
   * Create the bucket at connect time when it does not exist.  Default
   * `true`.  `false` binds to an existing bucket and fails the connect if
   * it is missing — the right setting when the bucket is provisioned by an
   * operator and a typo should not silently create an empty one.
   */
  readonly create?: boolean;
}

export class JetStreamKeyValueOptionsBuilder extends BrokerOptionsBuilder<JetStreamKeyValueOptionsType> {
  /** Start a fresh builder.  Equivalent to `new JetStreamKeyValueOptionsBuilder()`. */
  static create(): JetStreamKeyValueOptionsBuilder {
    return new JetStreamKeyValueOptionsBuilder();
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

  /** Bucket this actor operates on. */
  withBucket(bucket: string): this {
    return this.set('bucket', bucket);
  }

  /** Revisions kept per key (create-time). */
  withHistory(history: number): this {
    return this.set('history', history);
  }

  /** Per-key time-to-live in milliseconds (create-time). */
  withTimeToLive(timeToLive: number): this {
    return this.set('timeToLive', timeToLive);
  }

  /** Bucket storage backing (create-time). */
  withStorage(storage: 'memory' | 'file'): this {
    return this.set('storage', storage);
  }

  /** Replica count (create-time). */
  withReplicas(replicas: number): this {
    return this.set('replicas', replicas);
  }

  /** Server-side cap on a single value, in bytes (create-time). */
  withMaxValueBytes(maxValueBytes: number): this {
    return this.set('maxValueBytes', maxValueBytes);
  }

  /** Create the bucket at connect time when missing.  Default `true`. */
  withCreate(create: boolean): this {
    return this.set('create', create);
  }
}

/** Validates resolved {@link JetStreamKeyValueOptionsType} settings. */
export class JetStreamKeyValueOptionsValidator extends BrokerOptionsValidator<JetStreamKeyValueOptionsType> {
  constructor() {
    super('JetStreamKeyValueOptions');
  }

  protected rules(s: Partial<JetStreamKeyValueOptionsType>): void {
    this.commonRules(s);
    this.nonEmptyStringOrArray('servers', s.servers);
    this.nonEmptyString('bucket');
    this.positiveInt('history');
    this.positiveNumber('timeToLive');
    this.oneOf('storage', ['memory', 'file']);
    this.positiveInt('replicas');
    this.positiveInt('maxValueBytes');
  }
}

/**
 * Accepted input for any JetStream-KV-configurable constructor: the fluent
 * {@link JetStreamKeyValueOptionsBuilder} OR a plain
 * {@link JetStreamKeyValueOptionsType} object.
 */
export type JetStreamKeyValueOptions =
  | JetStreamKeyValueOptionsBuilder
  | Partial<JetStreamKeyValueOptionsType>;
/** Value alias so `JetStreamKeyValueOptions.create()` resolves to the builder. */
export const JetStreamKeyValueOptions = JetStreamKeyValueOptionsBuilder;
