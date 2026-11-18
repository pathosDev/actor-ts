/**
 * Fluent builder for {@link GrpcClientOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.grpc.client` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import type { GrpcCredentials } from './GrpcClientActor.js';

/**
 * grpc-js **channel options** — the `grpc.*` arguments both the server
 * and the client constructor take, passed straight through.
 *
 * Declared once and shared by {@link GrpcClientOptionsType} and
 * `GrpcServerOptionsType`, because it is one vocabulary: grpc-js reads
 * the same `grpc.max_receive_message_length` on both ends.  Co-locating
 * it would mean declaring it twice.
 *
 * A **code-only** surface, deliberately — there is no HOCON leaf, the
 * same call the broker TLS material got (#743).  The keys are grpc-js's,
 * not this framework's: they change with the peer's releases, they are
 * not validated here, and a typo in a HOCON file would be silently
 * ignored by grpc-js rather than rejected by anything of ours.
 *
 * `string | number` is the whole value domain: gRPC channel arguments
 * are integers or strings on the wire, and a boolean knob is spelled
 * `0` / `1` (`grpc.keepalive_permit_without_calls: 1`).
 *
 * The four an operator exposing a public bind should reach for first:
 *
 *   - `grpc.max_connection_idle_ms` — reap a connection nobody is using.
 *   - `grpc.max_connection_age_ms` — retire a connection on a schedule,
 *     so a long-lived one cannot outlive its authorization.
 *   - `grpc.max_concurrent_streams` — cap the calls one connection may
 *     have in flight.
 *   - `grpc.keepalive_permit_without_calls` — keep probing an idle
 *     connection, so a silently dead peer is noticed.
 */
export type GrpcChannelOptions = Readonly<Record<string, string | number>>;

/**
 * Built-in default of {@link GrpcClientOptionsType.streamIdleTimeoutMs}: five
 * minutes.
 *
 * Long enough for a normal quiet stream.  A server stream that pushes on
 * change rather than on a clock can sit idle for minutes, and the services
 * that stay quiet longer than that usually send a heartbeat well inside it —
 * thirty to sixty seconds is the common cadence.  It is also the figure the
 * gRPC page suggests for `grpc.max_connection_idle_ms` on the server, so a
 * stream outlives no connection that same advice would already have retired.
 * Short enough to matter: a stream whose peer hung is reaped in minutes, not
 * held for the life of the actor (#1222).
 */
export const DEFAULT_GRPC_STREAM_IDLE_TIMEOUT_MS = 300_000;

export interface GrpcClientOptionsType extends BrokerCommonOptionsType {
  /** Path to the `.proto` file (or array of paths). */
  readonly protoPath?: string | ReadonlyArray<string>;
  /** gRPC package name (`'sensor.v1'`). */
  readonly packageName?: string;
  /** Service name (`'SensorService'`). */
  readonly serviceName?: string;
  /** Server endpoint (`'host:port'`). */
  readonly endpoint?: string;
  /**
   * Channel credentials — insecure, or TLS carrying the certificate
   * **material** itself.
   *
   * No HOCON leaf, and no `use-tls` boolean either: the secure arm is
   * `Uint8Array` material, and a config file is the wrong place for a private
   * key.  That is the whole-project ruling recorded in `BrokerTls.ts`, which
   * every broker's `tls` field repeats.
   */
  readonly credentials?: GrpcCredentials;
  /**
   * Deadline for a **unary** call, in ms.  Default 30_000.
   *
   * Not applied to the three streaming call classes: a gRPC deadline
   * bounds the whole RPC, so one value cannot both fail a unary call
   * promptly and let a long-lived stream run.  Bounding a stream whose
   * peer has gone quiet is {@link GrpcClientOptionsType.streamIdleTimeoutMs}'s
   * job, and a peer that has died outright is the keepalive knobs' in
   * {@link GrpcClientOptionsType.channelOptions}.
   */
  readonly deadlineMs?: number;
  /**
   * Cancel a server-stream, client-stream or bidi call after this many ms in
   * which nothing crossed it.  Default
   * {@link DEFAULT_GRPC_STREAM_IDLE_TIMEOUT_MS} (five minutes); `0` turns it
   * off.  HOCON `stream-idle-timeout`.
   *
   * Not a deadline: it measures silence, not age, so a stream that keeps
   * talking lives as long as it likes.  Every frame in either direction
   * pushes it back — a chunk from the server, and a `clientStreamSend` /
   * `bidiSend` from the caller, because a client stream receives nothing
   * until its single reply and would otherwise be reaped while it was busy
   * writing.  A half-closed client stream stays armed until its reply.
   *
   * On expiry the call is cancelled, its registry entry dropped, and the
   * target receives one terminal frame naming the timeout — `stream-error`
   * for a server or bidi stream, `rpc-error` for a client stream.  Keepalive
   * in `channelOptions` covers a different failure: a peer that is gone,
   * where this covers a peer that is there and has stopped answering (#1222).
   */
  readonly streamIdleTimeoutMs?: number;
  /**
   * grpc-js channel options, handed to the service-client constructor
   * verbatim — see {@link GrpcChannelOptions}, which is also where the
   * reasoning for there being no HOCON leaf lives.
   */
  readonly channelOptions?: GrpcChannelOptions;
}

export class GrpcClientOptionsBuilder extends BrokerOptionsBuilder<GrpcClientOptionsType> {
  /** Start a fresh builder.  Equivalent to `new GrpcClientOptionsBuilder()`. */
  static create(): GrpcClientOptionsBuilder {
    return new GrpcClientOptionsBuilder();
  }

  /** Path to the `.proto` file (or array of paths). */
  withProtoPath(protoPath: string | ReadonlyArray<string>): this {
    return this.set('protoPath', protoPath);
  }

  /** gRPC package name (`'sensor.v1'`). */
  withPackageName(packageName: string): this {
    return this.set('packageName', packageName);
  }

  /** Service name (`'SensorService'`). */
  withServiceName(serviceName: string): this {
    return this.set('serviceName', serviceName);
  }

  /** Server endpoint (`'host:port'`). */
  withEndpoint(endpoint: string): this {
    return this.set('endpoint', endpoint);
  }

  /** TLS / mTLS credentials.  Default insecure. */
  withCredentials(credentials: GrpcCredentials): this {
    return this.set('credentials', credentials);
  }

  /** Deadline for a unary call, in ms.  Default 30000; streams are not bounded by it. */
  withDeadlineMs(ms: number): this {
    return this.set('deadlineMs', ms);
  }

  /** grpc-js channel options for the client channel — see {@link GrpcChannelOptions}. */
  withChannelOptions(channelOptions: GrpcChannelOptions): this {
    return this.set('channelOptions', channelOptions);
  }

  /**
   * Cancel a stream after this many ms of silence in both directions.
   * Default five minutes; `0` turns it off — see
   * {@link GrpcClientOptionsType.streamIdleTimeoutMs}.
   */
  withStreamIdleTimeoutMs(ms: number): this {
    return this.set('streamIdleTimeoutMs', ms);
  }
}

/** Validates resolved {@link GrpcClientOptionsType} settings. */
export class GrpcClientOptionsValidator extends BrokerOptionsValidator<GrpcClientOptionsType> {
  constructor() {
    super('GrpcClientOptions');
  }
  protected rules(_s: Partial<GrpcClientOptionsType>): void {
    this.commonRules(_s);
    this.positiveNumber('deadlineMs');
    this.nonNegativeNumber('streamIdleTimeoutMs');
  }
}

/**
 * Accepted input for any gRPC-client-configurable constructor: the fluent
 * {@link GrpcClientOptionsBuilder} OR a plain {@link GrpcClientOptionsType} object.
 */
export type GrpcClientOptions = GrpcClientOptionsBuilder | Partial<GrpcClientOptionsType>;
/** Value alias so `GrpcClientOptions.create()` / `new GrpcClientOptions()` resolve to the builder. */
export const GrpcClientOptions = GrpcClientOptionsBuilder;
