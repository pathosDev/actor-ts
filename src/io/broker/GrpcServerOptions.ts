/**
 * Fluent builder for {@link GrpcServerOptionsType}.  `build()` snapshots the
 * accumulated partial and feeds the merge (constructor > HOCON under
 * `actor-ts.io.broker.grpc.server` > built-in defaults).
 *
 * The server's own fields only, on the plain {@link OptionsBuilder}: the server
 * is *bound*, not connected, and `GrpcServerActor` is a plain actor rather than
 * a `BrokerActor`, so it has no reconnect cycle, no circuit breaker around a
 * connect and no outbound buffer.  The builder used to extend the broker one
 * all the same, which put `withReconnect`, `withCircuitBreaker` and
 * `withOutboundBuffer` on it — setters that compiled, chained and were read by
 * nothing.  A setter that changes nothing is a setting an operator believes in,
 * so they went when the breaker became an id (#1478).
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { HealthCheckRegistry } from '../../management/HealthCheck.js';
import type { GrpcChannelOptions } from './GrpcClientOptions.js';
import type { GrpcHandler } from './GrpcServerActor.js';

/**
 * Built-in default of {@link GrpcServerOptionsType.maxPendingRequestMessages}.
 *
 * The hold it bounds spans one gap: between grpc-js handing the call over and
 * the handler actor's first turn, where it calls `onData`.  A handler that
 * subscribes promptly holds a handful of frames there at most, so 1024 leaves
 * three orders of magnitude for a busy mailbox while still refusing a client
 * that streams into a handler that never subscribes.  Frames, not bytes: a
 * chunk reaches this point already decoded, and the size of each one is
 * bounded separately, by `grpc.max_receive_message_length`.
 */
export const DEFAULT_MAX_PENDING_REQUEST_MESSAGES = 1024;

export type GrpcServerOptionsType = {
  readonly protoPath?: string | ReadonlyArray<string>;
  readonly packageName?: string;
  readonly serviceName?: string;
  /** Bind address (`'0.0.0.0:50051'`). */
  readonly bind?: string;
  /**
   * Method-name → handler mapping.  Methods absent from this map are
   * unimplemented (UNIMPLEMENTED status).
   *
   * No HOCON leaf: each value is a function, and a function cannot come from
   * a config file.
   */
  readonly handlers?: Readonly<Record<string, GrpcHandler>>;
  /**
   * TLS — when omitted, the server binds insecurely.  For mTLS supply
   * cert + key + (optionally) `rootCerts` for client auth.
   *
   * No HOCON leaf, and no boolean toggle: the secure arm carries `Uint8Array`
   * material, and a config file is the wrong place for a private key — the
   * ruling `BrokerTls.ts` records and every broker's `tls` field repeats.
   */
  readonly credentials?:
    | { readonly kind: 'insecure' }
    | { readonly kind: 'tls'; readonly cert: Uint8Array; readonly key: Uint8Array; readonly rootCerts?: Uint8Array };
  /**
   * Serve the standard `grpc.health.v1.Health` service next to the user's
   * service, answering `Check` from this registry's **readiness** checks.
   *
   * There is deliberately no boolean toggle and no HOCON leaf: the status
   * has to come from somewhere, and a health service that answers
   * `SERVING` unconditionally is worse than none at all — a Kubernetes
   * probe would keep the pod in rotation straight through an outage.
   * Supplying a registry IS the opt-in.
   *
   * Pass `healthChecksOf(system)` — the same instance the management
   * server's `/ready` endpoint aggregates — unless you mean otherwise:
   * that is what makes the framework carry one notion of "ready" rather
   * than two that can disagree.  A bare `new HealthCheckRegistry()` here
   * is accepted and forks them, and only one of the two is then the answer
   * a load balancer acts on.
   */
  readonly health?: HealthCheckRegistry;
  /**
   * grpc-js channel options, handed to the `grpc.Server` constructor
   * verbatim — see {@link GrpcChannelOptions}, which is also where the
   * reasoning for there being no HOCON leaf lives.
   *
   * This is the *server's* half, and it is the one that matters on a
   * public bind: without it nothing reaps an idle or abusive connection,
   * because the framework's own knobs stop at the RPC (`deadlineMs`) and
   * a connection outlives every RPC on it.
   */
  readonly channelOptions?: GrpcChannelOptions;
  /**
   * Request-stream frames held for a client-stream or bidi call whose handler
   * has not called `onData` yet.  Default
   * {@link DEFAULT_MAX_PENDING_REQUEST_MESSAGES}; HOCON
   * `max-pending-request-messages`.
   *
   * The hold exists because the handler subscribes a turn after the call
   * arrives, but the peer decides how long the call stays open and how fast
   * it streams.  One frame past the cap ends the call with
   * `RESOURCE_EXHAUSTED` (8) and drops what was held (#1039).  It bounds the
   * hold only: once a handler subscribes, frames go straight to it.
   */
  readonly maxPendingRequestMessages?: number;
};

export class GrpcServerOptionsBuilder extends OptionsBuilder<GrpcServerOptionsType> {
  /** Start a fresh builder.  Equivalent to `new GrpcServerOptionsBuilder()`. */
  static create(): GrpcServerOptionsBuilder {
    return new GrpcServerOptionsBuilder();
  }

  /** Path to the `.proto` file (or array of paths). */
  withProtoPath(protoPath: string | ReadonlyArray<string>): this {
    return this.set('protoPath', protoPath);
  }

  /** gRPC package name. */
  withPackageName(packageName: string): this {
    return this.set('packageName', packageName);
  }

  /** Service name. */
  withServiceName(serviceName: string): this {
    return this.set('serviceName', serviceName);
  }

  /** Bind address (`'0.0.0.0:50051'`). */
  withBind(bind: string): this {
    return this.set('bind', bind);
  }

  /** Method-name → handler mapping.  Absent methods are UNIMPLEMENTED. */
  withHandlers(handlers: Readonly<Record<string, GrpcHandler>>): this {
    return this.set('handlers', handlers);
  }

  /** TLS credentials.  When omitted the server binds insecurely. */
  withCredentials(credentials: NonNullable<GrpcServerOptionsType['credentials']>): this {
    return this.set('credentials', credentials);
  }

  /**
   * Serve `grpc.health.v1.Health`, answering `Check` from `health`'s
   * readiness checks.  Omit the call to leave the health service off —
   * see {@link GrpcServerOptionsType.health} for why enabling it requires
   * naming a status source.
   */
  withHealth(health: HealthCheckRegistry): this {
    return this.set('health', health);
  }

  /** grpc-js channel options for the bound server — see {@link GrpcChannelOptions}. */
  withChannelOptions(channelOptions: GrpcChannelOptions): this {
    return this.set('channelOptions', channelOptions);
  }

  /**
   * Request-stream frames held before a handler subscribes — see
   * {@link GrpcServerOptionsType.maxPendingRequestMessages}.
   */
  withMaxPendingRequestMessages(maxPendingRequestMessages: number): this {
    return this.set('maxPendingRequestMessages', maxPendingRequestMessages);
  }
}

/** Validates resolved {@link GrpcServerOptionsType} settings. */
export class GrpcServerOptionsValidator extends OptionsValidator<GrpcServerOptionsType> {
  constructor() {
    super('GrpcServerOptions');
  }
  protected rules(_s: Partial<GrpcServerOptionsType>): void {
    this.positiveInt('maxPendingRequestMessages');
  }
}

/**
 * Accepted input for any gRPC-server-configurable constructor: the fluent
 * {@link GrpcServerOptionsBuilder} OR a plain {@link GrpcServerOptionsType} object.
 */
export type GrpcServerOptions = GrpcServerOptionsBuilder | Partial<GrpcServerOptionsType>;
/** Value alias so `GrpcServerOptions.create()` / `new GrpcServerOptions()` resolve to the builder. */
export const GrpcServerOptions = GrpcServerOptionsBuilder;
