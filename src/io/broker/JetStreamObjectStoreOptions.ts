/**
 * Options for {@link JetStreamObjectStoreActor} — the JetStream Object
 * Store bucket sub-API (#74).  Protocol-specific methods only; the common
 * broker fields (`withReconnect` / `withCircuitBreaker` /
 * `withOutboundBuffer`) come from {@link BrokerOptionsBuilder}.
 *
 * The connection half mirrors {@link JetStreamOptionsType} field for field
 * — same NATS connection, same spelling — so only the bucket half and
 * `maxObjectBytes` are new here.
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';

/**
 * Whole-body ceiling for v1, in bytes.  See the class doc of
 * {@link JetStreamObjectStoreActor} for why an object is a single message
 * and not a chunk stream, and what the number is protecting.
 */
export const DEFAULT_MAX_OBJECT_BYTES = 1024 * 1024;

export interface JetStreamObjectStoreOptionsType extends BrokerCommonOptionsType {
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
  /** Human-readable bucket description.  Only applied on create. */
  readonly description?: string;
  /** Bucket storage backing.  Only applied when the actor creates the bucket. */
  readonly storage?: 'memory' | 'file';
  /** Replica count.  Only applied when the actor creates the bucket. */
  readonly replicas?: number;
  /**
   * Largest object body this actor will move, in bytes.  Default 1 MiB.
   *
   * It is a real limit, not a hint: a `put` above it is rejected before
   * the body reaches the bounded outbound buffer, and a `get` above it is
   * refused before the body is materialised.  Raise it only as far as
   * `outboundBuffer × maxObjectBytes` stays a resident-memory figure you
   * are willing to hold while disconnected.
   */
  readonly maxObjectBytes?: number;
  /**
   * Create the bucket at connect time when it does not exist.  Default
   * `true`.  `false` binds to an existing bucket and fails the connect if
   * it is missing.
   */
  readonly create?: boolean;
}

export class JetStreamObjectStoreOptionsBuilder extends BrokerOptionsBuilder<JetStreamObjectStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new JetStreamObjectStoreOptionsBuilder()`. */
  static create(): JetStreamObjectStoreOptionsBuilder {
    return new JetStreamObjectStoreOptionsBuilder();
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

  /** Human-readable bucket description (create-time). */
  withDescription(description: string): this {
    return this.set('description', description);
  }

  /** Bucket storage backing (create-time). */
  withStorage(storage: 'memory' | 'file'): this {
    return this.set('storage', storage);
  }

  /** Replica count (create-time). */
  withReplicas(replicas: number): this {
    return this.set('replicas', replicas);
  }

  /** Largest object body this actor will move, in bytes.  Default 1 MiB. */
  withMaxObjectBytes(maxObjectBytes: number): this {
    return this.set('maxObjectBytes', maxObjectBytes);
  }

  /** Create the bucket at connect time when missing.  Default `true`. */
  withCreate(create: boolean): this {
    return this.set('create', create);
  }
}

/** Validates resolved {@link JetStreamObjectStoreOptionsType} settings. */
export class JetStreamObjectStoreOptionsValidator extends BrokerOptionsValidator<JetStreamObjectStoreOptionsType> {
  constructor() {
    super('JetStreamObjectStoreOptions');
  }

  protected rules(s: Partial<JetStreamObjectStoreOptionsType>): void {
    this.commonRules(s);
    this.nonEmptyStringOrArray('servers', s.servers);
    this.nonEmptyString('bucket');
    this.oneOf('storage', ['memory', 'file']);
    this.positiveInt('replicas');
    this.positiveInt('maxObjectBytes');
  }
}

/**
 * Accepted input for any JetStream-Object-Store-configurable constructor:
 * the fluent {@link JetStreamObjectStoreOptionsBuilder} OR a plain
 * {@link JetStreamObjectStoreOptionsType} object.
 */
export type JetStreamObjectStoreOptions =
  | JetStreamObjectStoreOptionsBuilder
  | Partial<JetStreamObjectStoreOptionsType>;
/** Value alias so `JetStreamObjectStoreOptions.create()` resolves to the builder. */
export const JetStreamObjectStoreOptions = JetStreamObjectStoreOptionsBuilder;
